import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  CORRECTION_FIELDS,
  updatePatientSchema,
  type CorrectionField,
  type CorrectionQueueItem,
  type CorrectionRequestSummary,
  type PortalCorrections,
  type RequestCorrectionInput,
  type UpdatePatientInput,
} from '@health24/shared';
import { requireHospital, type Actor, type PatientActor, type RequestMeta } from '../../common/actor';
import type { DbTransaction } from '../../db/client';
import { DatabaseService } from '../../db/database.service';
import { correctionRequests } from '../../db/schema';
import { AuditService } from '../audit/audit.service';
import { staffName } from '../clinical/staff-names';
import { requireLinkedPatient, toIso } from '../clinical/clinical-access';
import { PatientsService } from '../patients/patients.service';

/** How the patient's words map to the record's own columns, and to a correction. */
const COLUMN: Record<CorrectionField, string> = {
  name: 'name',
  date_of_birth: 'date_of_birth',
  gender: 'gender',
  phone: 'phone',
  blood_group: 'blood_group',
  emergency_contact_name: 'emergency_contact_name',
  emergency_contact_phone: 'emergency_contact_phone',
};

const UPDATE_KEY: Record<CorrectionField, keyof UpdatePatientInput> = {
  name: 'name',
  date_of_birth: 'dateOfBirth',
  gender: 'gender',
  phone: 'phone',
  blood_group: 'bloodGroup',
  emergency_contact_name: 'emergencyContactName',
  emergency_contact_phone: 'emergencyContactPhone',
};

/** How many resolved requests a hospital's queue keeps in view. */
const RESOLVED_SHOWN = 20;

type RequestRow = {
  id: string;
  patient_id: string;
  hospital_id: string;
  hospital_name: string | null;
  field: CorrectionField;
  current_value: string | null;
  requested_value: string;
  note: string | null;
  status: CorrectionRequestSummary['status'];
  created_at: string | Date;
  resolved_at: string | Date | null;
  resolved_by_staff_id: string | null;
  resolved_by_name: string | null;
  resolution_note: string | null;
  patient_name?: string;
  mrn?: string | null;
};

const requestSelect = (context: 'hospital' | 'patient') => sql`
  SELECT r."id", r."patient_id", r."hospital_id", h."name" AS hospital_name, r."field",
         r."current_value", r."requested_value", r."note", r."status", r."created_at",
         r."resolved_at", r."resolved_by_staff_id",
         ${staffName(context, sql`s."name"`, sql`r."resolved_by_staff_id"`)} AS resolved_by_name,
         r."resolution_note"
    FROM "correction_request" r
    LEFT JOIN "hospital_directory" h ON h."id" = r."hospital_id"
    LEFT JOIN "staff_user" s ON s."id" = r."resolved_by_staff_id"
`;

/**
 * Corrections a patient asks for (sp5-plan.md, Decision N1).
 *
 * The patient names the field and what it should say; the request goes to the
 * hospital they chose, whose records staff apply it through the ordinary
 * demographic correction — so the change is attributed, reasoned and kept in
 * the patient's history exactly as any other correction is — or decline it,
 * saying why.
 */
