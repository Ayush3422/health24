import { sql } from 'drizzle-orm';
import type { DbTransaction } from '../../db/client';

/** As many entries of one kind as an export carries; a record longer than this is rare. */
const LIMIT = 5_000;

export interface ExportRecord {
  patient: {
    id: string;
    name: string;
    gender: string;
    dateOfBirth: string | null;
    approximateAgeYears: number | null;
    bloodGroup: string | null;
    phone: string | null;
    emergencyContactName: string | null;
    emergencyContactPhone: string | null;
  };
  hospitals: Array<{ id: string; name: string; mrn: string }>;
  encounters: Array<{
    id: string;
    hospital_name: string | null;
    class: string;
    system_of_medicine: string;
    started_at: string;
    ended_at: string | null;
    status: string;
    chief_complaint: string | null;
    clinician_name: string | null;
  }>;
  conditions: Array<{
    id: string;
    hospital_name: string | null;
    recorded_at: string;
    clinical_status: string;
    verification_status: string;
    is_primary: boolean;
    note: string | null;
    clinician_name: string | null;
    codings: Array<{ role: string; system: string; code: string; display: string }>;
  }>;
  medications: Array<{
    id: string;
    hospital_name: string | null;
    recorded_at: string;
    medicine_name: string;
    strength: string | null;
    dose: string | null;
    frequency: string;
    route: string;
    duration: string | null;
    start_date: string | null;
    status: string;
    instructions: string | null;
    clinician_name: string | null;
  }>;
  allergies: Array<{
    id: string;
    hospital_name: string | null;
    recorded_at: string;
    substance: string;
    category: string;
    criticality: string;
    clinical_status: string;
    reaction: string | null;
    clinician_name: string | null;
  }>;
  observations: Array<{
    id: string;
    hospital_name: string | null;
    effective_at: string;
    category: string;
    code: string;
    code_system: string;
    display: string;
    value: string | null;
    value_text: string | null;
    unit: string | null;
    interpretation: string | null;
    reference_low: string | null;
    reference_high: string | null;
    group_id: string | null;
    panel_code: string | null;
  }>;
  procedures: Array<{
    id: string;
    hospital_name: string | null;
    performed_at: string;
    name: string;
    outcome: string | null;
    clinician_name: string | null;
  }>;
  notes: Array<{
    id: string;
    hospital_name: string | null;
    recorded_at: string;
    title: string | null;
    template: string | null;
    body: string;
    clinician_name: string | null;
  }>;
  documents: Array<{
    id: string;
    hospital_name: string | null;
    report_date: string;
    doc_type: string;
    title: string | null;
    performing_facility: string | null;
    file_count: number;
  }>;
}

