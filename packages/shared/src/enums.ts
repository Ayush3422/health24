/**
 * Domain enumerations shared between the API and the clients.
 *
 * These are the vocabulary of the system. They are defined once here and
 * imported everywhere; the database enum types are generated to match.
 */

/**
 * The system of medicine a clinician practises, an encounter took place under,
 * or a prescription belongs to.
 *
 * Present on staff, encounters and prescriptions so the timeline can separate
 * traditional from biomedical care visually, without inference.
 */
export const SYSTEMS_OF_MEDICINE = [
  'ayurveda',
  'siddha',
  'unani',
  'yoga_naturopathy',
  'homeopathy',
  'allopathy',
] as const;
export type SystemOfMedicine = (typeof SYSTEMS_OF_MEDICINE)[number];

/** What kind of facility a hospital tenant is. */
export const FACILITY_TYPES = ['allopathic', 'ayush', 'integrated'] as const;
export type FacilityType = (typeof FACILITY_TYPES)[number];

/**
 * Staff roles. Deliberately few and fixed — a configurable permission system is
 * a liability in a clinical product, because nobody can then reason about who
 * can see what.
 *
 * - platform_admin: Health24 staff. Onboards hospitals, manages terminology
 *                   releases. Cannot read clinical data.
 * - hospital_admin: Manages staff and settings for one hospital. Cannot read
 *                   clinical data.
 * - clinician:      Reads and writes clinical data for their hospital.
 * - front_desk:     Registers patients and uploads documents. Cannot read
 *                   clinical notes.
 */
export const STAFF_ROLES = [
  'platform_admin',
  'hospital_admin',
  'clinician',
  'front_desk',
] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

/** Roles that belong to a hospital tenant (everything except platform_admin). */
export const TENANT_ROLES = ['hospital_admin', 'clinician', 'front_desk'] as const;
export type TenantRole = (typeof TENANT_ROLES)[number];

export const USER_STATUSES = ['invited', 'active', 'suspended', 'deactivated'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const HOSPITAL_STATUSES = ['onboarding', 'active', 'suspended', 'offboarded'] as const;
export type HospitalStatus = (typeof HOSPITAL_STATUSES)[number];

/**
 * Administrative sex/gender as recorded for the health record.
 * 'undisclosed' exists because forcing a value produces bad data.
 */
export const GENDERS = ['male', 'female', 'other', 'undisclosed'] as const;
export type Gender = (typeof GENDERS)[number];

export const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', 'unknown'] as const;
export type BloodGroup = (typeof BLOOD_GROUPS)[number];

/** Who performed an audited action. */
export const ACTOR_TYPES = ['staff', 'patient', 'system'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

/**
 * Audited actions. `read` and `search` are logged as deliberately as writes —
 * for PHI that is the requirement, and it is what lets a patient ask who has
 * looked at their file.
 */
export const ACCESS_ACTIONS = [
  'read',
  'search',
  'create',
  'update',
  'delete',
  'export',
  'login',
  'login_failed',
  'logout',
] as const;
export type AccessAction = (typeof ACCESS_ACTIONS)[number];

/** State of a possible duplicate-patient pairing awaiting human review. */
export const MERGE_CANDIDATE_STATUSES = ['pending', 'merged', 'rejected'] as const;
export type MergeCandidateStatus = (typeof MERGE_CANDIDATE_STATUSES)[number];

/** How two patient records came to be linked. */
export const MATCH_METHODS = ['abha_exact', 'probabilistic', 'manual'] as const;
export type MatchMethod = (typeof MATCH_METHODS)[number];
