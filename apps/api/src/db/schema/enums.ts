import {
  ACCESS_ACTIONS,
  ACTOR_TYPES,
  ALLERGY_CATEGORIES,
  ALLERGY_CLINICAL_STATUSES,
  ALLERGY_CRITICALITIES,
  BLOOD_GROUPS,
  BREAK_GLASS_REVIEW_OUTCOMES,
  CLINICAL_DATA_CATEGORIES,
  CODE_SYSTEM_STATUSES,
  CODING_ROLES,
  CONDITION_CLINICAL_STATUSES,
  CONDITION_VERIFICATION_STATUSES,
  CONSENT_CAPTURE_METHODS,
  CONSENT_PURPOSES,
  CONSENT_STATUSES,
  DOCUMENT_AVAILABILITY,
  DOCUMENT_TYPES,
  FILE_SCAN_STATUSES,
  IMPORT_BATCH_STATUSES,
  DESIGNATION_USES,
  DURATION_UNITS,
  ENCOUNTER_CLASSES,
  ENCOUNTER_STATUSES,
  ENTRY_SOURCES,
  FACILITY_TYPES,
  FOOD_TIMINGS,
  GENDERS,
  HOSPITAL_STATUSES,
  MEDICATION_REQUEST_STATUSES,
  MEDICATION_ROUTES,
  OBSERVATION_CATEGORIES,
  OBSERVATION_SOURCES,
  RESULT_INTERPRETATIONS,
  SERVICE_REQUEST_CATEGORIES,
  SERVICE_REQUEST_PRIORITIES,
  SERVICE_REQUEST_STATUSES,
  BED_STATUSES,
  WARD_KINDS,
  WARD_STATUSES,
  VERSION_STATUSES,
  MAP_ELEMENT_STATUSES,
  MAP_EQUIVALENCES,
  MAP_PROVENANCES,
  MAP_REVIEW_POLICIES,
  MATCH_METHODS,
  MERGE_CANDIDATE_STATUSES,
  STAFF_ROLES,
  SYSTEMS_OF_MEDICINE,
  USER_STATUSES,
} from '@health24/shared';
import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * Postgres enum types, generated from the shared domain enums so the database
 * and the application can never drift apart. Adding a value means editing
 * `@health24/shared` and generating a migration — which is the point.
 */
/**
 * Drizzle's `pgEnum` wants a mutable tuple; the shared enums are `as const`
 * readonly tuples. This bridges the two **without widening to `string`** —
 * `T[number]` keeps the literal union, so a column typed by one of these
 * enums is checked against its real values rather than accepting any string.
 */
const tuple = <T extends readonly [string, ...string[]]>(values: T) =>
  values as unknown as [T[number], ...T[number][]];

export const facilityTypeEnum = pgEnum('facility_type', tuple(FACILITY_TYPES));
export const hospitalStatusEnum = pgEnum('hospital_status', tuple(HOSPITAL_STATUSES));
export const staffRoleEnum = pgEnum('staff_role', tuple(STAFF_ROLES));
export const userStatusEnum = pgEnum('user_status', tuple(USER_STATUSES));
export const systemOfMedicineEnum = pgEnum('system_of_medicine', tuple(SYSTEMS_OF_MEDICINE));
export const genderEnum = pgEnum('gender', tuple(GENDERS));
export const bloodGroupEnum = pgEnum('blood_group', tuple(BLOOD_GROUPS));
export const actorTypeEnum = pgEnum('actor_type', tuple(ACTOR_TYPES));
export const accessActionEnum = pgEnum('access_action', tuple(ACCESS_ACTIONS));
export const mergeCandidateStatusEnum = pgEnum(
  'merge_candidate_status',
  tuple(MERGE_CANDIDATE_STATUSES),
);
export const matchMethodEnum = pgEnum('match_method', tuple(MATCH_METHODS));

/** Whether an audited request was permitted. Denials are as interesting as grants. */
export const accessOutcomeEnum = pgEnum('access_outcome', ['allowed', 'denied']);

/** A patient row is either live or a tombstone pointing at the record it merged into. */
export const patientStatusEnum = pgEnum('patient_status', ['active', 'merged']);

// Terminology

export const codeSystemStatusEnum = pgEnum('code_system_status', tuple(CODE_SYSTEM_STATUSES));
export const designationUseEnum = pgEnum('designation_use', tuple(DESIGNATION_USES));
export const mapEquivalenceEnum = pgEnum('map_equivalence', tuple(MAP_EQUIVALENCES));
export const mapElementStatusEnum = pgEnum('map_element_status', tuple(MAP_ELEMENT_STATUSES));
export const mapProvenanceEnum = pgEnum('map_provenance', tuple(MAP_PROVENANCES));
export const mapReviewPolicyEnum = pgEnum('map_review_policy', tuple(MAP_REVIEW_POLICIES));

