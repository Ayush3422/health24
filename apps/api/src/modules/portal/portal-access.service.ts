import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type {
  ActivatePortalAccessInput,
  GuardianRelation,
  LinkGuardianInput,
  PortalAccessSummary,
  PortalRelationship,
} from '@health24/shared';
import { requireHospital, type Actor, type RequestMeta } from '../../common/actor';
import type { DbTransaction } from '../../db/client';
import { DatabaseService } from '../../db/database.service';
import { AuditService } from '../audit/audit.service';
import { requireLinkedPatient, toIso, violatedConstraint } from '../clinical/clinical-access';
import { PortalSessionService } from './portal-session.service';

type AccessRow = {
  id: string;
  patient_id: string;
  account_id: string;
  phone: string;
  relationship: PortalRelationship;
  activated_at: string | Date;
  activated_by_staff_id: string;
  activated_by_name: string | null;
  activated_at_hospital_id: string;
  activated_at_hospital_name: string | null;
  ends_at: string | Date | null;
  guardian_name: string | null;
  guardian_relation: GuardianRelation | null;
  guardian_document: string | null;
  revoked_at: string | Date | null;
  revoked_reason: string | null;
};

/** Midnight in India on a patient's 18th birthday — the same date the database checks. */
const EIGHTEENTH_BIRTHDAY = sql`((p."date_of_birth" + interval '18 years')::date::timestamp) AT TIME ZONE 'Asia/Kolkata'`;

const ACCESS_SELECT = sql`
  SELECT p."id", p."patient_id", p."account_id", p."phone", p."relationship", p."activated_at",
         p."activated_by_staff_id", s."name" AS activated_by_name,
         p."activated_at_hospital_id", h."name" AS activated_at_hospital_name,
         p."ends_at", p."guardian_name", p."guardian_relation", p."guardian_document",
         p."revoked_at", p."revoked_reason"
    FROM "patient_portal_access" p
    LEFT JOIN "staff_user" s ON s."id" = p."activated_by_staff_id"
    LEFT JOIN "hospital_directory" h ON h."id" = p."activated_at_hospital_id"
`;

/**
 * Portal access, activated at a hospital desk (sp5-plan.md, Decision J1).
 *
 * An OTP proves someone holds a phone, not that they are the patient. So the
 * person who turns the portal on for a phone is staff who can see the patient,
 * and says so; any hospital the patient is linked to can turn it off, which
 * ends the portal's sessions for that patient at once.
 */
