import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import type { EncounterSummary, ListEncountersQuery, OpenEncounterInput } from '@health24/shared';
import { DatabaseService } from '../../db/database.service';
import type { DbTransaction } from '../../db/client';
import { encounters, staffUsers } from '../../db/schema';
import { requireHospital, type Actor, type RequestMeta } from '../../common/actor';
import { AuditService } from '../audit/audit.service';
import {
  blankToNull,
  coveringConsentId,
  istToday,
  requireLinkedPatient,
  toIso,
} from './clinical-access';

type EncounterRow = {
  id: string;
  patient_id: string;
  hospital_id: string;
  hospital_name: string | null;
  class: EncounterSummary['class'];
  system_of_medicine: EncounterSummary['systemOfMedicine'];
  status: EncounterSummary['status'];
  started_at: string | Date;
  ended_at: string | Date | null;
  chief_complaint: string | null;
  status_reason: string | null;
  attending_staff_id: string;
  attending_name: string | null;
  patient_name: string | null;
  mrn: string | null;
  total: string;
};

/**
 * Every join here is subject to the caller's row-level security: another
 * hospital's staff and a merged-away patient simply come back null, rather
 * than being filtered out by hand.
 */
const ENCOUNTER_SELECT = sql`
  SELECT e."id", e."patient_id", e."hospital_id", d."name" AS hospital_name,
         e."class", e."system_of_medicine", e."status", e."started_at", e."ended_at",
         e."chief_complaint", e."status_reason", e."attending_staff_id",
         s."name" AS attending_name, p."name" AS patient_name, l."mrn",
         count(*) OVER () AS total
    FROM "encounter" e
    LEFT JOIN "hospital_directory" d ON d."id" = e."hospital_id"
    LEFT JOIN "staff_user" s ON s."id" = e."attending_staff_id"
    LEFT JOIN "patient" p ON p."id" = e."patient_id"
    LEFT JOIN "patient_hospital_link" l
           ON l."patient_id" = e."patient_id"
          AND l."hospital_id" = app.current_hospital_id()
`;

/**
 * Encounters: the container every clinical entry in a consultation hangs off.
 *
 * An encounter belongs to the hospital that opened it and only that hospital
 * closes it. Another hospital may read it under consent; the database refuses
 * anything more, and the service says so plainly rather than returning a
 * silent zero-row update.
 */