/** Actions recorded in a mapping's review history. Internal to the API. */
export const mapReviewActionEnum = pgEnum('map_review_action', [
  'import',
  'propose',
  'approve',
  'reject',
  'retire',
]);

// Clinical record

export const encounterClassEnum = pgEnum('encounter_class', tuple(ENCOUNTER_CLASSES));
export const encounterStatusEnum = pgEnum('encounter_status', tuple(ENCOUNTER_STATUSES));
export const versionStatusEnum = pgEnum('version_status', tuple(VERSION_STATUSES));
export const conditionClinicalStatusEnum = pgEnum(
  'condition_clinical_status',
  tuple(CONDITION_CLINICAL_STATUSES),
);
export const conditionVerificationStatusEnum = pgEnum(
  'condition_verification_status',
  tuple(CONDITION_VERIFICATION_STATUSES),
);
export const codingRoleEnum = pgEnum('coding_role', tuple(CODING_ROLES));
export const medicationRequestStatusEnum = pgEnum(
  'medication_request_status',
  tuple(MEDICATION_REQUEST_STATUSES),
);
export const medicationRouteEnum = pgEnum('medication_route', tuple(MEDICATION_ROUTES));
export const foodTimingEnum = pgEnum('food_timing', tuple(FOOD_TIMINGS));
export const durationUnitEnum = pgEnum('duration_unit', tuple(DURATION_UNITS));
export const allergyCategoryEnum = pgEnum('allergy_category', tuple(ALLERGY_CATEGORIES));
export const allergyCriticalityEnum = pgEnum('allergy_criticality', tuple(ALLERGY_CRITICALITIES));
export const allergyClinicalStatusEnum = pgEnum(
  'allergy_clinical_status',
  tuple(ALLERGY_CLINICAL_STATUSES),
);

// Consent

export const clinicalDataCategoryEnum = pgEnum(
  'clinical_data_category',
  tuple(CLINICAL_DATA_CATEGORIES),
);
export const consentPurposeEnum = pgEnum('consent_purpose', tuple(CONSENT_PURPOSES));
export const consentStatusEnum = pgEnum('consent_status', tuple(CONSENT_STATUSES));
export const consentCaptureMethodEnum = pgEnum(
  'consent_capture_method',
  tuple(CONSENT_CAPTURE_METHODS),
);
export const entrySourceEnum = pgEnum('entry_source', tuple(ENTRY_SOURCES));
export const breakGlassReviewOutcomeEnum = pgEnum(
  'break_glass_review_outcome',
  tuple(BREAK_GLASS_REVIEW_OUTCOMES),
);

// Documents (SP4)

export const documentTypeEnum = pgEnum('document_type', tuple(DOCUMENT_TYPES));
export const documentAvailabilityEnum = pgEnum(
  'document_availability',
  tuple(DOCUMENT_AVAILABILITY),
);
export const fileScanStatusEnum = pgEnum('file_scan_status', tuple(FILE_SCAN_STATUSES));
export const importBatchStatusEnum = pgEnum('import_batch_status', tuple(IMPORT_BATCH_STATUSES));

// Observations (SP4)

export const observationCategoryEnum = pgEnum(
  'observation_category',
  tuple(OBSERVATION_CATEGORIES),
);
export const observationSourceEnum = pgEnum('observation_source', tuple(OBSERVATION_SOURCES));
export const resultInterpretationEnum = pgEnum(
  'result_interpretation',
  tuple(RESULT_INTERPRETATIONS),
);

// Orders (SP6)

export const serviceRequestCategoryEnum = pgEnum(
  'service_request_category',
  tuple(SERVICE_REQUEST_CATEGORIES),
);
export const serviceRequestStatusEnum = pgEnum(
  'service_request_status',
  tuple(SERVICE_REQUEST_STATUSES),
);
export const serviceRequestPriorityEnum = pgEnum(
  'service_request_priority',
  tuple(SERVICE_REQUEST_PRIORITIES),
);

// Wards and beds (SP6)

export const wardKindEnum = pgEnum('ward_kind', tuple(WARD_KINDS));
export const wardStatusEnum = pgEnum('ward_status', tuple(WARD_STATUSES));
export const bedStatusEnum = pgEnum('bed_status', tuple(BED_STATUSES));
