import { createHash, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  hasPermission,
  type ComposeDischargeInput,
  type DischargeSection,
  type DischargeSummary,
  type EditDischargeInput,
} from '@health24/shared';
import { requireHospital, type Actor, type RequestMeta } from '../../common/actor';
import type { DbTransaction } from '../../db/client';
import { DatabaseService } from '../../db/database.service';
import { AuditService } from '../audit/audit.service';
import { toIso } from '../clinical/clinical-access';
import { documentFileKey } from '../storage/keys';
import { bedDaysOf } from '../wards/admissions.service';
import { StorageService } from '../storage/storage.service';
import {
  asNoteBody,
  composeSections,
  tidyNumber,
  type DischargeSource,
} from './discharge-composer';
import { buildDischargePdf } from './discharge-pdf';

type SummaryRow = {
  id: string;
  encounter_id: string;
  patient_id: string;
  hospital_id: string;
  status: 'draft' | 'signed';
  sections: DischargeSection[];
  composed_at: string | Date;
  composed_by_staff_id: string;
  composed_by_name: string | null;
  signed_at: string | Date | null;
  signed_by_staff_id: string | null;
  signed_by_name: string | null;
  clinical_note_id: string | null;
  document_reference_id: string | null;
};

const SUMMARY_SELECT = sql`
  SELECT s."id", s."encounter_id", s."patient_id", s."hospital_id", s."status", s."sections",
         s."composed_at", s."composed_by_staff_id", cb."name" AS composed_by_name,
         s."signed_at", s."signed_by_staff_id", sb."name" AS signed_by_name,
         s."clinical_note_id", s."document_reference_id"
    FROM "discharge_summary" s
    LEFT JOIN "staff_user" cb ON cb."id" = s."composed_by_staff_id"
    LEFT JOIN "staff_user" sb ON sb."id" = s."signed_by_staff_id"
`;

/**
 * The discharge summary (sp6-plan.md, DF6 and DF7).
 *
 * Composed from the encounter's own data, edited by a clinician, and signed —
 * and it is not a summary until it is. The signature writes the record twice:
 * a versioned clinical note, which is what the hospital keeps, and a PDF,
 * which is what the patient carries and the next hospital opens.
 */