/** Everything an export carries. Read in the patient's own context, so row-level security scopes it. */
export async function readExportRecord(
  tx: DbTransaction,
  patientId: string,
): Promise<ExportRecord> {
  const ids = sql`app.patient_record_ids(${patientId}::uuid)`;
  const clinician = (column: string) => sql`app.staff_name_for_patient(${sql.raw(column)})`;
  const time = (column: string) =>
    sql`to_char(${sql.raw(column)} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

  const [patient] = await tx.execute<ExportRecord['patient']>(sql`
    SELECT "id", "name", "gender"::text AS gender, to_char("date_of_birth", 'YYYY-MM-DD') AS "dateOfBirth",
           "approximate_age_years" AS "approximateAgeYears", "blood_group"::text AS "bloodGroup",
           "phone", "emergency_contact_name" AS "emergencyContactName",
           "emergency_contact_phone" AS "emergencyContactPhone"
      FROM "patient" WHERE "id" = ${patientId}::uuid
  `);

  const hospitals = await tx.execute<ExportRecord['hospitals'][number]>(sql`
    SELECT l."hospital_id" AS id, h."name", l."mrn"
      FROM "patient_hospital_link" l
      JOIN "hospital_directory" h ON h."id" = l."hospital_id"
     WHERE l."patient_id" = ANY (${ids})
  ORDER BY l."first_seen_at"
  `);

  const encounters = await tx.execute<ExportRecord['encounters'][number]>(sql`
    SELECT e."id", h."name" AS hospital_name, e."class"::text AS class,
           e."system_of_medicine"::text AS system_of_medicine,
           ${time('e."started_at"')} AS started_at, ${time('e."ended_at"')} AS ended_at,
           e."status"::text AS status, e."chief_complaint",
           ${clinician('e."attending_staff_id"')} AS clinician_name
      FROM "encounter" e
      LEFT JOIN "hospital_directory" h ON h."id" = e."hospital_id"
     WHERE e."patient_id" = ANY (${ids})
  ORDER BY e."started_at"
     LIMIT ${LIMIT}
  `);

  const conditions = await tx.execute<ExportRecord['conditions'][number]>(sql`
    SELECT c."id", h."name" AS hospital_name, ${time('c."recorded_at"')} AS recorded_at,
           c."clinical_status"::text AS clinical_status,
           c."verification_status"::text AS verification_status, c."is_primary", c."note",
           ${clinician('c."attributed_clinician_id"')} AS clinician_name,
           coalesce((
             SELECT json_agg(json_build_object(
                      'role', cc."role", 'system', cc."code_system_key",
                      'code', cc."code", 'display', cc."display") ORDER BY cc."role")
               FROM "condition_coding" cc WHERE cc."condition_id" = c."id"
           ), '[]'::json) AS codings
      FROM "condition" c
      LEFT JOIN "hospital_directory" h ON h."id" = c."hospital_id"
     WHERE c."patient_id" = ANY (${ids}) AND c."version_status" = 'current'
  ORDER BY c."recorded_at"
     LIMIT ${LIMIT}
  `);

  const medications = await tx.execute<ExportRecord['medications'][number]>(sql`
    SELECT r."id", h."name" AS hospital_name, ${time('r."recorded_at"')} AS recorded_at,
           r."medicine_name", r."strength",
           CASE WHEN r."dose_quantity" IS NOT NULL
                THEN trim_scale(r."dose_quantity")::text || ' ' || r."dose_unit" END AS dose,
           r."frequency", r."route"::text AS route,
           CASE WHEN r."duration_value" IS NOT NULL
                THEN r."duration_value" || ' ' || r."duration_unit"::text END AS duration,
           to_char(r."start_date", 'YYYY-MM-DD') AS start_date, r."status"::text AS status,
           r."instructions", ${clinician('r."attributed_clinician_id"')} AS clinician_name
      FROM "medication_request" r
      LEFT JOIN "hospital_directory" h ON h."id" = r."hospital_id"
     WHERE r."patient_id" = ANY (${ids}) AND r."version_status" = 'current'
  ORDER BY r."recorded_at"
     LIMIT ${LIMIT}
  `);

  const allergies = await tx.execute<ExportRecord['allergies'][number]>(sql`
    SELECT a."id", h."name" AS hospital_name, ${time('a."recorded_at"')} AS recorded_at,
           a."substance", a."category"::text AS category, a."criticality"::text AS criticality,
           a."clinical_status"::text AS clinical_status, a."reaction",
           ${clinician('a."attributed_clinician_id"')} AS clinician_name
      FROM "allergy_intolerance" a
      LEFT JOIN "hospital_directory" h ON h."id" = a."hospital_id"
     WHERE a."patient_id" = ANY (${ids}) AND a."version_status" = 'current'
  ORDER BY a."recorded_at"
     LIMIT ${LIMIT}
  `);

  const observations = await tx.execute<ExportRecord['observations'][number]>(sql`
    SELECT o."id", h."name" AS hospital_name, ${time('o."effective_at"')} AS effective_at,
           o."category"::text AS category, o."code", o."code_system", o."display",
           o."value_quantity"::text AS value, o."value_text", o."unit",
           o."interpretation"::text AS interpretation, o."reference_low"::text AS reference_low,
           o."reference_high"::text AS reference_high, o."group_id", o."panel_code"
      FROM "observation" o
      LEFT JOIN "hospital_directory" h ON h."id" = o."hospital_id"
     WHERE o."patient_id" = ANY (${ids}) AND o."version_status" = 'current'
  ORDER BY o."effective_at"
     LIMIT ${LIMIT}
  `);

  const procedures = await tx.execute<ExportRecord['procedures'][number]>(sql`
    SELECT p."id", h."name" AS hospital_name, ${time('p."performed_at"')} AS performed_at,
           p."name", p."outcome", ${clinician('p."attributed_clinician_id"')} AS clinician_name
      FROM "procedure" p
      LEFT JOIN "hospital_directory" h ON h."id" = p."hospital_id"
     WHERE p."patient_id" = ANY (${ids}) AND p."version_status" = 'current'
  ORDER BY p."performed_at"
     LIMIT ${LIMIT}
  `);

  const notes = await tx.execute<ExportRecord['notes'][number]>(sql`
    SELECT n."id", h."name" AS hospital_name, ${time('n."recorded_at"')} AS recorded_at,
           n."title", n."template"::text AS template, n."body",
           ${clinician('n."attributed_clinician_id"')} AS clinician_name
      FROM "clinical_note" n
      LEFT JOIN "hospital_directory" h ON h."id" = n."hospital_id"
     WHERE n."patient_id" = ANY (${ids}) AND n."version_status" = 'current'
  ORDER BY n."recorded_at"
     LIMIT ${LIMIT}
  `);

  const documents = await tx.execute<ExportRecord['documents'][number]>(sql`
    SELECT d."id", h."name" AS hospital_name, to_char(d."report_date", 'YYYY-MM-DD') AS report_date,
           d."doc_type"::text AS doc_type, d."title", d."performing_facility",
           (SELECT count(*)::int FROM "document_file" f WHERE f."document_id" = d."id") AS file_count
      FROM "document_reference" d
      LEFT JOIN "hospital_directory" h ON h."id" = d."hospital_id"
     WHERE d."patient_id" = ANY (${ids}) AND d."version_status" = 'current'
       AND d."availability" = 'available'
  ORDER BY d."report_date"
     LIMIT ${LIMIT}
  `);

  return {
    patient: patient ?? {
      id: patientId,
      name: '',
      gender: '',
      dateOfBirth: null,
      approximateAgeYears: null,
      bloodGroup: null,
      phone: null,
      emergencyContactName: null,
      emergencyContactPhone: null,
    },
    hospitals: [...hospitals],
    encounters: [...encounters],
    conditions: [...conditions],
    medications: [...medications],
    allergies: [...allergies],
    observations: [...observations],
    procedures: [...procedures],
    notes: [...notes],
    documents: [...documents],
  };
}

/** How many entries the export carries, for the patient to see it is their whole record. */
export function countEntries(record: ExportRecord): number {
  return (
    record.encounters.length +
    record.conditions.length +
    record.medications.length +
    record.allergies.length +
    record.observations.length +
    record.procedures.length +
    record.notes.length +
    record.documents.length
  );
}
