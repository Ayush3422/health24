import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  doublePrecision,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { v7 as uuidv7 } from 'uuid';
import { hospitals } from './hospitals';
import { patients } from './patients';
import { staffUsers } from './staff';
import { conceptMapElements } from './terminology';
import {
  allergyCategoryEnum,
  allergyClinicalStatusEnum,
  allergyCriticalityEnum,
  clinicalDataCategoryEnum,
  codingRoleEnum,
  conditionClinicalStatusEnum,
  conditionVerificationStatusEnum,
  consentCaptureMethodEnum,
  consentPurposeEnum,
  consentStatusEnum,
  durationUnitEnum,
  encounterClassEnum,
  encounterStatusEnum,
  foodTimingEnum,
  mapEquivalenceEnum,
  medicationRequestStatusEnum,
  medicationRouteEnum,
  systemOfMedicineEnum,
  versionStatusEnum,
} from './enums';

/**
 * The clinical record.
 *
 * Every table here is owned by one hospital and scoped to it by row-level
 * security. Another hospital sees a row only where an active consent artefact
 * covers it — enforced by the policies in migration 0008, not by the services.
 *
 * Three rules hold across all of them, each enforced by the database:
 *
 *   1. Nothing is edited and nothing is deleted. A correction is a new row
 *      whose `supersedes_id` points at the old one; a mistake is marked
 *      `entered_in_error`. What a clinician recorded, and when, survives.
 *
 *   2. A row cannot be attributed to another hospital's encounter, patient
 *      record or staff. Composite foreign keys carry the hospital through
 *      every reference, so the database refuses the inconsistency rather than
 *      trusting every writer to check it.
 *
 *   3. Only the owning hospital corrects its own record. A superseding row
 *      must share the original's patient and hospital.
 */