@Injectable()
export class PortalAccessService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly sessions: PortalSessionService,
  ) {}

  async activate(
    actor: Actor,
    patientId: string,
    input: ActivatePortalAccessInput,
    meta: RequestMeta,
  ): Promise<PortalAccessSummary> {
    const hospitalId = requireHospital(actor);

    const { row, created } = await this.db.asTenant(hospitalId, async (tx) => {
      await requireLinkedPatient(tx, hospitalId, patientId);

      const [account] = await tx.execute<{ id: string }>(
        sql`SELECT app.portal_account_for_phone(${input.phone}) AS id`,
      );

      const [existing] = await tx.execute<AccessRow>(sql`
        ${ACCESS_SELECT}
         WHERE p."account_id" = ${account!.id}::uuid AND p."patient_id" = ${patientId}::uuid
           AND p."revoked_at" IS NULL
      `);

      if (existing) return { row: existing, created: false };

      const id = uuidv7();

      try {
        await tx.execute(sql`
          INSERT INTO "patient_portal_access"
            ("id", "account_id", "patient_id", "phone", "relationship",
             "activated_at_hospital_id", "activated_by_staff_id")
          VALUES (${id}, ${account!.id}, ${patientId}, ${input.phone}, 'self',
                  ${hospitalId}, ${actor.staffUserId})
        `);
      } catch (error) {
        if (violatedConstraint(error) === 'patient_portal_access_active_once') {
          throw new ConflictException('Portal access was activated for this phone a moment ago');
        }
        throw error;
      }

      return { row: (await this.load(tx, id))!, created: true };
    });

    if (created) {
      await this.audit.recordForActor(actor, {
        resourceType: 'patient_portal_access',
        resourceId: row.id,
        patientId,
        action: 'create',
        meta,
      });
    }

    return this.toSummary(row, hospitalId);
  }

  /**
   * Links a child's record to a guardian's phone (Decision M1), after the desk
   * has checked the relationship and a document. The access ends at the
   * child's 18th birthday, worked out from the recorded date of birth.
   */
  async linkGuardian(
    actor: Actor,
    patientId: string,
    input: LinkGuardianInput,
    meta: RequestMeta,
  ): Promise<PortalAccessSummary> {
    const hospitalId = requireHospital(actor);

    const row = await this.db.asTenant(hospitalId, async (tx) => {
      await requireLinkedPatient(tx, hospitalId, patientId);

      const [child] = await tx.execute<{ has_birth_date: boolean; adult: boolean }>(sql`
        SELECT p."date_of_birth" IS NOT NULL AS has_birth_date,
               coalesce(${EIGHTEENTH_BIRTHDAY} <= now(), false) AS adult
          FROM "patient" p
         WHERE p."id" = ${patientId}::uuid
      `);

      if (!child?.has_birth_date) {
        throw new BadRequestException(
          'Record the child’s date of birth before linking a guardian: access ends on their 18th birthday',
        );
      }

      if (child.adult) {
        throw new BadRequestException(
          'This patient is 18 or older. Activate their own portal access instead.',
        );
      }

      const [account] = await tx.execute<{ id: string }>(
        sql`SELECT app.portal_account_for_phone(${input.phone}) AS id`,
      );

      const id = uuidv7();

      try {
        await tx.execute(sql`
          INSERT INTO "patient_portal_access"
            ("id", "account_id", "patient_id", "phone", "relationship", "activated_at_hospital_id",
             "activated_by_staff_id", "ends_at", "guardian_name", "guardian_relation", "guardian_document")
          SELECT ${id}::uuid, ${account!.id}::uuid, p."id", ${input.phone}, 'guardian'::portal_relationship,
                 ${hospitalId}::uuid, ${actor.staffUserId}::uuid, ${EIGHTEENTH_BIRTHDAY},
                 ${input.guardianName}, ${input.guardianRelation}, ${input.documentChecked}
            FROM "patient" p
           WHERE p."id" = ${patientId}::uuid
        `);
      } catch (error) {
        if (violatedConstraint(error) === 'patient_portal_access_active_once') {
          throw new ConflictException('This phone already has portal access to this patient');
        }
        throw error;
      }

      return (await this.load(tx, id))!;
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'patient_portal_access',
      resourceId: row.id,
      patientId,
      action: 'create',
      meta,
    });

    return this.toSummary(row, hospitalId);
  }

  async list(actor: Actor, patientId: string, meta: RequestMeta): Promise<PortalAccessSummary[]> {
    const hospitalId = requireHospital(actor);

    const rows = await this.db.asTenant(hospitalId, async (tx) => {
      await requireLinkedPatient(tx, hospitalId, patientId);

      const found = await tx.execute<AccessRow>(sql`
        ${ACCESS_SELECT}
         WHERE p."patient_id" = ANY (app.patient_record_ids(${patientId}::uuid))
      ORDER BY p."revoked_at" IS NOT NULL, p."activated_at" DESC
      `);
      return [...found];
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'patient_portal_access',
      patientId,
      action: 'search',
      meta,
    });

    return rows.map((row) => this.toSummary(row, hospitalId));
  }

  async revoke(
    actor: Actor,
    accessId: string,
    reason: string,
    meta: RequestMeta,
  ): Promise<PortalAccessSummary> {
    const hospitalId = requireHospital(actor);

    const row = await this.db.asTenant(hospitalId, async (tx) => {
      const current = await this.load(tx, accessId);
      if (!current) throw new NotFoundException('Portal access not found');
      if (current.revoked_at) throw new ConflictException('This portal access is already revoked');

      const updated = await tx.execute<{ id: string }>(sql`
        UPDATE "patient_portal_access"
           SET "revoked_at" = now(), "revoked_by_staff_id" = ${actor.staffUserId}::uuid,
               "revoked_reason" = ${reason}
         WHERE "id" = ${accessId}::uuid AND "revoked_at" IS NULL
     RETURNING "id"
      `);

      if ([...updated].length === 0) {
        throw new ConflictException('This portal access was revoked a moment ago');
      }

      return (await this.load(tx, accessId))!;
    });

    await this.sessions.revokeForAccess(row.account_id, row.patient_id, 'portal access revoked');

    await this.audit.recordForActor(actor, {
      resourceType: 'patient_portal_access',
      resourceId: accessId,
      patientId: row.patient_id,
      action: 'update',
      meta,
    });

    return this.toSummary(row, hospitalId);
  }

  private async load(tx: DbTransaction, accessId: string): Promise<AccessRow | null> {
    const [row] = await tx.execute<AccessRow>(sql`${ACCESS_SELECT} WHERE p."id" = ${accessId}::uuid`);
    return row ?? null;
  }

  private toSummary(row: AccessRow, hospitalId: string): PortalAccessSummary {
    const endsAt = row.ends_at ? toIso(row.ends_at) : null;

    return {
      id: row.id,
      patientId: row.patient_id,
      phone: row.phone,
      relationship: row.relationship,
      status: row.revoked_at
        ? 'revoked'
        : endsAt && Date.parse(endsAt) <= Date.now()
          ? 'ended'
          : 'active',
      activatedAt: toIso(row.activated_at),
      activatedBy: { id: row.activated_by_staff_id, name: row.activated_by_name },
      activatedAtHospital: {
        id: row.activated_at_hospital_id,
        name: row.activated_at_hospital_name ?? 'Unknown hospital',
        isOwn: row.activated_at_hospital_id === hospitalId,
      },
      endsAt,
      revokedAt: row.revoked_at ? toIso(row.revoked_at) : null,
      revokedReason: row.revoked_reason,
      guardian:
        row.relationship === 'guardian' &&
        row.guardian_name &&
        row.guardian_relation &&
        row.guardian_document
          ? {
              name: row.guardian_name,
              relation: row.guardian_relation,
              documentChecked: row.guardian_document,
            }
          : null,
    };
  }
}
