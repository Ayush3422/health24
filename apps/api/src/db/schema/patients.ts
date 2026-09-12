import {
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { v7 as uuidv7 } from 'uuid';
import type { Address } from '@health24/shared';
import { hospitals } from './hospitals';
import { staffUsers } from './staff';
import {
  bloodGroupEnum,
  genderEnum,
  matchMethodEnum,
  mergeCandidateStatusEnum,
  patientStatusEnum,
  userStatusEnum,
} from './enums';

/**
 * A person.
 *
 * Deliberately NOT tenant-scoped: one human, one row, across every hospital.
 * That global spine is the whole product. Which hospitals may see the row is
 * decided by `patient_hospital_link` (SP1) and, from SP5, by consent.
 */
export const patients = pgTable(
  'patient',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),

    name: text('name').notNull(),

    /**
     * Lowercased, diacritic-stripped, title-stripped form of the name, used
     * only for duplicate detection. Never displayed.
     */
    nameNormalized: text('name_normalized').notNull(),

    gender: genderEnum('gender').notNull(),

    /** Null when the patient does not know it — common, and not a blocker. */
    dateOfBirth: date('date_of_birth'),
    approximateAgeYears: integer('approximate_age_years'),

    /**
     * Derived at write time from whichever of the two above is present, so
     * matching has one number to compare regardless of how age was captured.
     */
    birthYear: integer('birth_year'),

    /** E.164, normalised on input so comparison is reliable. */
    phone: text('phone'),

    abhaNumber: text('abha_number').unique(),
    abhaAddress: text('abha_address').unique(),

    bloodGroup: bloodGroupEnum('blood_group'),
    address: jsonb('address').$type<Address>(),

    emergencyContactName: text('emergency_contact_name'),
    emergencyContactPhone: text('emergency_contact_phone'),

    createdByHospitalId: uuid('created_by_hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'restrict' }),

    status: patientStatusEnum('status').notNull().default('active'),

    /**
     * Set when this record was merged into another. The row is kept as a
     * tombstone rather than deleted, so that old references still resolve and
     * the merge stays reversible.
     */
    mergedIntoPatientId: uuid('merged_into_patient_id'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('patient_phone_idx').on(table.phone),
    index('patient_name_normalized_idx').on(table.nameNormalized),
    index('patient_birth_year_idx').on(table.birthYear),
  ],
);

export type Patient = typeof patients.$inferSelect;
export type NewPatient = typeof patients.$inferInsert;

/**
 * The same human carries a different medical record number at every hospital.
 * This table is what lets each hospital keep seeing its own MRN while the
 * global `patient.id` remains the spine. Without it, hospitals reject the
 * system on day one.
 *
 * It is also the SP1 visibility rule: a hospital may see a patient if and only
 * if a link row exists.
 */
export const patientHospitalLinks = pgTable(
  'patient_hospital_link',
  {
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'cascade' }),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),

    mrn: text('mrn').notNull(),

    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.patientId, table.hospitalId] }),
    unique('patient_hospital_link_mrn_unique').on(table.hospitalId, table.mrn),
    index('patient_hospital_link_hospital_idx').on(table.hospitalId),
  ],
);

export type PatientHospitalLink = typeof patientHospitalLinks.$inferSelect;

/** Patient portal login. Schema lands in SP1; the portal itself is SP5. */
export const patientAccounts = pgTable('patient_account', {
  id: uuid('id').primaryKey().$defaultFn(uuidv7),
  patientId: uuid('patient_id')
    .notNull()
    .unique()
    .references(() => patients.id, { onDelete: 'cascade' }),
  phone: text('phone').notNull().unique(),
  passwordHash: text('password_hash'),
  status: userStatusEnum('status').notNull().default('invited'),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A possible duplicate awaiting human review.
 *
 * Anything the matcher is not certain about lands here rather than being
 * merged. Auto-merging on a fuzzy name match is how a system hands one
 * person's history to another.
 */
export const patientMergeCandidates = pgTable(
  'patient_merge_candidate',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),

    /** Ordered consistently (lower uuid first) so a pair cannot be queued twice. */
    patientAId: uuid('patient_a_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'cascade' }),
    patientBId: uuid('patient_b_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'cascade' }),

    score: doublePrecision('score').notNull(),
    method: matchMethodEnum('method').notNull(),

    /** Which fields agreed — shown to the reviewer to justify the pairing. */
    matchedOn: text('matched_on').array().notNull(),

    status: mergeCandidateStatusEnum('status').notNull().default('pending'),

    /** The hospital whose registration surfaced the pairing. */
    detectedByHospitalId: uuid('detected_by_hospital_id').references(() => hospitals.id),
    detectedAt: timestamp('detected_at', { withTimezone: true }).notNull().defaultNow(),

    resolvedByStaffId: uuid('resolved_by_staff_id').references(() => staffUsers.id),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    decisionReason: text('decision_reason'),
  },
  (table) => [
    unique('patient_merge_candidate_pair_unique').on(table.patientAId, table.patientBId),
    index('patient_merge_candidate_status_idx').on(table.status),
  ],
);

export type PatientMergeCandidate = typeof patientMergeCandidates.$inferSelect;

/**
 * Record of a completed merge, holding enough state to undo it.
 *
 * Merges are performed by humans on incomplete information and will sometimes
 * be wrong. Reversibility is not a nicety here.
 */
export const patientMergeLog = pgTable('patient_merge_log', {
  id: uuid('id').primaryKey().$defaultFn(uuidv7),

  survivingPatientId: uuid('surviving_patient_id')
    .notNull()
    .references(() => patients.id, { onDelete: 'restrict' }),
  mergedPatientId: uuid('merged_patient_id')
    .notNull()
    .references(() => patients.id, { onDelete: 'restrict' }),

  performedByStaffId: uuid('performed_by_staff_id')
    .notNull()
    .references(() => staffUsers.id),
  performedAtHospitalId: uuid('performed_at_hospital_id').references(() => hospitals.id),

  reason: text('reason').notNull(),

  /** Pre-merge state of both records and their links, for reversal. */
  snapshot: jsonb('snapshot').notNull(),

  performedAt: timestamp('performed_at', { withTimezone: true }).notNull().defaultNow(),

  revertedAt: timestamp('reverted_at', { withTimezone: true }),
  revertedByStaffId: uuid('reverted_by_staff_id').references(() => staffUsers.id),
  revertReason: text('revert_reason'),
});

/** Field-level history of demographic corrections. */
export const patientDemographicChanges = pgTable(
  'patient_demographic_change',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'cascade' }),
    changedByStaffId: uuid('changed_by_staff_id')
      .notNull()
      .references(() => staffUsers.id),
    hospitalId: uuid('hospital_id').references(() => hospitals.id),

    field: text('field').notNull(),
    oldValue: text('old_value'),
    newValue: text('new_value'),
    reason: text('reason').notNull(),

    changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('patient_demographic_change_patient_idx').on(table.patientId)],
);
