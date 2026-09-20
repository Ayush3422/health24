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
 * - medical_records:     Transcribes clinical entries from a doctor's file, on
 *                        behalf of a named clinician of the same hospital.
 *                        Every such entry records both people.
 */
export const STAFF_ROLES = [
  'platform_admin',
  'terminology_curator',
  'hospital_admin',
  'clinician',
  'front_desk',
  'medical_records',
  /**
   * Health24's data-protection officer: reviews erasure requests under the
   * DPDP Act (SP5, Decision N1). Belongs to no hospital and never reads a
   * clinical record.
   */
  'data_protection_officer',
] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

/** Roles that belong to a hospital tenant (everything except platform-level roles). */
export const TENANT_ROLES = [
  'hospital_admin',
  'clinician',
  'front_desk',
  'medical_records',
] as const;
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

// ---------------------------------------------------------------------------
// Clinical record
// ---------------------------------------------------------------------------

/** The setting of an encounter, following FHIR's encounter classes. */
export const ENCOUNTER_CLASSES = [
  'outpatient',
  'inpatient',
  'emergency',
  'teleconsultation',
] as const;
export type EncounterClass = (typeof ENCOUNTER_CLASSES)[number];

/** An encounter moves only forward: in progress, then finished or cancelled. */
export const ENCOUNTER_STATUSES = ['in_progress', 'finished', 'cancelled'] as const;
export type EncounterStatus = (typeof ENCOUNTER_STATUSES)[number];

/**
 * Where a clinical entry stands in its own history.
 *
 * Clinical records are never edited or deleted. A correction is a new row that
 * supersedes the old one; a mistake is marked entered in error. Both leave the
 * original readable, because what a clinician believed at the time is part of
 * the record.
 */
export const VERSION_STATUSES = ['current', 'superseded', 'entered_in_error'] as const;
export type VersionStatus = (typeof VERSION_STATUSES)[number];

export const CONDITION_CLINICAL_STATUSES = ['active', 'inactive', 'remission', 'resolved'] as const;
export type ConditionClinicalStatus = (typeof CONDITION_CLINICAL_STATUSES)[number];

/** A working diagnosis is common and legitimate; the record should say so. */
export const CONDITION_VERIFICATION_STATUSES = ['provisional', 'confirmed'] as const;
export type ConditionVerificationStatus = (typeof CONDITION_VERIFICATION_STATUSES)[number];

export const MEDICATION_REQUEST_STATUSES = ['active', 'stopped', 'completed'] as const;
export type MedicationRequestStatus = (typeof MEDICATION_REQUEST_STATUSES)[number];

export const MEDICATION_ROUTES = [
  'oral',
  'sublingual',
  'topical',
  'nasal',
  'ophthalmic',
  'otic',
  'inhalation',
  'rectal',
  'vaginal',
  'intravenous',
  'intramuscular',
  'subcutaneous',
  'other',
] as const;
export type MedicationRoute = (typeof MEDICATION_ROUTES)[number];

/**
 * When a medicine is taken relative to food.
 *
 * Carries clinical weight in Ayurveda, where the time of administration
 * (bheshaja kala) is part of the prescription: empty stomach (abhakta), before
 * food (pragbhakta), with food (madhyabhakta), after food (adhobhakta), and at
 * bedtime (nishi).
 */
export const FOOD_TIMINGS = [
  'empty_stomach',
  'before_food',
  'with_food',
  'after_food',
  'bedtime',
  'not_applicable',
] as const;
export type FoodTiming = (typeof FOOD_TIMINGS)[number];

export const DURATION_UNITS = ['days', 'weeks', 'months'] as const;
export type DurationUnit = (typeof DURATION_UNITS)[number];

export const ALLERGY_CATEGORIES = ['medication', 'food', 'environment', 'biologic'] as const;
export type AllergyCategory = (typeof ALLERGY_CATEGORIES)[number];

export const ALLERGY_CRITICALITIES = ['low', 'high', 'unable_to_assess'] as const;
export type AllergyCriticality = (typeof ALLERGY_CRITICALITIES)[number];

export const ALLERGY_CLINICAL_STATUSES = ['active', 'inactive', 'resolved'] as const;
export type AllergyClinicalStatus = (typeof ALLERGY_CLINICAL_STATUSES)[number];

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

/**
 * The kinds of clinical data a consent can cover. A patient may share their
 * diagnoses and medicines with a new hospital without sharing their notes.
 */
export const CLINICAL_DATA_CATEGORIES = [
  'encounters',
  'diagnoses',
  'medications',
  'allergies',
  'observations',
  'notes',
  'procedures',
  /** Scanned reports and other files (SP4). Typed lab results stay under observations. */
  'documents',
] as const;
export type ClinicalDataCategory = (typeof CLINICAL_DATA_CATEGORIES)[number];

/** Why data is shared. ABDM's purpose codes are the model; only care is in scope. */
export const CONSENT_PURPOSES = ['care_management'] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];

/** Expiry is a date on the artefact rather than a status, so it cannot be forgotten. */
export const CONSENT_STATUSES = ['active', 'revoked'] as const;
export type ConsentStatus = (typeof CONSENT_STATUSES)[number];

