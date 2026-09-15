import { sql } from 'drizzle-orm';
import {
  date,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { v7 as uuidv7 } from 'uuid';
import { PORTAL_RELATIONSHIPS, type Address } from '@health24/shared';
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

/**
 * A phone number that may sign in to the patient portal (SP5, Decision J1).
 *
 * The account is the phone, not a patient: a family sharing one phone has one
 * account acting for several patients, each activated in person at a desk.
 * No password — patients sign in with a one-time code (planning.md D12).
 */
export const patientAccounts = pgTable('patient_account', {
  id: uuid('id').primaryKey().$defaultFn(uuidv7),
  /** E.164. */
  phone: text('phone').notNull().unique(),
  status: userStatusEnum('status').notNull().default('active'),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const portalRelationshipEnum = pgEnum('portal_relationship', PORTAL_RELATIONSHIPS);

/**
 * A patient an account may act for: activated at a hospital desk by staff who
 * saw the patient, and revocable by any hospital the patient is linked to.
 * A guardian's access to a child ends at the child's 18th birthday (Decision M1).
 */
export const patientPortalAccess = pgTable(
  'patient_portal_access',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`)
      .$defaultFn(uuidv7),
    accountId: uuid('account_id')
      .notNull()
      .references(() => patientAccounts.id, { onDelete: 'restrict' }),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    /** The account's phone, copied, so the desk never reads the account table. */
    phone: text('phone').notNull(),
    relationship: portalRelationshipEnum('relationship').notNull().default('self'),

    activatedAtHospitalId: uuid('activated_at_hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'restrict' }),
    activatedByStaffId: uuid('activated_by_staff_id').notNull(),
    activatedAt: timestamp('activated_at', { withTimezone: true }).notNull().defaultNow(),
    endsAt: timestamp('ends_at', { withTimezone: true }),

    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedByStaffId: uuid('revoked_by_staff_id'),
    revokedReason: text('revoked_reason'),
  },
  (table) => [
    foreignKey({
      name: 'patient_portal_access_activated_by_same_hospital_fk',
      columns: [table.activatedByStaffId, table.activatedAtHospitalId],
      foreignColumns: [staffUsers.id, staffUsers.hospitalId],
    }),
    foreignKey({
      name: 'patient_portal_access_revoked_by_fk',
      columns: [table.revokedByStaffId],
      foreignColumns: [staffUsers.id],
    }),
    index('patient_portal_access_account_idx').on(table.accountId),
    index('patient_portal_access_patient_idx').on(table.patientId),
    uniqueIndex('patient_portal_access_active_once')
      .on(table.accountId, table.patientId)
      .where(sql`"revoked_at" IS NULL`),
  ],
);

export type PatientPortalAccess = typeof patientPortalAccess.$inferSelect;

/** A one-time sign-in code, stored only as a keyed hash. */
export const otpChallenges = pgTable(
  'otp_challenge',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`)
      .$defaultFn(uuidv7),
    phone: text('phone').notNull(),
    codeHash: text('code_hash').notNull(),
    attempts: integer('attempts').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    ipAddress: text('ip_address'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('otp_challenge_phone_idx').on(table.phone, table.createdAt)],
);

/**
 * A portal session, for one patient at a time. Refresh tokens are opaque and
 * stored as a hash, rotated on use and revocable, as for staff.
 */
export const patientSessions = pgTable(
  'patient_session',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`)
      .$defaultFn(uuidv7),
    accountId: uuid('account_id')
      .notNull()
      .references(() => patientAccounts.id, { onDelete: 'restrict' }),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    refreshTokenHash: text('refresh_token_hash').notNull().unique(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason'),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
  },
  (table) => [index('patient_session_account_idx').on(table.accountId)],
);

/**
 * A patient's emergency card (SP5, Decision L1): the facts they choose to
 * carry, and the link its QR code opens without signing in.
 *
 * The link's token is looked up by its hash, and kept encrypted so the patient
 * can print the card again without replacing it. One card is in use per
 * patient at most; a new link is a new card, and replacing a card revokes the
 * old link.
 */
export const emergencyCards = pgTable(
  'emergency_card',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`)
      .$defaultFn(uuidv7),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    tokenHash: text('token_hash').notNull().unique(),
    tokenEncrypted: text('token_encrypted').notNull(),
    /** EMERGENCY_CARD_FIELDS, as the patient chose them. */
    fields: text('fields').array().notNull(),
    createdByAccountId: uuid('created_by_account_id')
      .notNull()
      .references(() => patientAccounts.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedByAccountId: uuid('revoked_by_account_id').references(() => patientAccounts.id, {
      onDelete: 'restrict',
    }),
  },
  (table) => [
    index('emergency_card_patient_idx').on(table.patientId),
    uniqueIndex('emergency_card_one_in_use')
      .on(table.patientId)
      .where(sql`"revoked_at" IS NULL`),
  ],
);

export type EmergencyCard = typeof emergencyCards.$inferSelect;

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