@Injectable()
export class CorrectionsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly patients: PatientsService,
  ) {}

  // ---------------------------------------------------------------------------
  // The patient, in the portal
  // ---------------------------------------------------------------------------

  async overview(patient: PatientActor, meta: RequestMeta): Promise<PortalCorrections> {
    const { hospitals, current, requests } = await this.db.asPatient(
      patient.patientId,
      async (tx) => {
        const linked = await tx.execute<{ id: string; name: string }>(sql`
          SELECT l."hospital_id" AS id, h."name"
            FROM "patient_hospital_link" l
            JOIN "hospital_directory" h ON h."id" = l."hospital_id"
           WHERE l."patient_id" = ANY (app.patient_record_ids(${patient.patientId}::uuid))
        GROUP BY l."hospital_id", h."name"
        ORDER BY min(l."first_seen_at")
        `);

        const [values] = await tx.execute<Record<string, string | null>>(sql`
          SELECT "name", to_char("date_of_birth", 'YYYY-MM-DD') AS date_of_birth,
                 "gender"::text AS gender, "phone", "blood_group"::text AS blood_group,
                 "emergency_contact_name", "emergency_contact_phone"
            FROM "patient" WHERE "id" = ${patient.patientId}::uuid
        `);

        const rows = await tx.execute<RequestRow>(sql`
          ${requestSelect('patient')}
           WHERE r."patient_id" = ANY (app.patient_record_ids(${patient.patientId}::uuid))
        ORDER BY r."created_at" DESC
        `);

        return { hospitals: [...linked], current: values ?? {}, requests: [...rows] };
      },
    );

    await this.audit.recordForPatient(patient, {
      resourceType: 'correction_request',
      action: 'search',
      meta,
    });

    return {
      hospitals,
      current: Object.fromEntries(
        CORRECTION_FIELDS.map((field) => [field, current[COLUMN[field]] ?? null]),
      ) as PortalCorrections['current'],
      requests: requests.map((row) => this.toSummary(row)),
    };
  }

  async request(
    patient: PatientActor,
    input: RequestCorrectionInput,
    meta: RequestMeta,
  ): Promise<CorrectionRequestSummary> {
    const row = await this.db.asPatient(patient.patientId, async (tx) => {
      const [current] = await tx.execute<Record<string, string | null>>(sql`
        SELECT ${sql.raw(`"${COLUMN[input.field]}"::text`)} AS value
          FROM "patient" WHERE "id" = ${patient.patientId}::uuid
      `);

      const [created] = await tx
        .insert(correctionRequests)
        .values({
          patientId: patient.patientId,
          hospitalId: input.hospitalId,
          requestedByAccountId: patient.accountId,
          field: input.field,
          currentValue: current?.value ?? null,
          requestedValue: input.requestedValue,
          note: input.note ?? null,
        })
        .returning({ id: correctionRequests.id })
        .catch((error: unknown) => {
          // The insert policy admits only a hospital the patient is registered at.
          if (String(error).includes('row-level security')) {
            throw new BadRequestException('Choose a hospital where you are registered');
          }
          throw error;
        });

      if (!created) throw new Error('Failed to record the request');

      return this.load(tx, created.id, 'patient');
    });

    await this.audit.recordForPatient(patient, {
      resourceType: 'correction_request',
      resourceId: row.id,
      action: 'create',
      meta,
    });

    return this.toSummary(row);
  }

  // ---------------------------------------------------------------------------
  // The hospital's records staff
  // ---------------------------------------------------------------------------

  /** What patients have asked this hospital to correct: waiting first, then lately resolved. */
  async queue(actor: Actor, meta: RequestMeta): Promise<CorrectionQueueItem[]> {
    const hospitalId = requireHospital(actor);

    const rows = await this.db.asTenant(hospitalId, async (tx) => {
      const found = await tx.execute<RequestRow>(sql`
        SELECT q.*, p."name" AS patient_name, l."mrn"
          FROM (${requestSelect('hospital')}) q
          LEFT JOIN "patient" p ON p."id" = q."patient_id"
          LEFT JOIN "patient_hospital_link" l
                 ON l."patient_id" = app.canonical_patient_id(q."patient_id")
                AND l."hospital_id" = q."hospital_id"
         WHERE q."status" = 'pending'
            OR q."resolved_at" > now() - interval '30 days'
      ORDER BY q."status" <> 'pending', q."created_at"
         LIMIT ${RESOLVED_SHOWN + 100}
      `);

      return [...found];
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'correction_request',
      action: 'search',
      meta,
    });

    return rows.map((row) => this.toQueueItem(row));
  }

  /** Applies the correction as an ordinary demographic change, with the request as its reason. */
  async apply(
    actor: Actor,
    requestId: string,
    note: string | undefined,
    meta: RequestMeta,
  ): Promise<CorrectionQueueItem> {
    const hospitalId = requireHospital(actor);
    const current = await this.db.asTenant(hospitalId, (tx) => this.load(tx, requestId, 'hospital'));

    if (current.status !== 'pending') {
      throw new ConflictException(`This request was already ${current.status}`);
    }

    await this.db.asTenant(hospitalId, (tx) =>
      requireLinkedPatient(tx, hospitalId, current.patient_id),
    );

    const change = updatePatientSchema.safeParse({
      [UPDATE_KEY[current.field]]: current.requested_value,
      reason: `Correction the patient asked for in the portal: ${current.field.replace(/_/g, ' ')}`,
    });

    if (!change.success) {
      throw new BadRequestException(
        `That is not a valid ${current.field.replace(/_/g, ' ')}. Decline the request and ask the patient.`,
      );
    }

    await this.patients.update(actor, current.patient_id, change.data, meta);

    const row = await this.resolve(actor, hospitalId, requestId, 'applied', note ?? null);

    await this.audit.recordForActor(actor, {
      resourceType: 'correction_request',
      resourceId: requestId,
      patientId: current.patient_id,
      action: 'update',
      meta,
    });

    return this.toQueueItem(row);
  }

  async decline(
    actor: Actor,
    requestId: string,
    note: string,
    meta: RequestMeta,
  ): Promise<CorrectionQueueItem> {
    const hospitalId = requireHospital(actor);
    const current = await this.db.asTenant(hospitalId, (tx) => this.load(tx, requestId, 'hospital'));

    if (current.status !== 'pending') {
      throw new ConflictException(`This request was already ${current.status}`);
    }

    const row = await this.resolve(actor, hospitalId, requestId, 'declined', note);

    await this.audit.recordForActor(actor, {
      resourceType: 'correction_request',
      resourceId: requestId,
      patientId: current.patient_id,
      action: 'update',
      meta,
    });

    return this.toQueueItem(row);
  }

  private async resolve(
    actor: Actor,
    hospitalId: string,
    requestId: string,
    status: 'applied' | 'declined',
    note: string | null,
  ): Promise<RequestRow> {
    return this.db.asTenant(hospitalId, async (tx) => {
      const updated = await tx.execute<{ id: string }>(sql`
        UPDATE "correction_request"
           SET "status" = ${status}, "resolved_at" = now(),
               "resolved_by_staff_id" = ${actor.staffUserId}::uuid, "resolution_note" = ${note}
         WHERE "id" = ${requestId}::uuid AND "status" = 'pending'
     RETURNING "id"
      `);

      if ([...updated].length === 0) {
        throw new ConflictException('This request was resolved a moment ago');
      }

      return this.load(tx, requestId, 'hospital');
    });
  }

  private async load(
    tx: DbTransaction,
    requestId: string,
    context: 'hospital' | 'patient',
  ): Promise<RequestRow> {
    const [row] = await tx.execute<RequestRow>(sql`
      ${requestSelect(context)} WHERE r."id" = ${requestId}::uuid
    `);

    if (!row) throw new NotFoundException('Correction request not found');

    return row;
  }

  private toSummary(row: RequestRow): CorrectionRequestSummary {
    return {
      id: row.id,
      patientId: row.patient_id,
      hospital: { id: row.hospital_id, name: row.hospital_name ?? 'Unknown hospital' },
      field: row.field,
      currentValue: row.current_value,
      requestedValue: row.requested_value,
      note: row.note,
      status: row.status,
      createdAt: toIso(row.created_at),
      resolvedAt: row.resolved_at ? toIso(row.resolved_at) : null,
      resolvedBy: row.resolved_by_staff_id
        ? { id: row.resolved_by_staff_id, name: row.resolved_by_name }
        : null,
      resolutionNote: row.resolution_note,
    };
  }

  private toQueueItem(row: RequestRow): CorrectionQueueItem {
    return {
      ...this.toSummary(row),
      patient: { id: row.patient_id, name: row.patient_name ?? 'Unknown', mrn: row.mrn ?? null },
    };
  }
}