@Injectable()
export class EncountersService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async open(
    actor: Actor,
    input: OpenEncounterInput,
    meta: RequestMeta,
  ): Promise<EncounterSummary> {
    const hospitalId = requireHospital(actor);

    const encounterId = await this.db.asTenant(hospitalId, async (tx) => {
      await requireLinkedPatient(tx, hospitalId, input.patientId);

      const [staff] = await tx
        .select({ systemOfMedicine: staffUsers.systemOfMedicine })
        .from(staffUsers)
        .where(eq(staffUsers.id, actor.staffUserId))
        .limit(1);

      const systemOfMedicine = input.systemOfMedicine ?? staff?.systemOfMedicine;

      if (!systemOfMedicine) {
        throw new BadRequestException('Choose the system of medicine this encounter is under');
      }

      const [created] = await tx
        .insert(encounters)
        .values({
          patientId: input.patientId,
          hospitalId,
          class: input.class,
          systemOfMedicine,
          attendingStaffId: actor.staffUserId,
          chiefComplaint: blankToNull(input.chiefComplaint),
        })
        .returning({ id: encounters.id });

      if (!created) throw new Error('Failed to open the encounter');

      return created.id;
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'encounter',
      resourceId: encounterId,
      patientId: input.patientId,
      action: 'create',
      meta,
    });

    return this.findById(actor, encounterId, meta, { skipAudit: true });
  }

  async list(
    actor: Actor,
    query: ListEncountersQuery,
    meta: RequestMeta,
  ): Promise<{ results: EncounterSummary[]; total: number }> {
    const hospitalId = requireHospital(actor);
    const offset = (query.page - 1) * query.limit;
    const statusFilter = query.status ? sql`AND e."status" = ${query.status}` : sql``;

    const { rows, consentArtefactId } = await this.db.asTenant(hospitalId, async (tx) => {
      if (query.patientId) {
        await requireLinkedPatient(tx, hospitalId, query.patientId);

        const found = await tx.execute<EncounterRow>(sql`
          ${ENCOUNTER_SELECT}
           WHERE e."patient_id" = ANY (app.patient_record_ids(${query.patientId}::uuid))
             ${statusFilter}
        ORDER BY e."started_at" DESC
           LIMIT ${query.limit} OFFSET ${offset}
        `);

        return {
          rows: [...found],
          consentArtefactId: await this.consentFor(tx, hospitalId, query.patientId, [...found]),
        };
      }

      const found = await tx.execute<EncounterRow>(sql`
        ${ENCOUNTER_SELECT}
         WHERE e."hospital_id" = ${hospitalId}::uuid
           AND app.ist_date(e."started_at") = ${query.date ?? istToday()}::date
           ${statusFilter}
      ORDER BY e."started_at" ASC
         LIMIT ${query.limit} OFFSET ${offset}
      `);

      return { rows: [...found], consentArtefactId: null };
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'encounter',
      patientId: query.patientId ?? null,
      // A patient's history is a read of their record; the day's worklist is
      // a search across the hospital's.
      action: query.patientId ? 'read' : 'search',
      consentArtefactId,
      meta,
    });

    return {
      results: rows.map((row) => this.toSummary(row, hospitalId)),
      total: rows.length > 0 ? Number(rows[0]?.total ?? 0) : 0,
    };
  }

  async findById(
    actor: Actor,
    encounterId: string,
    meta: RequestMeta,
    options: { skipAudit?: boolean } = {},
  ): Promise<EncounterSummary> {
    const hospitalId = requireHospital(actor);

    const { row, consentArtefactId } = await this.db.asTenant(hospitalId, async (tx) => {
      const [found] = await tx.execute<EncounterRow>(sql`
        ${ENCOUNTER_SELECT}
         WHERE e."id" = ${encounterId}::uuid
      `);

      if (!found) throw new NotFoundException('Encounter not found');

      return {
        row: found,
        consentArtefactId: await this.consentFor(tx, hospitalId, found.patient_id, [found]),
      };
    });

    if (!options.skipAudit) {
      await this.audit.recordForActor(actor, {
        resourceType: 'encounter',
        resourceId: encounterId,
        patientId: row.patient_id,
        action: 'read',
        consentArtefactId,
        meta,
      });
    }

    return this.toSummary(row, hospitalId);
  }

  async finish(actor: Actor, encounterId: string, meta: RequestMeta): Promise<EncounterSummary> {
    return this.close(actor, encounterId, 'finished', null, meta);
  }

  async cancel(
    actor: Actor,
    encounterId: string,
    reason: string,
    meta: RequestMeta,
  ): Promise<EncounterSummary> {
    return this.close(actor, encounterId, 'cancelled', reason, meta);
  }

  private async close(
    actor: Actor,
    encounterId: string,
    outcome: 'finished' | 'cancelled',
    reason: string | null,
    meta: RequestMeta,
  ): Promise<EncounterSummary> {
    const hospitalId = requireHospital(actor);

    const patientId = await this.db.asTenant(hospitalId, async (tx) => {
      const [current] = await tx
        .select({
          hospitalId: encounters.hospitalId,
          patientId: encounters.patientId,
          status: encounters.status,
        })
        .from(encounters)
        .where(eq(encounters.id, encounterId))
        .limit(1);

      if (!current) throw new NotFoundException('Encounter not found');

      if (current.hospitalId !== hospitalId) {
        throw new ForbiddenException('Only the hospital that opened an encounter can close it');
      }

      if (current.status !== 'in_progress') {
        throw new ConflictException(`This encounter is already ${current.status}`);
      }

      const updated = await tx
        .update(encounters)
        .set({
          status: outcome,
          // The database clock, not this server's: the end must not precede a
          // start the database stamped.
          endedAt: sql`now()`,
          ...(reason ? { statusReason: reason } : {}),
        })
        .where(and(eq(encounters.id, encounterId), eq(encounters.status, 'in_progress')))
        .returning({ id: encounters.id });

      if (updated.length === 0) {
        throw new ConflictException('This encounter was closed by someone else a moment ago');
      }

      return current.patientId;
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'encounter',
      resourceId: encounterId,
      patientId,
      action: 'update',
      meta,
    });

    return this.findById(actor, encounterId, meta, { skipAudit: true });
  }

  /** The consent behind any of these rows that another hospital recorded. */
  private async consentFor(
    tx: DbTransaction,
    hospitalId: string,
    patientId: string,
    rows: EncounterRow[],
  ): Promise<string | null> {
    return rows.some((row) => row.hospital_id !== hospitalId)
      ? coveringConsentId(tx, patientId, 'encounters')
      : null;
  }

  private toSummary(row: EncounterRow, hospitalId: string): EncounterSummary {
    return {
      id: row.id,
      patientId: row.patient_id,
      hospital: {
        id: row.hospital_id,
        name: row.hospital_name ?? 'Unknown hospital',
        isOwn: row.hospital_id === hospitalId,
      },
      class: row.class,
      systemOfMedicine: row.system_of_medicine,
      status: row.status,
      startedAt: toIso(row.started_at),
      endedAt: row.ended_at ? toIso(row.ended_at) : null,
      chiefComplaint: row.chief_complaint,
      statusReason: row.status_reason,
      attending: { id: row.attending_staff_id, name: row.attending_name },
      patient: row.patient_name ? { name: row.patient_name, mrn: row.mrn } : null,
    };
  }
}