/**
 * How consent was captured.
 *
 * A staff member attests that the patient agreed in person: on a signed form,
 * or verbally in front of a named witness. From SP5 a patient also grants
 * consent themselves, in the portal (`patient_portal`, Decision K1).
 *
 * `break_glass` is not consent at all: it is emergency access a clinician
 * takes without it, with a typed reason, for a few hours, reviewed afterwards.
 * It is recorded as an artefact so that exactly the same database rules decide
 * what it reveals.
 */
export const CONSENT_CAPTURE_METHODS = [
  'signed_form',
  'verbal_witnessed',
  'break_glass',
  'patient_portal',
] as const;
export type ConsentCaptureMethod = (typeof CONSENT_CAPTURE_METHODS)[number];

/**
 * How a clinical entry reached the record.
 *
 * - direct:      the clinician entered it themselves
 * - transcribed: medical records staff entered it from the clinician's file,
 *                on their behalf
 */
export const ENTRY_SOURCES = ['direct', 'transcribed'] as const;
export type EntrySource = (typeof ENTRY_SOURCES)[number];

/** A hospital's review of an emergency access, after the event. */
export const BREAK_GLASS_REVIEW_OUTCOMES = ['justified', 'unjustified'] as const;
export type BreakGlassReviewOutcome = (typeof BREAK_GLASS_REVIEW_OUTCOMES)[number];

// ---------------------------------------------------------------------------
// Documents (SP4)
// ---------------------------------------------------------------------------

/** What a document is. Bills are files only; billing as data is SP6 (sp4-plan.md, Decision F1). */
export const DOCUMENT_TYPES = [
  'lab_report',
  'radiology',
  'discharge_summary',
  'prescription',
  'operative_note',
  'referral',
  'bill_or_receipt',
  'other',
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

/**
 * Whether a document may be served. Every one starts pending a virus scan and
 * becomes available only when all its files scan clean.
 */
export const DOCUMENT_AVAILABILITY = [
  'pending_scan',
  'available',
  'quarantined',
  'abandoned',
] as const;
export type DocumentAvailability = (typeof DOCUMENT_AVAILABILITY)[number];

export const FILE_SCAN_STATUSES = ['pending', 'clean', 'infected'] as const;
export type FileScanStatus = (typeof FILE_SCAN_STATUSES)[number];

/** A legacy paper folder being classified into documents (Decision E1). */
export const IMPORT_BATCH_STATUSES = ['open', 'classifying', 'done'] as const;
export type ImportBatchStatus = (typeof IMPORT_BATCH_STATUSES)[number];

/** File types a browser can show without help (sp4-plan.md, DF4). */
export const DOCUMENT_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const;
export type DocumentMimeType = (typeof DOCUMENT_MIME_TYPES)[number];

export const MAX_DOCUMENT_FILE_BYTES = 25 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Observations (SP4)
// ---------------------------------------------------------------------------

/** Vital signs are a clinician's; lab results are typed from a report (sp4-plan.md, DF7). */
export const OBSERVATION_CATEGORIES = ['vital_signs', 'laboratory'] as const;
export type ObservationCategory = (typeof OBSERVATION_CATEGORIES)[number];

/** Typed by a person, or — later — extracted from a report and awaiting review (planning.md §9). */
export const OBSERVATION_SOURCES = ['entered', 'extracted'] as const;
export type ObservationSource = (typeof OBSERVATION_SOURCES)[number];

/** A lab value against the range printed on its report. A comparison, not an interpretation. */
export const RESULT_INTERPRETATIONS = ['normal', 'low', 'high', 'abnormal'] as const;
export type ResultInterpretation = (typeof RESULT_INTERPRETATIONS)[number];

/** Whom a portal account acts for: the patient themself, or a child as guardian (SP5, Decision M1). */
export const PORTAL_RELATIONSHIPS = ['self', 'guardian'] as const;
export type PortalRelationship = (typeof PORTAL_RELATIONSHIPS)[number];

/** What a patient may put on their emergency card (SP5, Decision L1). Name and age are always on it. */
export const EMERGENCY_CARD_FIELDS = [
  'blood_group',
  'allergies',
  'medicines',
  'conditions',
  'emergency_contact',
] as const;
export type EmergencyCardField = (typeof EMERGENCY_CARD_FIELDS)[number];

/** How a guardian is related to the child whose record they act for (SP5, Decision M1). */
export const GUARDIAN_RELATIONS = ['mother', 'father', 'legal_guardian'] as const;
export type GuardianRelation = (typeof GUARDIAN_RELATIONS)[number];

/** What a patient may ask to have corrected about themselves (SP5, Decision N1). */
export const CORRECTION_FIELDS = [
  'name',
  'date_of_birth',
  'gender',
  'phone',
  'blood_group',
  'emergency_contact_name',
  'emergency_contact_phone',
] as const;
export type CorrectionField = (typeof CORRECTION_FIELDS)[number];

/**
 * What a data-protection officer decided about an erasure request (SP5,
 * Decision N1). Clinical records are kept as law requires, so a request is
 * often met in part.
 */
export const ERASURE_OUTCOMES = ['erased', 'partly_erased', 'refused'] as const;
export type ErasureOutcome = (typeof ERASURE_OUTCOMES)[number];
