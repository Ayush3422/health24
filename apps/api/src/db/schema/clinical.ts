import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  date,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
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
import { patientAccounts, patients } from './patients';
import { staffUsers } from './staff';
import { conceptMapElements } from './terminology';
import {
  allergyCategoryEnum,
  allergyClinicalStatusEnum,
  allergyCriticalityEnum,
  breakGlassReviewOutcomeEnum,
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
  entrySourceEnum,
  foodTimingEnum,
  mapEquivalenceEnum,
  medicationRequestStatusEnum,
  medicationRouteEnum,
  observationCategoryEnum,
  observationSourceEnum,
  bedStatusEnum,
  catalogueCategoryEnum,
  chargeSourceEnum,
  chargeStatusEnum,
  dischargeStatusEnum,
  insuranceSchemeEnum,
  ledgerKindEnum,
  paymentMethodEnum,
  resultInterpretationEnum,
  serviceRequestCategoryEnum,
  serviceRequestPriorityEnum,
  serviceRequestStatusEnum,
  systemOfMedicineEnum,
  versionStatusEnum,
  wardKindEnum,
  wardStatusEnum,
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
  /** Who typed the entry: the clinician, or medical records staff transcribing for them. */
  recordedByStaffId: uuid('recorded_by_staff_id').notNull(),
  /**
   * Whose clinical decision this is (Decision C). The recorder, for a direct
   * entry — the database fills it in when left out.
   */
  attributedClinicianId: uuid('attributed_clinician_id').notNull(),
  entrySource: entrySourceEnum('entry_source').notNull().default('direct'),
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
    /** Who opened the encounter: the attending clinician, or records staff for them. */
    recordedByStaffId: uuid('recorded_by_staff_id').notNull(),
    entrySource: entrySourceEnum('entry_source').notNull().default('direct'),

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
    foreignKey({
      name: 'encounter_recorded_by_same_hospital_fk',
      columns: [table.recordedByStaffId, table.hospitalId],
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
      name: 'condition_attributed_clinician_same_hospital_fk',
      columns: [table.attributedClinicianId, table.hospitalId],
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

    /**
     * Why the prescriber went ahead despite a recorded allergy matching this
     * medicine or its vehicle. Null when nothing matched.
     */
    allergyOverrideReason: text('allergy_override_reason'),

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
      name: 'medication_request_attributed_clinician_same_hospital_fk',
      columns: [table.attributedClinicianId, table.hospitalId],
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
      name: 'allergy_intolerance_attributed_clinician_same_hospital_fk',
      columns: [table.attributedClinicianId, table.hospitalId],
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

    /** Vital signs, or lab results typed from a report (SP4). */
    category: observationCategoryEnum('category').notNull().default('vital_signs'),
    source: observationSourceEnum('source').notNull().default('entered'),

    // Lab results only. The report typed from; the panel; the lab's printed
    // range and flag beside the computed comparison; and the value in the
    // analyte's canonical unit, so a trend spans laboratories.
    documentId: uuid('document_id'),
    /** The order this result answers, when it was ordered here (SP6, DF2). */
    serviceRequestId: uuid('service_request_id'),
    panelCode: text('panel_code'),
    referenceLow: numeric('reference_low', { precision: 12, scale: 4 }),
    referenceHigh: numeric('reference_high', { precision: 12, scale: 4 }),
    referenceText: text('reference_text'),
    interpretation: resultInterpretationEnum('interpretation'),
    labFlag: text('lab_flag'),
    valueCanonical: numeric('value_canonical', { precision: 14, scale: 4 }),
    unitCanonical: text('unit_canonical'),
    performingFacility: text('performing_facility'),

    ...versioning(),
    /** A vital sign's clinician. Empty for a lab result, which is nobody's decision (DF7). */
    attributedClinicianId: uuid('attributed_clinician_id'),
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
      name: 'observation_attributed_clinician_same_hospital_fk',
      columns: [table.attributedClinicianId, table.hospitalId],
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
// Orders (SP6, Decision O1)
// ---------------------------------------------------------------------------

/**
 * What somebody asked for, before there was a result.
 *
 * Modelled on FHIR ServiceRequest and owned by the hospital that placed it.
 * Results point back at it — `observation.service_request_id` and
 * `document_reference.service_request_id` — so a lab can be asked what is
 * outstanding and an order can be asked what came back.
 *
 * Unlike the rest of this file it carries no version columns: asking for a
 * test asserts nothing about the patient, so there is nothing to correct. A
 * wrong order is cancelled with a reason and a new one placed, and the status
 * trigger allows only the moves the work itself allows.
 */
export const serviceRequests = pgTable(
  'service_request',
  {
    id: primaryId(),
    ...ownership(),
    encounterId: uuid('encounter_id').notNull(),

    category: serviceRequestCategoryEnum('category').notNull(),
    /** What the clinician would say. Coded where the terminology has it. */
    requestedDisplay: text('requested_display').notNull(),
    requestedCodeSystem: text('requested_code_system'),
    requestedCode: text('requested_code'),
    priority: serviceRequestPriorityEnum('priority').notNull().default('routine'),
    /** Why it was asked for, for whoever performs it. */
    clinicalNote: text('clinical_note'),

    /** Whose clinical decision the order is, and who typed it (Decision C). */
    orderedByStaffId: uuid('ordered_by_staff_id').notNull(),
    recordedByStaffId: uuid('recorded_by_staff_id').notNull(),
    entrySource: entrySourceEnum('entry_source').notNull().default('direct'),
    orderedAt: timestamp('ordered_at', { withTimezone: true }).notNull().defaultNow(),

    status: serviceRequestStatusEnum('status').notNull().default('ordered'),
    /** The lab's own reference for the sample or study. */
    reference: text('reference'),

    /**
     * When each step happened, and who did it. A timestamp per step rather
     * than one `status_changed_at`, because every one of these is set once and
     * never again — which is what the guard trigger can enforce — and because
     * a turnaround-time report is then arithmetic rather than archaeology.
     */
    collectedAt: timestamp('collected_at', { withTimezone: true }),
    collectedByStaffId: uuid('collected_by_staff_id'),
    inProgressAt: timestamp('in_progress_at', { withTimezone: true }),
    inProgressByStaffId: uuid('in_progress_by_staff_id'),
    resultedAt: timestamp('resulted_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelledByStaffId: uuid('cancelled_by_staff_id'),
    /** Required when an order is cancelled, and only then. */
    cancelledReason: text('cancelled_reason'),
  },
  (table) => [
    unique('service_request_identity').on(table.id, table.patientId, table.hospitalId),
    foreignKey({
      name: 'service_request_encounter_same_record_fk',
      columns: [table.encounterId, table.patientId, table.hospitalId],
      foreignColumns: [encounters.id, encounters.patientId, encounters.hospitalId],
    }),
    foreignKey({
      name: 'service_request_ordered_by_same_hospital_fk',
      columns: [table.orderedByStaffId, table.hospitalId],
      foreignColumns: [staffUsers.id, staffUsers.hospitalId],
    }),
    foreignKey({
      name: 'service_request_recorded_by_same_hospital_fk',
      columns: [table.recordedByStaffId, table.hospitalId],
      foreignColumns: [staffUsers.id, staffUsers.hospitalId],
    }),
    index('service_request_patient_idx').on(table.patientId, table.orderedAt),
    index('service_request_worklist_idx').on(table.hospitalId, table.status, table.orderedAt),
  ],
);

export type ServiceRequest = typeof serviceRequests.$inferSelect;

// ---------------------------------------------------------------------------
// Wards, beds and stays (SP6, Decision P1)
// ---------------------------------------------------------------------------

/** A ward is the hospital's own furniture: master data, not a clinical record. */
export const wards = pgTable(
  'ward',
  {
    id: primaryId(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    kind: wardKindEnum('kind').notNull(),
    status: wardStatusEnum('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('ward_identity').on(table.id, table.hospitalId),
    unique('ward_name_per_hospital').on(table.hospitalId, table.name),
  ],
);

export type Ward = typeof wards.$inferSelect;

/**
 * A bed.
 *
 * `status` says whether it may be used at all — available, or out of service.
 * Whether somebody is in it is not stored: an open `bed_stay` is the answer,
 * so the board and the record cannot disagree about who is where.
 */
export const beds = pgTable(
  'bed',
  {
    id: primaryId(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'restrict' }),
    wardId: uuid('ward_id').notNull(),
    label: text('label').notNull(),
    status: bedStatusEnum('status').notNull().default('available'),
    blockedReason: text('blocked_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('bed_identity').on(table.id, table.hospitalId),
    unique('bed_label_per_ward').on(table.wardId, table.label),
    foreignKey({
      name: 'bed_ward_same_hospital_fk',
      columns: [table.wardId, table.hospitalId],
      foreignColumns: [wards.id, wards.hospitalId],
    }),
  ],
);

export type Bed = typeof beds.$inferSelect;

/**
 * One stay in one bed.
 *
 * A transfer ends this stay and starts the next, so an admission's whole
 * history is these rows in order. The database allows one open stay per
 * encounter and one per bed, which is what stops two patients being recorded
 * in the same bed.
 */
export const bedStays = pgTable(
  'bed_stay',
  {
    id: primaryId(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'restrict' }),
    encounterId: uuid('encounter_id').notNull(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    bedId: uuid('bed_id').notNull(),

    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    /** Why the patient was moved out of this bed, or how the stay ended. */
    movedReason: text('moved_reason'),

    startedByStaffId: uuid('started_by_staff_id').notNull(),
    endedByStaffId: uuid('ended_by_staff_id'),
  },
  (table) => [
    foreignKey({
      name: 'bed_stay_bed_same_hospital_fk',
      columns: [table.bedId, table.hospitalId],
      foreignColumns: [beds.id, beds.hospitalId],
    }),
    foreignKey({
      name: 'bed_stay_encounter_same_record_fk',
      columns: [table.encounterId, table.patientId, table.hospitalId],
      foreignColumns: [encounters.id, encounters.patientId, encounters.hospitalId],
    }),
    foreignKey({
      name: 'bed_stay_started_by_same_hospital_fk',
      columns: [table.startedByStaffId, table.hospitalId],
      foreignColumns: [staffUsers.id, staffUsers.hospitalId],
    }),
    index('bed_stay_encounter_idx').on(table.encounterId, table.startedAt),
    index('bed_stay_bed_idx').on(table.bedId, table.startedAt),
  ],
);

export type BedStayRow = typeof bedStays.$inferSelect;

// ---------------------------------------------------------------------------
// Implants and devices (SP6, Decision Q1)
// ---------------------------------------------------------------------------

/**
 * What was put into a patient, and how to find it again.
 *
 * On the encounter rather than the procedure row: a procedure may be corrected
 * into a new version, and the device is a fact about the patient either way.
 * The procedure it belongs to is named on the row as well as pointed at, so
 * the operation survives any correction to it.
 *
 * Kept, like every clinical entry, by superseding rather than editing — a
 * recall a decade from now has to find what was recorded at the time.
 */
export const implantDevices = pgTable(
  'implant_device',
  {
    id: primaryId(),
    ...ownership(),
    encounterId: uuid('encounter_id').notNull(),
    procedureId: uuid('procedure_id'),
    /** Denormalised, so the operation is named even after a correction. */
    procedureName: text('procedure_name'),

    name: text('name').notNull(),
    manufacturer: text('manufacturer'),
    model: text('model'),
    /** The serial number, or the lot a batch came from. */
    serialOrLot: text('serial_or_lot'),
    implantedAt: timestamp('implanted_at', { withTimezone: true }).notNull(),
    notes: text('notes'),

    ...versioning(),
  },
  (table) => [
    unique('implant_device_identity').on(table.id, table.patientId, table.hospitalId),
    unique('implant_device_supersedes_once').on(table.supersedesId),
    foreignKey({
      name: 'implant_device_encounter_same_record_fk',
      columns: [table.encounterId, table.patientId, table.hospitalId],
      foreignColumns: [encounters.id, encounters.patientId, encounters.hospitalId],
    }),
    foreignKey({
      name: 'implant_device_procedure_same_record_fk',
      columns: [table.procedureId, table.patientId, table.hospitalId],
      foreignColumns: [procedures.id, procedures.patientId, procedures.hospitalId],
    }),
    foreignKey({
      name: 'implant_device_supersedes_same_record_fk',
      columns: [table.supersedesId, table.patientId, table.hospitalId],
      foreignColumns: [table.id, table.patientId, table.hospitalId],
    }),
    foreignKey({
      name: 'implant_device_recorded_by_same_hospital_fk',
      columns: [table.recordedByStaffId, table.hospitalId],
      foreignColumns: [staffUsers.id, staffUsers.hospitalId],
    }),
    index('implant_device_patient_idx').on(table.patientId, table.implantedAt),
    index('implant_device_serial_idx').on(table.hospitalId, table.serialOrLot),
  ],
);

export type ImplantDevice = typeof implantDevices.$inferSelect;

// ---------------------------------------------------------------------------
// The discharge summary (SP6, DF6 and DF7)
// ---------------------------------------------------------------------------

/**
 * A summary of an admission, composed from the encounter's own data and signed
 * by a clinician.
 *
 * A draft is not a clinical record: it is a piece of work in progress, and it
 * is edited freely until it is signed. Signing is what makes it a record, and
 * it writes two things that are — a versioned clinical note, and the PDF the
 * patient reads. After that this row never changes again.
 *
 * `composed_from` keeps what the record said at composition, so a summary can
 * always be compared with the record it was drawn from.
 */
export const dischargeSummaries = pgTable(
  'discharge_summary',
  {
    id: primaryId(),
    ...ownership(),
    encounterId: uuid('encounter_id').notNull(),

    status: dischargeStatusEnum('status').notNull().default('draft'),
    /** The sections as they will be signed: `{ key, label, text, composed }`. */
    sections: jsonb('sections')
      .$type<Array<{ key: string; label: string; text: string; composed: boolean }>>()
      .notNull(),
    /** What the record held when it was last composed. */
    composedFrom: jsonb('composed_from').notNull(),
    composedAt: timestamp('composed_at', { withTimezone: true }).notNull().defaultNow(),
    composedByStaffId: uuid('composed_by_staff_id').notNull(),

    signedAt: timestamp('signed_at', { withTimezone: true }),
    signedByStaffId: uuid('signed_by_staff_id'),
    /** Written by the signature: the record, and the copy that is read. */
    clinicalNoteId: uuid('clinical_note_id'),
    documentReferenceId: uuid('document_reference_id'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One summary per admission. A correction after signing is a correction to
    // the note the signature wrote, which versions itself.
    unique('discharge_summary_once_per_encounter').on(table.encounterId),
    foreignKey({
      name: 'discharge_summary_encounter_same_record_fk',
      columns: [table.encounterId, table.patientId, table.hospitalId],
      foreignColumns: [encounters.id, encounters.patientId, encounters.hospitalId],
    }),
    foreignKey({
      name: 'discharge_summary_composed_by_same_hospital_fk',
      columns: [table.composedByStaffId, table.hospitalId],
      foreignColumns: [staffUsers.id, staffUsers.hospitalId],
    }),
    foreignKey({
      name: 'discharge_summary_signed_by_same_hospital_fk',
      columns: [table.signedByStaffId, table.hospitalId],
      foreignColumns: [staffUsers.id, staffUsers.hospitalId],
    }),
    index('discharge_summary_patient_idx').on(table.patientId, table.composedAt),
  ],
);

export type DischargeSummaryRow = typeof dischargeSummaries.$inferSelect;

// ---------------------------------------------------------------------------
// The service catalogue and its charges (SP6, Decision R1)
// ---------------------------------------------------------------------------

/**
 * What a hospital charges for, and what it costs.
 *
 * A price is never overwritten. Changing one closes the row in force and opens
 * a new one for the same code, so an invoice raised last month can still be
 * read against the price that stood then. `active_to` is exclusive of nothing:
 * it is the last day the price applies.
 *
 * Money is integer paise (DF3). Nothing in this file is a floating-point
 * number, and nothing ever will be.
 */
export const catalogueItems = pgTable(
  'service_catalogue_item',
  {
    id: primaryId(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'restrict' }),

    /** The hospital's own code, as its price list is written. */
    code: text('code').notNull(),
    name: text('name').notNull(),
    category: catalogueCategoryEnum('category').notNull(),
    /** What one of it is: a visit, a test, a day, a dressing. */
    unit: text('unit').notNull().default('each'),
    pricePaise: bigint('price_paise', { mode: 'number' }).notNull(),

    activeFrom: date('active_from').notNull(),
    /** The last day this price applies. Null while it is the one in force. */
    activeTo: date('active_to'),

    createdByStaffId: uuid('created_by_staff_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('service_catalogue_item_identity').on(table.id, table.hospitalId),
    unique('service_catalogue_item_price_period').on(table.hospitalId, table.code, table.activeFrom),
    foreignKey({
      name: 'service_catalogue_item_created_by_same_hospital_fk',
      columns: [table.createdByStaffId, table.hospitalId],
      foreignColumns: [staffUsers.id, staffUsers.hospitalId],
    }),
    index('service_catalogue_item_code_idx').on(table.hospitalId, table.code),
  ],
);

export type CatalogueItemRow = typeof catalogueItems.$inferSelect;

/**
 * One line of what a patient owes.
 *
 * The unit price is copied at capture, not looked up later: what somebody was
 * charged is a fact about that day, and a price change next month must not
 * rewrite it. The amount is checked against quantity × unit price by the
 * database, so the two can never drift apart.
 *
 * A charge may be voided while nobody has been billed for it. Once it is on an
 * invoice it belongs to the invoice, and the money trail is append-only from
 * there (DF4).
 */
export const charges = pgTable(
  'charge',
  {
    id: primaryId(),
    ...ownership(),
    encounterId: uuid('encounter_id').notNull(),
    itemId: uuid('item_id').notNull(),

    quantity: integer('quantity').notNull().default(1),
    unitPricePaise: bigint('unit_price_paise', { mode: 'number' }).notNull(),
    amountPaise: bigint('amount_paise', { mode: 'number' }).notNull(),

    source: chargeSourceEnum('source').notNull().default('manual'),
    /** The order, procedure or bed stay it is for, when it is for one. */
    sourceId: uuid('source_id'),
    note: text('note'),

    status: chargeStatusEnum('status').notNull().default('captured'),
    capturedByStaffId: uuid('captured_by_staff_id').notNull(),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),

    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidedByStaffId: uuid('voided_by_staff_id'),
    voidedReason: text('voided_reason'),

    /** Set when the charge is put on an invoice (Phase 7). */
    invoiceId: uuid('invoice_id'),
  },
  (table) => [
    unique('charge_identity').on(table.id, table.patientId, table.hospitalId),
    foreignKey({
      name: 'charge_encounter_same_record_fk',
      columns: [table.encounterId, table.patientId, table.hospitalId],
      foreignColumns: [encounters.id, encounters.patientId, encounters.hospitalId],
    }),
    foreignKey({
      name: 'charge_item_same_hospital_fk',
      columns: [table.itemId, table.hospitalId],
      foreignColumns: [catalogueItems.id, catalogueItems.hospitalId],
    }),
    foreignKey({
      name: 'charge_captured_by_same_hospital_fk',
      columns: [table.capturedByStaffId, table.hospitalId],
      foreignColumns: [staffUsers.id, staffUsers.hospitalId],
    }),
    index('charge_encounter_idx').on(table.encounterId, table.capturedAt),
    index('charge_invoice_idx').on(table.invoiceId),
  ],
);

export type ChargeRow = typeof charges.$inferSelect;

// ---------------------------------------------------------------------------
// Invoices and the money ledger (SP6, Decision R1, DF4)
// ---------------------------------------------------------------------------

/**
 * The next invoice number, per hospital and financial year.
 *
 * A Postgres sequence would be wrong here: it does not roll back, so a failed
 * transaction would leave a hole in the numbering, and a gap in an invoice
 * series is exactly what a tax officer asks about. This is a row that is
 * locked and incremented inside the same transaction that writes the invoice,
 * so either both happen or neither does.
 */
export const invoiceNumberSeries = pgTable(
  'invoice_number_series',
  {
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'restrict' }),
    /** As India counts it: 2026-27 runs from 1 April to 31 March. */
    financialYear: text('financial_year').notNull(),
    nextNumber: integer('next_number').notNull().default(1),
  },
  (table) => [primaryKey({ columns: [table.hospitalId, table.financialYear] })],
);

/**
 * An invoice, which is never edited.
 *
 * There is no paid flag and no status column. What is outstanding is
 * arithmetic over the ledger below, computed when somebody asks — so a stored
 * status can never drift from what was actually paid.
 */
export const invoices = pgTable(
  'invoice',
  {
    id: primaryId(),
    ...ownership(),
    encounterId: uuid('encounter_id').notNull(),

    number: text('number').notNull(),
    financialYear: text('financial_year').notNull(),
    totalPaise: bigint('total_paise', { mode: 'number' }).notNull(),
    note: text('note'),

    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    issuedByStaffId: uuid('issued_by_staff_id').notNull(),
    /** The PDF of it in the patient's own reports (DF8). */
    documentReferenceId: uuid('document_reference_id'),
  },
  (table) => [
    unique('invoice_identity').on(table.id, table.patientId, table.hospitalId),
    // What the lines, the ledger and the insurance rows point at.
    unique('invoice_hospital_identity').on(table.id, table.hospitalId),
    unique('invoice_number_once').on(table.hospitalId, table.number),
    foreignKey({
      name: 'invoice_encounter_same_record_fk',
      columns: [table.encounterId, table.patientId, table.hospitalId],
      foreignColumns: [encounters.id, encounters.patientId, encounters.hospitalId],
    }),
    foreignKey({
      name: 'invoice_issued_by_same_hospital_fk',
      columns: [table.issuedByStaffId, table.hospitalId],
      foreignColumns: [staffUsers.id, staffUsers.hospitalId],
    }),
    index('invoice_patient_idx').on(table.patientId, table.issuedAt),
    index('invoice_hospital_idx').on(table.hospitalId, table.issuedAt),
  ],
);

export type InvoiceRow = typeof invoices.$inferSelect;

/** One line of an invoice: a charge as it stood when the invoice was issued. */
export const invoiceLines = pgTable(
  'invoice_line',
  {
    id: primaryId(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'restrict' }),
    invoiceId: uuid('invoice_id').notNull(),
    chargeId: uuid('charge_id').notNull(),

    code: text('code').notNull(),
    description: text('description').notNull(),
    quantity: integer('quantity').notNull(),
    unitPricePaise: bigint('unit_price_paise', { mode: 'number' }).notNull(),
    amountPaise: bigint('amount_paise', { mode: 'number' }).notNull(),
  },
  (table) => [
    unique('invoice_line_charge_once').on(table.chargeId),
    foreignKey({
      name: 'invoice_line_invoice_same_hospital_fk',
      columns: [table.invoiceId, table.hospitalId],
      foreignColumns: [invoices.id, invoices.hospitalId],
    }),
    index('invoice_line_invoice_idx').on(table.invoiceId),
  ],
);

export type InvoiceLineRow = typeof invoiceLines.$inferSelect;

/**
 * The money ledger: added to, never changed.
 *
 * A mistake is another entry — a refund for money taken wrongly, a credit note
 * for an invoice that should not have been raised. Nothing here is ever
 * updated or deleted, which is what makes the trail worth having (DF4).
 */
export const ledgerEntries = pgTable(
  'payment_entry',
  {
    id: primaryId(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'restrict' }),
    invoiceId: uuid('invoice_id').notNull(),

    kind: ledgerKindEnum('kind').notNull(),
    /** How the money moved. Empty on a credit note, which moves none. */
    method: paymentMethodEnum('method'),
    amountPaise: bigint('amount_paise', { mode: 'number' }).notNull(),
    reference: text('reference'),
    note: text('note'),

    takenByStaffId: uuid('taken_by_staff_id').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'payment_entry_invoice_same_hospital_fk',
      columns: [table.invoiceId, table.hospitalId],
      foreignColumns: [invoices.id, invoices.hospitalId],
    }),
    foreignKey({
      name: 'payment_entry_taken_by_same_hospital_fk',
      columns: [table.takenByStaffId, table.hospitalId],
      foreignColumns: [staffUsers.id, staffUsers.hospitalId],
    }),
    index('payment_entry_invoice_idx').on(table.invoiceId, table.at),
  ],
);

