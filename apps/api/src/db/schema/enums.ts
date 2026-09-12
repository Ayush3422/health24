import {
  ACCESS_ACTIONS,
  ACTOR_TYPES,
  BLOOD_GROUPS,
  CODE_SYSTEM_STATUSES,
  DESIGNATION_USES,
  FACILITY_TYPES,
  GENDERS,
  HOSPITAL_STATUSES,
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
