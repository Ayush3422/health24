import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import {
  CLINICAL_DATA_CATEGORIES,
  type BreakGlassInput,
  type BreakGlassReviewItem,
  type ConsentSummary,
  type RecordConsentInput,
  type ReviewBreakGlassInput,
} from '@health24/shared';
import { DatabaseService } from '../../db/database.service';
import type { DbTransaction } from '../../db/client';
import { consentArtefacts } from '../../db/schema';
import { requireHospital, type Actor, type RequestMeta } from '../../common/actor';
import { AuditService } from '../audit/audit.service';
import { requireLinkedPatient, toIso } from './clinical-access';

type ConsentRow = {
  id: string;
  patient_id: string;
  data_categories: ConsentSummary['dataCategories'];
  date_range_from: string | null;
  date_range_to: string | null;
  granted_at: string | Date;
  expires_at: string | Date;
  effective_status: ConsentSummary['status'];
  capture_method: ConsentSummary['captureMethod'];
  witness_name: string | null;
  emergency_reason: string | null;
  recorded_by_staff_id: string;
  recorded_by_name: string | null;
  revoked_at: string | Date | null;
  revoked_by_staff_id: string | null;
  revoked_by_name: string | null;
  revocation_reason: string | null;
  review_outcome: 'justified' | 'unjustified' | null;
  review_note: string | null;
  reviewed_at: string | Date | null;
  reviewed_by_staff_id: string | null;
  reviewed_by_name: string | null;
  patient_notified_at: string | Date | null;
  mrn: string | null;
};

/**
 * Row-level security confines every read here to consents granted to the
 * caller's own hospital; expiry is computed from the date rather than stored.
 */
const CONSENT_SELECT = sql`
  SELECT ca."id", ca."patient_id", ca."data_categories"::text[] AS data_categories,
         to_char(ca."date_range_from", 'YYYY-MM-DD') AS date_range_from,
         to_char(ca."date_range_to", 'YYYY-MM-DD') AS date_range_to,
         ca."granted_at", ca."expires_at",
         CASE WHEN ca."status" = 'revoked' THEN 'revoked'
              WHEN ca."expires_at" <= now() THEN 'expired'
              ELSE 'active' END AS effective_status,
         ca."capture_method", ca."witness_name", ca."emergency_reason",
         ca."recorded_by_staff_id", rb."name" AS recorded_by_name,
         ca."revoked_at", ca."revoked_by_staff_id", vb."name" AS revoked_by_name,
         ca."revocation_reason", ca."review_outcome", ca."review_note", ca."reviewed_at",
         ca."reviewed_by_staff_id", wb."name" AS reviewed_by_name, ca."patient_notified_at",
         l."mrn"
    FROM "consent_artefact" ca
    LEFT JOIN "staff_user" rb ON rb."id" = ca."recorded_by_staff_id"
    LEFT JOIN "staff_user" vb ON vb."id" = ca."revoked_by_staff_id"
    LEFT JOIN "staff_user" wb ON wb."id" = ca."reviewed_by_staff_id"
    LEFT JOIN "patient_hospital_link" l
           ON l."patient_id" = app.canonical_patient_id(ca."patient_id")
          AND l."hospital_id" = ca."grantee_hospital_id"
`;

/**
 * Consent recorded at the desk (Decision A1), and emergency access.
 *
 * Both are consent artefacts, so the same database policies decide what they
 * reveal — there is no second path to another hospital's record. What differs
 * is who may create them and what happens afterwards: consent is asked of the
 * patient in person; emergency access is taken by a clinician with a reason,
 * lasts hours, and is reviewed by the hospital.
 */