export type LedgerEntryRow = typeof ledgerEntries.$inferSelect;

/**
 * What is being claimed from a scheme or an insurer, and what they approved.
 *
 * Captured, never adjudicated: this system does not decide what PM-JAY pays.
 * Added to rather than edited, because an approval often arrives days after
 * the claim, and both are worth keeping. Money actually received arrives as a
 * ledger entry with the `scheme` method.
 */
export const invoiceInsurance = pgTable(
  'invoice_insurance',
  {
    id: primaryId(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'restrict' }),
    invoiceId: uuid('invoice_id').notNull(),

    scheme: insuranceSchemeEnum('scheme').notNull(),
    insurer: text('insurer'),
    policyOrCard: text('policy_or_card'),
    approvedPaise: bigint('approved_paise', { mode: 'number' }),

    recordedByStaffId: uuid('recorded_by_staff_id').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'invoice_insurance_invoice_same_hospital_fk',
      columns: [table.invoiceId, table.hospitalId],
      foreignColumns: [invoices.id, invoices.hospitalId],
    }),
    index('invoice_insurance_invoice_idx').on(table.invoiceId, table.recordedAt),
  ],
);

export type InvoiceInsuranceRow = typeof invoiceInsurance.$inferSelect;

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
    /** The template's sections as written; `body` is the same note composed as text. */
    sections: jsonb('sections').$type<Array<{ key: string; label: string; text: string }>>(),

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
      name: 'clinical_note_attributed_clinician_same_hospital_fk',
      columns: [table.attributedClinicianId, table.hospitalId],
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

    /**
     * The operative record (SP6, Decision Q1). Empty on a therapy session;
     * filled in for an operation, where these four are what a discharge
     * summary and a medico-legal request are built from.
     */
    preOpAssessment: text('pre_op_assessment'),
    anaesthesia: text('anaesthesia'),
    operativeNote: text('operative_note'),
    postOpCourse: text('post_op_course'),

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
      name: 'procedure_attributed_clinician_same_hospital_fk',
      columns: [table.attributedClinicianId, table.hospitalId],
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
    /** Exactly one recorder: a staff member, or the patient in the portal (SP5). */
    recordedByStaffId: uuid('recorded_by_staff_id'),
    recordedByPatientAccountId: uuid('recorded_by_patient_account_id').references(
      () => patientAccounts.id,
    ),

    status: consentStatusEnum('status').notNull().default('active'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedByStaffId: uuid('revoked_by_staff_id').references(() => staffUsers.id),
    revokedByPatientAccountId: uuid('revoked_by_patient_account_id').references(
      () => patientAccounts.id,
    ),
    revocationReason: text('revocation_reason'),

    /** Break-glass only: why emergency access was needed. */
    emergencyReason: text('emergency_reason'),
    /** Break-glass only: the hospital's later review of whether it was justified. */
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewedByStaffId: uuid('reviewed_by_staff_id').references(() => staffUsers.id),
    reviewOutcome: breakGlassReviewOutcomeEnum('review_outcome'),
    reviewNote: text('review_note'),
    /** When the patient was told of the access. Null until the portal can tell them (SP5). */
    patientNotifiedAt: timestamp('patient_notified_at', { withTimezone: true }),

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

/**
 * A clinician's decision to keep a diagnosis's attached code after the mapping
 * it rested on was retired or rejected. Without one, the diagnosis stays in
 * the coding review queue. Correcting the diagnosis instead needs no
 * acknowledgement: the superseded version simply leaves the queue.
 */
export const codingReviewAcknowledgements = pgTable(
  'coding_review_acknowledgement',
  {
    id: primaryId(),
    conditionId: uuid('condition_id')
      .notNull()
      .references(() => conditions.id, { onDelete: 'restrict' }),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'restrict' }),
    conceptMapElementId: uuid('concept_map_element_id')
      .notNull()
      .references(() => conceptMapElements.id, { onDelete: 'restrict' }),
    note: text('note').notNull(),
    acknowledgedByStaffId: uuid('acknowledged_by_staff_id').notNull(),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('coding_review_acknowledgement_once').on(table.conditionId, table.conceptMapElementId),
    foreignKey({
      name: 'coding_review_acknowledgement_by_same_hospital_fk',
      columns: [table.acknowledgedByStaffId, table.hospitalId],
      foreignColumns: [staffUsers.id, staffUsers.hospitalId],
    }),
    index('coding_review_acknowledgement_hospital_idx').on(table.hospitalId),
  ],
);
