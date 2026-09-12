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
 * - platform_admin:      Health24 staff. Onboards hospitals, activates
 *                        terminology releases. Cannot read clinical data, and
 *                        cannot approve mappings — operating the platform is
 *                        not a clinical qualification.
 * - terminology_curator: A qualified traditional-medicine reviewer who
 *                        approves NAMASTE ↔ ICD-11 mappings for the whole
 *                        platform. Belongs to no hospital. Cannot read
 *                        clinical data.
 * - hospital_admin:      Manages staff and settings for one hospital. Cannot
 *                        read clinical data.
 * - clinician:           Reads and writes clinical data for their hospital.
 * - front_desk:          Registers patients and uploads documents. Cannot read
 *                        clinical notes.
 */
export const STAFF_ROLES = [
  'platform_admin',
  'terminology_curator',
  'hospital_admin',
  'clinician',
  'front_desk',
] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

/** Roles that belong to a hospital tenant (everything except platform-level roles). */
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

// ---------------------------------------------------------------------------
// Terminology
// ---------------------------------------------------------------------------

/**
 * Lifecycle of a terminology release. Only one version of a code system is
 * active at a time; retired versions stay resolvable so that records coded
 * against them keep their meaning.
 */
export const CODE_SYSTEM_STATUSES = ['draft', 'active', 'retired'] as const;
export type CodeSystemStatus = (typeof CODE_SYSTEM_STATUSES)[number];

/** How a designation relates to its concept. */
export const DESIGNATION_USES = ['display', 'synonym', 'transliteration'] as const;
export type DesignationUse = (typeof DESIGNATION_USES)[number];

/**
 * How closely a source concept corresponds to a target, following FHIR R4
 * ConceptMap equivalence.
 *
 * - equivalent: same meaning
 * - wider:      the target is broader than the source
 * - narrower:   the target is more specific than the source
 * - inexact:    related, but not a clean correspondence
 * - unmatched:  reviewed, and there is no corresponding target
 *
 * `unmatched` is a finding, not a gap: it records that someone looked.
 */
export const MAP_EQUIVALENCES = [
  'equivalent',
  'wider',
  'narrower',
  'inexact',
  'unmatched',
] as const;
export type MapEquivalence = (typeof MAP_EQUIVALENCES)[number];

/**
 * Review state of a single mapping. Only `approved` mappings are ever attached
 * to a patient's diagnosis.
 */
export const MAP_ELEMENT_STATUSES = ['proposed', 'approved', 'rejected', 'retired'] as const;
export type MapElementStatus = (typeof MAP_ELEMENT_STATUSES)[number];

/** Where a mapping came from. */
export const MAP_PROVENANCES = ['imported', 'curated'] as const;
export type MapProvenance = (typeof MAP_PROVENANCES)[number];

/**
 * How an imported concept map's elements arrive.
 *
 * - authoritative:   from the issuing authority; elements land approved.
 * - requires_review: elements land proposed and must pass a curator.
 */
export const MAP_REVIEW_POLICIES = ['authoritative', 'requires_review'] as const;
export type MapReviewPolicy = (typeof MAP_REVIEW_POLICIES)[number];

/**
 * Why a coding is attached to a diagnosis.
 *
 * - primary:    the clinician's own selection, in their own vocabulary
 * - translated: attached from an approved map, authoritative
 * - advisory:   a suggested biomedical correspondence — never a diagnosis
 */
export const CODING_ROLES = ['primary', 'translated', 'advisory'] as const;
export type CodingRole = (typeof CODING_ROLES)[number];