/** Primary key with a database default as well as the application's UUIDv7. */
const primaryId = () =>
  uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`)
    .$defaultFn(uuidv7);

const ownership = () => ({
  patientId: uuid('patient_id')
    .notNull()
    .references(() => patients.id, { onDelete: 'restrict' }),
  hospitalId: uuid('hospital_id')
    .notNull()
    .references(() => hospitals.id, { onDelete: 'restrict' }),
});

/**
 * Versioning columns shared by every correctable clinical entry.
 *
 * `status_changed_*` describe the moment the row stopped being current, and
 * why. They are set once, when that happens, and never again.
 */
const versioning = () => ({
  recordedByStaffId: uuid('recorded_by_staff_id').notNull(),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),

  versionStatus: versionStatusEnum('version_status').notNull().default('current'),
  supersedesId: uuid('supersedes_id'),

  statusChangedAt: timestamp('status_changed_at', { withTimezone: true }),
  statusChangedByStaffId: uuid('status_changed_by_staff_id'),
  statusReason: text('status_reason'),
});

// ---------------------------------------------------------------------------
// Encounters
// ---------------------------------------------------------------------------

export const encounters = pgTable(
  'encounter',
  {
    id: primaryId(),
    ...ownership(),

    class: encounterClassEnum('class').notNull(),
    /** Carried on the encounter so the timeline can separate systems without inference. */
    systemOfMedicine: systemOfMedicineEnum('system_of_medicine').notNull(),
    attendingStaffId: uuid('attending_staff_id').notNull(),

    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),

    chiefComplaint: text('chief_complaint'),

    status: encounterStatusEnum('status').notNull().default('in_progress'),
    /** Required when an encounter is cancelled. */
    statusReason: text('status_reason'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('encounter_identity').on(table.id, table.patientId, table.hospitalId),
    foreignKey({
      name: 'encounter_attending_staff_same_hospital_fk',
      columns: [table.attendingStaffId, table.hospitalId],
      foreignColumns: [staffUsers.id, staffUsers.hospitalId],
    }),
    index('encounter_patient_started_idx').on(table.patientId, table.startedAt),
    index('encounter_hospital_started_idx').on(table.hospitalId, table.startedAt),
  ],
);

export type Encounter = typeof encounters.$inferSelect;

// ---------------------------------------------------------------------------
// Diagnoses
// ---------------------------------------------------------------------------

export const conditions = pgTable(
  'condition',
  {
    id: primaryId(),
    ...ownership(),
    encounterId: uuid('encounter_id').notNull(),

    clinicalStatus: conditionClinicalStatusEnum('clinical_status').notNull().default('active'),
    verificationStatus: conditionVerificationStatusEnum('verification_status')
      .notNull()
      .default('confirmed'),
    /** The main diagnosis of the encounter, as distinct from secondary findings. */
    isPrimary: boolean('is_primary').notNull().default(false),
    onsetDate: date('onset_date'),
    note: text('note'),

    ...versioning(),
  },
  (table) => [
    unique('condition_identity').on(table.id, table.patientId, table.hospitalId),
    unique('condition_supersedes_once').on(table.supersedesId),
    foreignKey({
      name: 'condition_encounter_same_record_fk',
      columns: [table.encounterId, table.patientId, table.hospitalId],
      foreignColumns: [encounters.id, encounters.patientId, encounters.hospitalId],
    }),
    foreignKey({
      name: 'condition_supersedes_same_record_fk',
      columns: [table.supersedesId, table.patientId, table.hospitalId],
      foreignColumns: [table.id, table.patientId, table.hospitalId],
    }),
    foreignKey({
      name: 'condition_recorded_by_same_hospital_fk',
      columns: [table.recordedByStaffId, table.hospitalId],
      foreignColumns: [staffUsers.id, staffUsers.hospitalId],
    }),
    foreignKey({
      name: 'condition_status_changed_by_fk',
      columns: [table.statusChangedByStaffId],
      foreignColumns: [staffUsers.id],
    }),
    index('condition_patient_idx').on(table.patientId, table.recordedAt),
    index('condition_encounter_idx').on(table.encounterId),
  ],
);

export type Condition = typeof conditions.$inferSelect;

/**
 * The codings attached to a diagnosis, written once when it is recorded.
 *
 * A snapshot, deliberately. If a mapping is later retired or corrected, the
 * diagnosis still shows exactly what was attached, from which release, on the
 * strength of which approved mapping — never a silently re-derived answer.
 */
export const conditionCodings = pgTable(
  'condition_coding',
  {
    id: primaryId(),
    conditionId: uuid('condition_id')
      .notNull()
      .references(() => conditions.id, { onDelete: 'restrict' }),

    role: codingRoleEnum('role').notNull(),

    codeSystemKey: text('code_system_key').notNull(),
    codeSystemVersion: text('code_system_version').notNull(),
    code: text('code').notNull(),
    display: text('display').notNull(),

    /** Null for the clinician's own selection; set for anything attached from a map. */
    equivalence: mapEquivalenceEnum('equivalence'),
    confidence: doublePrecision('confidence'),
    conceptMapElementId: uuid('concept_map_element_id').references(() => conceptMapElements.id, {
      onDelete: 'restrict',
    }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('condition_coding_one_per_role').on(table.conditionId, table.role),
    index('condition_coding_code_idx').on(table.codeSystemKey, table.code),
    index('condition_coding_map_element_idx').on(table.conceptMapElementId),
  ],
);

export type ConditionCoding = typeof conditionCodings.$inferSelect;

// ---------------------------------------------------------------------------
// Prescriptions
// ---------------------------------------------------------------------------

/**
 * A prescribed medicine, Ayurvedic or allopathic, in structured fields.
 *
 * The medicine name is free text with an optional coding slot (Decision B1):
 * no standard catalogue of Ayurvedic formulations exists to code against yet.
 * Everything else is structured, so "what is this patient currently taking"
 * can be answered without reading prose.
 */
export const medicationRequests = pgTable(
  'medication_request',
  {
    id: primaryId(),
    ...ownership(),
    encounterId: uuid('encounter_id').notNull(),

    systemOfMedicine: systemOfMedicineEnum('system_of_medicine').notNull(),

    medicineName: text('medicine_name').notNull(),
    /** Reserved for the formulary. Both or neither. */
    medicineCodeSystem: text('medicine_code_system'),
    medicineCode: text('medicine_code'),

    /** Tablet, syrup, churna, kashayam, vati. */
    form: text('form'),
    strength: text('strength'),

    doseQuantity: numeric('dose_quantity', { precision: 10, scale: 3 }),
    doseUnit: text('dose_unit'),
    /** As written: `1-0-1`, `twice daily`, `SOS`. */
    frequency: text('frequency').notNull(),
    route: medicationRouteEnum('route').notNull(),

    durationValue: integer('duration_value'),
    durationUnit: durationUnitEnum('duration_unit'),
    startDate: date('start_date')
      .notNull()
      .default(sql`CURRENT_DATE`),

    /** The medium a medicine is taken with — anupana: warm water, honey, ghee, milk. */
    vehicle: text('vehicle'),
    foodTiming: foodTimingEnum('food_timing'),
    instructions: text('instructions'),

    status: medicationRequestStatusEnum('status').notNull().default('active'),
    /** Set once, when a medicine is stopped or its course completed. */
    endedAt: timestamp('ended_at', { withTimezone: true }),
    endedByStaffId: uuid('ended_by_staff_id'),
    endReason: text('end_reason'),

    ...versioning(),
  },
  (table) => [
    unique('medication_request_identity').on(table.id, table.patientId, table.hospitalId),
    unique('medication_request_supersedes_once').on(table.supersedesId),
    foreignKey({
      name: 'medication_request_encounter_same_record_fk',
      columns: [table.encounterId, table.patientId, table.hospitalId],
      foreignColumns: [encounters.id, encounters.patientId, encounters.hospitalId],
    }),
    foreignKey({
      name: 'medication_request_supersedes_same_record_fk',
      columns: [table.supersedesId, table.patientId, table.hospitalId],
      foreignColumns: [table.id, table.patientId, table.hospitalId],
    }),
    foreignKey({
      name: 'medication_request_recorded_by_same_hospital_fk',
      columns: [table.recordedByStaffId, table.hospitalId],
      foreignColumns: [staffUsers.id, staffUsers.hospitalId],
    }),
    foreignKey({
      name: 'medication_request_status_changed_by_fk',
      columns: [table.statusChangedByStaffId],
      foreignColumns: [staffUsers.id],
    }),
    foreignKey({
      name: 'medication_request_ended_by_fk',
      columns: [table.endedByStaffId],
      foreignColumns: [staffUsers.id],
    }),
    index('medication_request_patient_idx').on(table.patientId, table.startDate),
    index('medication_request_encounter_idx').on(table.encounterId),
  ],
);

export type MedicationRequest = typeof medicationRequests.$inferSelect;

// ---------------------------------------------------------------------------
// Allergies
// ---------------------------------------------------------------------------

export const allergyIntolerances = pgTable(
  'allergy_intolerance',
  {
    id: primaryId(),
    ...ownership(),
    /** Optional: an allergy is often reported at the desk, outside any consultation. */
    encounterId: uuid('encounter_id'),

    substance: text('substance').notNull(),
    category: allergyCategoryEnum('category').notNull(),
    criticality: allergyCriticalityEnum('criticality').notNull().default('unable_to_assess'),
    clinicalStatus: allergyClinicalStatusEnum('clinical_status').notNull().default('active'),
    reaction: text('reaction'),
    note: text('note'),

    ...versioning(),
  },
  (table) => [
    unique('allergy_intolerance_identity').on(table.id, table.patientId, table.hospitalId),
    unique('allergy_intolerance_supersedes_once').on(table.supersedesId),
    foreignKey({
      name: 'allergy_intolerance_encounter_same_record_fk',
      columns: [table.encounterId, table.patientId, table.hospitalId],
      foreignColumns: [encounters.id, encounters.patientId, encounters.hospitalId],
    }),
    foreignKey({
      name: 'allergy_intolerance_supersedes_same_record_fk',
      columns: [table.supersedesId, table.patientId, table.hospitalId],
      foreignColumns: [table.id, table.patientId, table.hospitalId],
    }),
    foreignKey({
      name: 'allergy_intolerance_recorded_by_same_hospital_fk',
      columns: [table.recordedByStaffId, table.hospitalId],
      foreignColumns: [staffUsers.id, staffUsers.hospitalId],
    }),
    foreignKey({
      name: 'allergy_intolerance_status_changed_by_fk',
      columns: [table.statusChangedByStaffId],
      foreignColumns: [staffUsers.id],
    }),
    index('allergy_intolerance_patient_idx').on(table.patientId),
  ],
);

export type AllergyIntolerance = typeof allergyIntolerances.$inferSelect;

// ---------------------------------------------------------------------------
// Observations
// ---------------------------------------------------------------------------

/**
 * A measurement: a vital sign now, structured lab values in SP4.
 *
 * A blood pressure is two observations (systolic, diastolic) sharing a
 * `group_id`, following LOINC, rather than a string like "120/80" that nothing
 * can chart.
 */
export const observations = pgTable(
  'observation',
  {
    id: primaryId(),
    ...ownership(),
    encounterId: uuid('encounter_id'),

    codeSystem: text('code_system').notNull(),
    code: text('code').notNull(),
    display: text('display').notNull(),

    /** Exactly one of these is set. */
    valueQuantity: numeric('value_quantity', { precision: 12, scale: 4 }),
    valueText: text('value_text'),
    unit: text('unit'),

    groupId: uuid('group_id'),
    effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull(),

    ...versioning(),
  },
  (table) => [
    unique('observation_identity').on(table.id, table.patientId, table.hospitalId),
    unique('observation_supersedes_once').on(table.supersedesId),
    foreignKey({
      name: 'observation_encounter_same_record_fk',
      columns: [table.encounterId, table.patientId, table.hospitalId],
      foreignColumns: [encounters.id, encounters.patientId, encounters.hospitalId],
    }),
    foreignKey({
      name: 'observation_supersedes_same_record_fk',
      columns: [table.supersedesId, table.patientId, table.hospitalId],
      foreignColumns: [table.id, table.patientId, table.hospitalId],
    }),
    foreignKey({
      name: 'observation_recorded_by_same_hospital_fk',
      columns: [table.recordedByStaffId, table.hospitalId],
      foreignColumns: [staffUsers.id, staffUsers.hospitalId],
    }),
    foreignKey({
      name: 'observation_status_changed_by_fk',
      columns: [table.statusChangedByStaffId],
      foreignColumns: [staffUsers.id],
    }),
    index('observation_patient_effective_idx').on(table.patientId, table.effectiveAt),
    index('observation_patient_code_idx').on(table.patientId, table.code),
  ],
);

export type Observation = typeof observations.$inferSelect;

// ---------------------------------------------------------------------------
// Notes and procedures
// ---------------------------------------------------------------------------

export const clinicalNotes = pgTable(
  'clinical_note',
  {
    id: primaryId(),
    ...ownership(),
    encounterId: uuid('encounter_id').notNull(),

    /** The department template the note was written against. */
    template: text('template').notNull(),
    title: text('title'),
    body: text('body').notNull(),

    ...versioning(),
  },
  (table) => [
    unique('clinical_note_identity').on(table.id, table.patientId, table.hospitalId),
    unique('clinical_note_supersedes_once').on(table.supersedesId),
    foreignKey({
      name: 'clinical_note_encounter_same_record_fk',
      columns: [table.encounterId, table.patientId, table.hospitalId],
      foreignColumns: [encounters.id, encounters.patientId, encounters.hospitalId],
    }),
    foreignKey({
      name: 'clinical_note_supersedes_same_record_fk',
      columns: [table.supersedesId, table.patientId, table.hospitalId],
      foreignColumns: [table.id, table.patientId, table.hospitalId],
    }),
    foreignKey({
      name: 'clinical_note_recorded_by_same_hospital_fk',
      columns: [table.recordedByStaffId, table.hospitalId],
      foreignColumns: [staffUsers.id, staffUsers.hospitalId],
    }),
    foreignKey({
      name: 'clinical_note_status_changed_by_fk',
      columns: [table.statusChangedByStaffId],
      foreignColumns: [staffUsers.id],
    }),
    index('clinical_note_patient_idx').on(table.patientId, table.recordedAt),
    index('clinical_note_encounter_idx').on(table.encounterId),
  ],
);

export type ClinicalNote = typeof clinicalNotes.$inferSelect;

/** Surgery, a biomedical procedure, or a therapy such as a Panchakarma session. */
export const procedures = pgTable(
  'procedure',
  {
    id: primaryId(),
    ...ownership(),
    encounterId: uuid('encounter_id').notNull(),

    systemOfMedicine: systemOfMedicineEnum('system_of_medicine').notNull(),

    name: text('name').notNull(),
    /** Optional, both or neither. */
    codeSystem: text('code_system'),
    code: text('code'),

    performedAt: timestamp('performed_at', { withTimezone: true }).notNull(),
    performerStaffId: uuid('performer_staff_id').notNull(),
    outcome: text('outcome'),
    notes: text('notes'),

    ...versioning(),
  },
  (table) => [
    unique('procedure_identity').on(table.id, table.patientId, table.hospitalId),
    unique('procedure_supersedes_once').on(table.supersedesId),
    foreignKey({
      name: 'procedure_encounter_same_record_fk',
      columns: [table.encounterId, table.patientId, table.hospitalId],
      foreignColumns: [encounters.id, encounters.patientId, encounters.hospitalId],
    }),
    foreignKey({
      name: 'procedure_supersedes_same_record_fk',
      columns: [table.supersedesId, table.patientId, table.hospitalId],
      foreignColumns: [table.id, table.patientId, table.hospitalId],
    }),
    foreignKey({
      name: 'procedure_performer_same_hospital_fk',
      columns: [table.performerStaffId, table.hospitalId],
      foreignColumns: [staffUsers.id, staffUsers.hospitalId],
    }),
    foreignKey({
      name: 'procedure_recorded_by_same_hospital_fk',
      columns: [table.recordedByStaffId, table.hospitalId],
      foreignColumns: [staffUsers.id, staffUsers.hospitalId],
    }),
    foreignKey({
      name: 'procedure_status_changed_by_fk',
      columns: [table.statusChangedByStaffId],
      foreignColumns: [staffUsers.id],
    }),
    index('procedure_patient_performed_idx').on(table.patientId, table.performedAt),
  ],
);

export type Procedure = typeof procedures.$inferSelect;

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

/**
 * Permission for one hospital to read another hospital's clinical record of
 * a patient (Decision A1).
 *
 * Recorded by staff at the **grantee** hospital, with the patient in front of
 * them: it is the hospital asking to see the history that must ask the
 * patient. The hospital that holds the record never sees the patient again,
 * so it cannot be the one to ask. SP5 adds patient-granted artefacts to the
 * same table.
 *
 * Content is immutable. The only change an artefact admits is revocation.
 * Expiry is a timestamp rather than a status, so an artefact lapses without
 * anyone having to remember to lapse it.
 */
export const consentArtefacts = pgTable(
  'consent_artefact',
  {
    id: primaryId(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    granteeHospitalId: uuid('grantee_hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'restrict' }),

    purpose: consentPurposeEnum('purpose').notNull().default('care_management'),
    dataCategories: clinicalDataCategoryEnum('data_categories').array().notNull(),

    /** The clinical dates covered, inclusive, in India Standard Time. Null is unbounded. */
    dateRangeFrom: date('date_range_from'),
    dateRangeTo: date('date_range_to'),

    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),

    captureMethod: consentCaptureMethodEnum('capture_method').notNull(),
    /** Required for verbal consent: the person who heard the patient agree. */
    witnessName: text('witness_name'),
    recordedByStaffId: uuid('recorded_by_staff_id').notNull(),

    status: consentStatusEnum('status').notNull().default('active'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedByStaffId: uuid('revoked_by_staff_id').references(() => staffUsers.id),
    revocationReason: text('revocation_reason'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'consent_artefact_recorded_by_grantee_staff_fk',
      columns: [table.recordedByStaffId, table.granteeHospitalId],
      foreignColumns: [staffUsers.id, staffUsers.hospitalId],
    }),
    index('consent_artefact_patient_grantee_idx').on(table.patientId, table.granteeHospitalId),
  ],
);

export type ConsentArtefact = typeof consentArtefacts.$inferSelect;

/**
 * Which patient record a merged record now lives under.
 *
 * Clinical rows keep the patient id they were recorded against — rewriting
 * them on merge would break both immutability and reversibility. Instead,
 * consent and the timeline resolve ids through this table.
 *
 * Holds identifiers only, no personal data, so it can be readable by every
 * hospital; row-level security confines writes to the merge itself. The
 * existing merge log cannot serve, because it carries a snapshot of personal
 * data and is visible in system context alone.
 */
export const patientMergeAliases = pgTable(
  'patient_merge_alias',
  {
    mergedPatientId: uuid('merged_patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    survivingPatientId: uuid('surviving_patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.mergedPatientId] }),
    index('patient_merge_alias_surviving_idx').on(table.survivingPatientId),
  ],
);