@Injectable()
export class DischargeService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
  ) {}

  async compose(
    actor: Actor,
    input: ComposeDischargeInput,
    meta: RequestMeta,
  ): Promise<DischargeSummary> {
    const hospitalId = requireHospital(actor);

    const row = await this.db.asTenant(hospitalId, async (tx) => {
      const encounter = await this.requireAdmission(tx, hospitalId, input.encounterId);
      const source = await this.gather(tx, input.encounterId);

      const [existing] = await tx.execute<SummaryRow>(sql`
        ${SUMMARY_SELECT} WHERE s."encounter_id" = ${input.encounterId}::uuid
      `);

      if (existing?.status === 'signed') {
        throw new ConflictException('This summary has been signed; correct the note instead');
      }

      const sections = composeSections(source, existing?.sections ?? []);

      if (existing) {
        await tx.execute(sql`
          UPDATE "discharge_summary"
             SET "sections" = ${JSON.stringify(sections)}::jsonb,
                 "composed_from" = ${JSON.stringify(source)}::jsonb,
                 "composed_at" = now(),
                 "composed_by_staff_id" = ${actor.staffUserId}::uuid
           WHERE "id" = ${existing.id}::uuid
        `);

        return this.load(tx, existing.id);
      }

      const [created] = await tx.execute<{ id: string }>(sql`
        INSERT INTO "discharge_summary"
          ("patient_id", "hospital_id", "encounter_id", "sections", "composed_from",
           "composed_by_staff_id")
        VALUES (${encounter.patientId}::uuid, ${hospitalId}::uuid, ${input.encounterId}::uuid,
                ${JSON.stringify(sections)}::jsonb, ${JSON.stringify(source)}::jsonb,
                ${actor.staffUserId}::uuid)
        RETURNING "id"
      `);

      return this.load(tx, created!.id);
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'discharge_summary',
      resourceId: row.id,
      patientId: row.patient_id,
      action: 'create',
      meta,
    });

    return this.toSummary(row);
  }

  async forEncounter(
    actor: Actor,
    encounterId: string,
    meta: RequestMeta,
  ): Promise<DischargeSummary> {
    const hospitalId = requireHospital(actor);

    const row = await this.db.asTenant(hospitalId, async (tx) => {
      const [found] = await tx.execute<SummaryRow>(sql`
        ${SUMMARY_SELECT} WHERE s."encounter_id" = ${encounterId}::uuid
      `);

      if (!found) throw new NotFoundException('No discharge summary has been started');

      return found;
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'discharge_summary',
      resourceId: row.id,
      patientId: row.patient_id,
      action: 'read',
      meta,
    });

    return this.toSummary(row);
  }

  /** The clinician's own words, replacing what composition offered. */
  async edit(
    actor: Actor,
    summaryId: string,
    input: EditDischargeInput,
    meta: RequestMeta,
  ): Promise<DischargeSummary> {
    const hospitalId = requireHospital(actor);

    const row = await this.db.asTenant(hospitalId, async (tx) => {
      const current = await this.load(tx, summaryId);
      this.requireDraft(current);

      const edited = current.sections.map((section) => {
        const change = input.sections.find((candidate) => candidate.key === section.key);
        if (!change) return section;

        return { ...section, text: change.text, composed: false };
      });

      await tx.execute(sql`
        UPDATE "discharge_summary" SET "sections" = ${JSON.stringify(edited)}::jsonb
         WHERE "id" = ${summaryId}::uuid
      `);

      return this.load(tx, summaryId);
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'discharge_summary',
      resourceId: summaryId,
      patientId: row.patient_id,
      action: 'update',
      meta,
    });

    return this.toSummary(row);
  }

  /**
   * The signature.
   *
   * A clinician signs their own summary: it is a clinical statement about a
   * patient, not transcription, so `clinical:transcribe` is not enough. The
   * note and the PDF are written in the same transaction as the signature, so
   * a signed summary always has both.
   */
  async sign(actor: Actor, summaryId: string, meta: RequestMeta): Promise<DischargeSummary> {
    const hospitalId = requireHospital(actor);

    if (!hasPermission(actor.role, 'clinical:write')) {
      throw new ForbiddenException('A discharge summary is signed by the clinician who wrote it');
    }

    const prepared = await this.db.asTenant(hospitalId, async (tx) => {
      const current = await this.load(tx, summaryId);
      this.requireDraft(current);

      if (current.sections.every((section) => section.text.trim().length === 0)) {
        throw new BadRequestException('There is nothing in this summary to sign');
      }

      const header = await this.header(tx, current, actor.staffUserId);
      return { current, header };
    });

    const signedAt = new Date();
    const pdf = await buildDischargePdf(
      { ...prepared.header, signedAt },
      prepared.current.sections,
    );

    const documentId = randomUUID();
    const fileId = randomUUID();
    const key = documentFileKey({
      hospitalId,
      patientId: prepared.current.patient_id,
      documentId,
      fileId,
    });

    // Written to storage before the record points at it: a document that names
    // a file which is not there would be worse than no document.
    await this.storage.put(key, pdf, 'application/pdf');

    const row = await this.db.asTenant(hospitalId, async (tx) => {
      const current = await this.load(tx, summaryId);
      this.requireDraft(current);

      const noteId = await this.writeNote(tx, current, actor, signedAt);
      await this.writeDocument(tx, {
        current,
        documentId,
        fileId,
        key,
        pdf,
        actor,
        signedAt,
      });

      await tx.execute(sql`
        UPDATE "discharge_summary"
           SET "status" = 'signed', "signed_at" = ${signedAt.toISOString()}::timestamptz,
               "signed_by_staff_id" = ${actor.staffUserId}::uuid,
               "clinical_note_id" = ${noteId}::uuid,
               "document_reference_id" = ${documentId}::uuid
         WHERE "id" = ${summaryId}::uuid
      `);

      return this.load(tx, summaryId);
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'discharge_summary',
      resourceId: summaryId,
      patientId: row.patient_id,
      action: 'update',
      meta,
    });

    return this.toSummary(row);
  }

  /** The versioned note the signature writes: the record the hospital keeps. */
  private async writeNote(
    tx: DbTransaction,
    current: SummaryRow,
    actor: Actor,
    signedAt: Date,
  ): Promise<string> {
    const [note] = await tx.execute<{ id: string }>(sql`
      INSERT INTO "clinical_note"
        ("patient_id", "hospital_id", "encounter_id", "template", "title", "body", "sections",
         "recorded_by_staff_id", "attributed_clinician_id", "entry_source", "recorded_at")
      VALUES (${current.patient_id}::uuid, ${current.hospital_id}::uuid,
              ${current.encounter_id}::uuid, 'discharge_summary', 'Discharge summary',
              ${asNoteBody(current.sections)},
              ${JSON.stringify(
                current.sections.map((section) => ({
                  key: section.key,
                  label: section.label,
                  text: section.text,
                })),
              )}::jsonb,
              ${actor.staffUserId}::uuid, ${actor.staffUserId}::uuid, 'direct',
              ${signedAt.toISOString()}::timestamptz)
      RETURNING "id"
    `);

    return note!.id;
  }

  /**
   * The PDF as a document of the patient's record.
   *
   * Its one file is marked clean without a scan: the server rendered it from
   * the record a moment ago and it never left this process. The scanner exists
   * for files people upload (sp4-plan.md), and there is nothing here to scan.
   */
  private async writeDocument(
    tx: DbTransaction,
    args: {
      current: SummaryRow;
      documentId: string;
      fileId: string;
      key: string;
      pdf: Uint8Array;
      actor: Actor;
      signedAt: Date;
    },
  ): Promise<void> {
    const { current, documentId, fileId, key, pdf, actor, signedAt } = args;
    const sha256 = createHash('sha256').update(pdf).digest('hex');

    await tx.execute(sql`
      INSERT INTO "document_reference"
        ("id", "patient_id", "hospital_id", "encounter_id", "doc_type", "title", "report_date",
         "ordering_clinician_id", "availability", "availability_changed_at", "upload_confirmed_at",
         "recorded_by_staff_id", "recorded_at")
      VALUES (${documentId}::uuid, ${current.patient_id}::uuid, ${current.hospital_id}::uuid,
              ${current.encounter_id}::uuid, 'discharge_summary', 'Discharge summary',
              app.ist_date(${signedAt.toISOString()}::timestamptz),
              ${actor.staffUserId}::uuid, 'available', ${signedAt.toISOString()}::timestamptz,
              ${signedAt.toISOString()}::timestamptz, ${actor.staffUserId}::uuid,
              ${signedAt.toISOString()}::timestamptz)
    `);

    await tx.execute(sql`
      INSERT INTO "document_file"
        ("id", "document_id", "patient_id", "hospital_id", "position", "storage_key", "mime_type",
         "size_bytes", "sha256", "scan_status", "scanned_at")
      VALUES (${fileId}::uuid, ${documentId}::uuid, ${current.patient_id}::uuid,
              ${current.hospital_id}::uuid, 1, ${key}, 'application/pdf', ${pdf.byteLength},
              ${sha256}, 'clean', ${signedAt.toISOString()}::timestamptz)
    `);
  }

  /** Everything the PDF says about who this is, drawn from the record. */
  private async header(
    tx: DbTransaction,
    current: SummaryRow,
    signerId: string,
  ): Promise<{
    hospitalName: string;
    patientName: string;
    mrn: string | null;
    ageGender: string | null;
    admittedAt: string;
    dischargedAt: string | null;
    signedBy: string;
  }> {
    const [row] = await tx.execute<{
      hospital_name: string | null;
      patient_name: string | null;
      mrn: string | null;
      gender: string | null;
      birth_year: number | null;
      admitted_at: string | Date;
      discharged_at: string | Date | null;
      signer: string | null;
    }>(sql`
      SELECT h."name" AS hospital_name, p."name" AS patient_name, l."mrn", p."gender"::text AS gender,
             p."birth_year", e."started_at" AS admitted_at, e."ended_at" AS discharged_at,
             s."name" AS signer
        FROM "encounter" e
        LEFT JOIN "hospital_directory" h ON h."id" = e."hospital_id"
        LEFT JOIN "patient" p ON p."id" = e."patient_id"
        LEFT JOIN "patient_hospital_link" l
               ON l."patient_id" = e."patient_id" AND l."hospital_id" = e."hospital_id"
        LEFT JOIN "staff_user" s ON s."id" = ${signerId}::uuid
       WHERE e."id" = ${current.encounter_id}::uuid
    `);

    const years = row?.birth_year ? new Date().getFullYear() - row.birth_year : null;

    return {
      hospitalName: row?.hospital_name ?? 'This hospital',
      patientName: row?.patient_name ?? 'The patient',
      mrn: row?.mrn ?? null,
      ageGender: [years ? `${years} years` : null, row?.gender].filter(Boolean).join(', ') || null,
      admittedAt: toIso(row!.admitted_at),
      dischargedAt: row?.discharged_at ? toIso(row.discharged_at) : null,
      signedBy: row?.signer ?? 'A clinician',
    };
  }

  /** What the record holds about this admission, for composition. */
  private async gather(tx: DbTransaction, encounterId: string): Promise<DischargeSource> {
    const [admission] = await tx.execute<{
      admitted_at: string | Date;
      discharged_at: string | Date | null;
      reason: string | null;
      attending: string | null;
      system_of_medicine: string;
    }>(sql`
      SELECT e."started_at" AS admitted_at, e."ended_at" AS discharged_at,
             e."chief_complaint" AS reason, s."name" AS attending,
             e."system_of_medicine"::text AS system_of_medicine
        FROM "encounter" e
        LEFT JOIN "staff_user" s ON s."id" = e."attending_staff_id"
       WHERE e."id" = ${encounterId}::uuid
    `);

    const stays = await tx.execute<{
      ward: string;
      bed: string;
      started_at: string | Date;
      ended_at: string | Date | null;
    }>(sql`
      SELECT w."name" AS ward, b."label" AS bed, st."started_at", st."ended_at"
        FROM "bed_stay" st
        JOIN "bed" b ON b."id" = st."bed_id"
        JOIN "ward" w ON w."id" = b."ward_id"
       WHERE st."encounter_id" = ${encounterId}::uuid
    ORDER BY st."started_at" ASC
    `);

    const diagnoses = await tx.execute<{
      name: string | null;
      codes: string[];
      status: string;
      is_primary: boolean;
    }>(sql`
      SELECT (
               SELECT cc."display" FROM "condition_coding" cc
                WHERE cc."condition_id" = c."id" AND cc."role" = 'primary' LIMIT 1
             ) AS name,
             coalesce(
               (SELECT array_agg(cc."code_system_key" || ' ' || cc."code")
                  FROM "condition_coding" cc WHERE cc."condition_id" = c."id"),
               '{}'
             ) AS codes,
             c."clinical_status"::text AS status, c."is_primary"
        FROM "condition" c
       WHERE c."encounter_id" = ${encounterId}::uuid AND c."version_status" = 'current'
    ORDER BY c."is_primary" DESC, c."recorded_at" ASC
    `);

    const procedures = await tx.execute<{
      name: string;
      performed_at: string | Date;
      performer: string | null;
      outcome: string | null;
      operative_note: string | null;
      anaesthesia: string | null;
      post_op_course: string | null;
    }>(sql`
      SELECT p."name", p."performed_at", s."name" AS performer, p."outcome", p."operative_note",
             p."anaesthesia", p."post_op_course"
        FROM "procedure" p
        LEFT JOIN "staff_user" s ON s."id" = p."performer_staff_id"
       WHERE p."encounter_id" = ${encounterId}::uuid AND p."version_status" = 'current'
    ORDER BY p."performed_at" ASC
    `);

    const devices = await tx.execute<{
      name: string;
      serial_or_lot: string | null;
      manufacturer: string | null;
    }>(sql`
      SELECT "name", "serial_or_lot", "manufacturer" FROM "implant_device"
       WHERE "encounter_id" = ${encounterId}::uuid AND "version_status" = 'current'
    ORDER BY "implanted_at" ASC
    `);

    const results = await tx.execute<{
      display: string;
      value: string | null;
      unit: string | null;
      interpretation: string | null;
      effective_at: string | Date;
    }>(sql`
      SELECT "display", "value_quantity"::text AS value, "unit", "interpretation"::text AS interpretation,
             "effective_at"
        FROM "observation"
       WHERE "encounter_id" = ${encounterId}::uuid AND "version_status" = 'current'
         AND "category" = 'laboratory'
    ORDER BY "effective_at" ASC
    `);

    const medicines = await tx.execute<{
      medicine_name: string;
      strength: string | null;
      frequency: string | null;
      status: string;
    }>(sql`
      SELECT "medicine_name", "strength", "frequency", "status"::text AS status
        FROM "medication_request"
       WHERE "encounter_id" = ${encounterId}::uuid AND "version_status" = 'current'
    ORDER BY "recorded_at" ASC
    `);

    const stayRows = [...stays].map((stay) => ({
      ward: stay.ward,
      bed: stay.bed,
      from: toIso(stay.started_at),
      to: stay.ended_at ? toIso(stay.ended_at) : null,
      bedDays: bedDaysOf(stay.started_at, stay.ended_at),
    }));

    return {
      admission: {
        admittedAt: toIso(admission!.admitted_at),
        dischargedAt: admission!.discharged_at ? toIso(admission!.discharged_at) : null,
        reason: admission!.reason,
        attending: admission!.attending,
        systemOfMedicine: admission!.system_of_medicine,
        stays: stayRows,
        bedDays: stayRows.reduce((total, stay) => total + stay.bedDays, 0),
      },
      diagnoses: [...diagnoses].map((row) => ({
        name: row.name ?? 'Diagnosis',
        codes: row.codes,
        status: row.status,
        isPrimary: row.is_primary,
      })),
      procedures: [...procedures].map((row) => ({
        name: row.name,
        performedAt: toIso(row.performed_at),
        performer: row.performer,
        outcome: row.outcome,
        operativeNote: row.operative_note,
        anaesthesia: row.anaesthesia,
        postOpCourse: row.post_op_course,
      })),
      devices: [...devices].map((row) => ({
        name: row.name,
        serialOrLot: row.serial_or_lot,
        manufacturer: row.manufacturer,
      })),
      results: [...results].map((row) => ({
        label: row.display,
        value: [row.value ? tidyNumber(row.value) : null, row.unit].filter(Boolean).join(' '),
        flag: row.interpretation === 'normal' ? null : row.interpretation,
        at: toIso(row.effective_at),
      })),
      medicines: [...medicines].map((row) => ({
        name: row.medicine_name,
        dose: row.strength,
        frequency: row.frequency,
        status: row.status,
      })),
    };
  }

  /** An admission of this hospital, which is what a discharge summary is about. */
  private async requireAdmission(
    tx: DbTransaction,
    hospitalId: string,
    encounterId: string,
  ): Promise<{ patientId: string }> {
    const [encounter] = await tx.execute<{
      patient_id: string;
      hospital_id: string;
      class: string;
      status: string;
    }>(sql`
      SELECT "patient_id", "hospital_id", "class"::text AS class, "status"::text AS status
        FROM "encounter" WHERE "id" = ${encounterId}::uuid
    `);

    if (!encounter || encounter.hospital_id !== hospitalId) {
      throw new NotFoundException('Encounter not found');
    }

    if (encounter.class !== 'inpatient' && encounter.class !== 'emergency') {
      throw new BadRequestException('A discharge summary belongs to an admission');
    }

    if (encounter.status === 'cancelled') {
      throw new ConflictException('That encounter was cancelled');
    }

    return { patientId: encounter.patient_id };
  }

  private requireDraft(row: SummaryRow): void {
    if (row.status === 'signed') {
      throw new ConflictException('This summary has been signed; correct the note instead');
    }
  }

  private async load(tx: DbTransaction, summaryId: string): Promise<SummaryRow> {
    const [row] = await tx.execute<SummaryRow>(sql`
      ${SUMMARY_SELECT} WHERE s."id" = ${summaryId}::uuid
    `);

    if (!row) throw new NotFoundException('Discharge summary not found');

    return row;
  }

  private toSummary(row: SummaryRow): DischargeSummary {
    return {
      id: row.id,
      encounterId: row.encounter_id,
      patientId: row.patient_id,
      status: row.status,
      sections: row.sections,
      composedAt: toIso(row.composed_at),
      composedBy: { id: row.composed_by_staff_id, name: row.composed_by_name },
      signedAt: row.signed_at ? toIso(row.signed_at) : null,
      signedBy: row.signed_by_staff_id
        ? { id: row.signed_by_staff_id, name: row.signed_by_name }
        : null,
      noteId: row.clinical_note_id,
      documentId: row.document_reference_id,
    };
  }
}