@Injectable()
export class ConsentService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async record(
    actor: Actor,
    patientId: string,
    input: RecordConsentInput,
    meta: RequestMeta,
  ): Promise<ConsentSummary> {
    const hospitalId = requireHospital(actor);

    const row = await this.db.asTenant(hospitalId, async (tx) => {
      await requireLinkedPatient(tx, hospitalId, patientId);

      const [created] = await tx
        .insert(consentArtefacts)
        .values({
          patientId,
          granteeHospitalId: hospitalId,
          dataCategories: input.dataCategories,
          dateRangeFrom: input.dateRangeFrom ?? null,
          dateRangeTo: input.dateRangeTo ?? null,
          expiresAt: sql`now() + make_interval(days => ${input.validForDays})`,
          captureMethod: input.captureMethod,
          witnessName: input.captureMethod === 'verbal_witnessed' ? input.witnessName : null,
          recordedByStaffId: actor.staffUserId,
        })
        .returning({ id: consentArtefacts.id });

      if (!created) throw new Error('Failed to record the consent');

      return this.load(tx, created.id);
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'consent_artefact',
      resourceId: row.id,
      patientId,
      action: 'create',
      meta,
    });

    return this.toSummary(row);
  }

  async list(actor: Actor, patientId: string, meta: RequestMeta): Promise<ConsentSummary[]> {
    const hospitalId = requireHospital(actor);

    const rows = await this.db.asTenant(hospitalId, async (tx) => {
      await requireLinkedPatient(tx, hospitalId, patientId);

      const found = await tx.execute<ConsentRow>(sql`
        ${CONSENT_SELECT}
         WHERE ca."patient_id" = ANY (app.patient_record_ids(${patientId}::uuid))
      ORDER BY ca."granted_at" DESC
      `);

      return [...found];
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'consent_artefact',
      patientId,
      action: 'read',
      meta,
    });

    return rows.map((row) => this.toSummary(row));
  }

  async revoke(
    actor: Actor,
    consentId: string,
    reason: string,
    meta: RequestMeta,
  ): Promise<ConsentSummary> {
    const hospitalId = requireHospital(actor);

    const row = await this.db.asTenant(hospitalId, async (tx) => {
      const current = await this.load(tx, consentId);

      if (current.effective_status !== 'active') {
        throw new ConflictException(`This consent is already ${current.effective_status}`);
      }

      const updated = await tx
        .update(consentArtefacts)
        .set({
          status: 'revoked',
          revokedAt: sql`now()`,
          revokedByStaffId: actor.staffUserId,
          revocationReason: reason,
        })
        .where(eq(consentArtefacts.id, consentId))
        .returning({ id: consentArtefacts.id });

      if (updated.length === 0) throw new NotFoundException('Consent not found');

      return this.load(tx, consentId);
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'consent_artefact',
      resourceId: consentId,
      patientId: row.patient_id,
      action: 'update',
      meta,
    });

    return this.toSummary(row);
  }

  /**
   * Emergency access: every category, for a few hours, with a reason. The
   * reason is also written to the access log itself, where it stays with the
   * record of the access whatever happens to the artefact.
   */
  async breakGlass(
    actor: Actor,
    patientId: string,
    input: BreakGlassInput,
    meta: RequestMeta,
  ): Promise<ConsentSummary> {
    const hospitalId = requireHospital(actor);

    const row = await this.db.asTenant(hospitalId, async (tx) => {
      await requireLinkedPatient(tx, hospitalId, patientId);

      const [created] = await tx
        .insert(consentArtefacts)
        .values({
          patientId,
          granteeHospitalId: hospitalId,
          dataCategories: [...CLINICAL_DATA_CATEGORIES],
          expiresAt: sql`now() + make_interval(hours => ${input.hours})`,
          captureMethod: 'break_glass',
          emergencyReason: input.reason,
          recordedByStaffId: actor.staffUserId,
        })
        .returning({ id: consentArtefacts.id });

      if (!created) throw new Error('Failed to record emergency access');

      return this.load(tx, created.id);
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'consent_artefact',
      resourceId: row.id,
      patientId,
      action: 'create',
      breakGlassReason: input.reason,
      meta,
    });

    return this.toSummary(row);
  }

  /** Emergency accesses taken at this hospital that nobody has reviewed yet, oldest first. */
  async reviewQueue(actor: Actor, meta: RequestMeta): Promise<BreakGlassReviewItem[]> {
    const hospitalId = requireHospital(actor);

    const rows = await this.db.asTenant(hospitalId, async (tx) => {
      const found = await tx.execute<ConsentRow>(sql`
        ${CONSENT_SELECT}
         WHERE ca."capture_method"::text = 'break_glass' AND ca."reviewed_at" IS NULL
      ORDER BY ca."granted_at" ASC
      `);

      return [...found];
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'consent_artefact',
      action: 'search',
      meta,
    });

    return rows.map((row) => ({
      id: row.id,
      mrn: row.mrn,
      reason: row.emergency_reason ?? '',
      grantedAt: toIso(row.granted_at),
      expiresAt: toIso(row.expires_at),
      status: row.effective_status,
      clinician: { id: row.recorded_by_staff_id, name: row.recorded_by_name },
      patientNotified: row.patient_notified_at !== null,
    }));
  }

  async review(
    actor: Actor,
    consentId: string,
    input: ReviewBreakGlassInput,
    meta: RequestMeta,
  ): Promise<ConsentSummary> {
    const hospitalId = requireHospital(actor);

    const row = await this.db.asTenant(hospitalId, async (tx) => {
      const current = await this.load(tx, consentId);

      if (current.capture_method !== 'break_glass') {
        throw new BadRequestException('Only emergency access is reviewed');
      }

      if (current.reviewed_at) {
        throw new ConflictException('This emergency access has already been reviewed');
      }

      if (current.recorded_by_staff_id === actor.staffUserId) {
        throw new ForbiddenException(
          'Emergency access is reviewed by someone other than who took it',
        );
      }

      await tx
        .update(consentArtefacts)
        .set({
          reviewedAt: sql`now()`,
          reviewedByStaffId: actor.staffUserId,
          reviewOutcome: input.outcome,
          reviewNote: input.note,
        })
        .where(eq(consentArtefacts.id, consentId));

      return this.load(tx, consentId);
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'consent_artefact',
      resourceId: consentId,
      action: 'update',
      meta,
    });

    return this.toSummary(row);
  }

  private async load(tx: DbTransaction, consentId: string): Promise<ConsentRow> {
    const [row] = await tx.execute<ConsentRow>(sql`
      ${CONSENT_SELECT}
       WHERE ca."id" = ${consentId}::uuid
    `);

    if (!row) throw new NotFoundException('Consent not found');

    return row;
  }

  private toSummary(row: ConsentRow): ConsentSummary {
    return {
      id: row.id,
      patientId: row.patient_id,
      dataCategories: row.data_categories,
      dateRangeFrom: row.date_range_from,
      dateRangeTo: row.date_range_to,
      grantedAt: toIso(row.granted_at),
      expiresAt: toIso(row.expires_at),
      status: row.effective_status,
      captureMethod: row.capture_method,
      witnessName: row.witness_name,
      emergencyReason: row.emergency_reason,
      recordedBy: { id: row.recorded_by_staff_id, name: row.recorded_by_name },
      revokedAt: row.revoked_at ? toIso(row.revoked_at) : null,
      revokedBy: row.revoked_by_staff_id
        ? { id: row.revoked_by_staff_id, name: row.revoked_by_name }
        : null,
      revocationReason: row.revocation_reason,
      review:
        row.review_outcome && row.reviewed_at && row.reviewed_by_staff_id
          ? {
              outcome: row.review_outcome,
              note: row.review_note ?? '',
              reviewedAt: toIso(row.reviewed_at),
              reviewedBy: { id: row.reviewed_by_staff_id, name: row.reviewed_by_name },
            }
          : null,
      patientNotifiedAt: row.patient_notified_at ? toIso(row.patient_notified_at) : null,
    };
  }
}
