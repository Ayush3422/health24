import { z } from 'zod';
import {
  ALLERGY_CATEGORIES,
  ALLERGY_CLINICAL_STATUSES,
  ALLERGY_CRITICALITIES,
  ENCOUNTER_CLASSES,
  ENCOUNTER_STATUSES,
  SYSTEMS_OF_MEDICINE,
} from '../enums.js';
import { paginationSchema, uuidSchema } from '../primitives.js';

/**
 * The clinical record's API contracts.
 *
 * Every entry names the hospital that recorded it, and says whether that is
 * the caller's own. A clinician reading a shared record must always be able to
 * tell what their own hospital wrote from what arrived under consent.
 */

/** Why something was cancelled or corrected. Recorded, and shown in history. */
export const clinicalReasonSchema = z.string().trim().min(3).max(500);

/** A calendar date, YYYY-MM-DD, as India Standard Time understands it. */
export const clinicalDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a date as YYYY-MM-DD')
  .refine((value) => !Number.isNaN(Date.parse(value)), { message: 'Not a real date' });

export const hospitalRefSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  /** True when the caller's own hospital recorded this. */
  isOwn: z.boolean(),
});
export type HospitalRef = z.infer<typeof hospitalRefSchema>;

/**
 * A staff member as shown on a clinical entry. The name is null for another
 * hospital's staff, whose directory is not shared.
 */
export const staffRefSchema = z.object({
  id: uuidSchema,
  name: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// Encounters
// ---------------------------------------------------------------------------

export const openEncounterSchema = z.object({
  patientId: uuidSchema,
  class: z.enum(ENCOUNTER_CLASSES).default('outpatient'),
  /** Defaults to the clinician's own system of medicine. */
  systemOfMedicine: z.enum(SYSTEMS_OF_MEDICINE).optional(),
  chiefComplaint: z.string().trim().max(1000).optional(),
});
export type OpenEncounterInput = z.infer<typeof openEncounterSchema>;

export const cancelEncounterSchema = z.object({
  reason: clinicalReasonSchema,
});
export type CancelEncounterInput = z.infer<typeof cancelEncounterSchema>;

/**
 * Listing encounters.
 *
 * With `patientId`: that patient's encounters at every hospital the caller may
 * see. Without it: the caller's hospital's worklist for one day, today by
 * default.
 */
export const listEncountersQuerySchema = paginationSchema.extend({
  patientId: uuidSchema.optional(),
  status: z.enum(ENCOUNTER_STATUSES).optional(),
  date: clinicalDateSchema.optional(),
});
export type ListEncountersQuery = z.infer<typeof listEncountersQuerySchema>;

export const encounterSummarySchema = z.object({
  id: uuidSchema,
  patientId: uuidSchema,
  hospital: hospitalRefSchema,
  class: z.enum(ENCOUNTER_CLASSES),
  systemOfMedicine: z.enum(SYSTEMS_OF_MEDICINE),
  status: z.enum(ENCOUNTER_STATUSES),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  chiefComplaint: z.string().nullable(),
  statusReason: z.string().nullable(),
  attending: staffRefSchema,
  /** Present where the caller's hospital knows the patient: name and its own MRN. */
  patient: z.object({ name: z.string(), mrn: z.string().nullable() }).nullable(),
});
export type EncounterSummary = z.infer<typeof encounterSummarySchema>;

// ---------------------------------------------------------------------------
// Allergies
// ---------------------------------------------------------------------------

export const recordAllergySchema = z.object({
  patientId: uuidSchema,
  encounterId: uuidSchema.optional(),
  substance: z.string().trim().min(1, 'Name the substance').max(200),
  category: z.enum(ALLERGY_CATEGORIES),
  criticality: z.enum(ALLERGY_CRITICALITIES).default('unable_to_assess'),
  reaction: z.string().trim().max(500).optional(),
  note: z.string().trim().max(1000).optional(),
});
export type RecordAllergyInput = z.infer<typeof recordAllergySchema>;

export const allergySummarySchema = z.object({
  id: uuidSchema,
  patientId: uuidSchema,
  hospital: hospitalRefSchema,
  substance: z.string(),
  category: z.enum(ALLERGY_CATEGORIES),
  criticality: z.enum(ALLERGY_CRITICALITIES),
  clinicalStatus: z.enum(ALLERGY_CLINICAL_STATUSES),
  reaction: z.string().nullable(),
  note: z.string().nullable(),
  recordedAt: z.string(),
  recordedBy: staffRefSchema,
});
export type AllergySummary = z.infer<typeof allergySummarySchema>;

/**
 * The allergy banner shown on every clinical screen for a patient.
 *
 * An empty list is not "no known allergies". It means none are recorded in
 * the records the caller can see — which is why the banner also says whether
 * any other hospital's allergy records are shared with the caller at all.
 */
export const allergyBannerSchema = z.object({
  allergies: z.array(allergySummarySchema),
  sharedFromOtherHospitals: z.boolean(),
});
export type AllergyBanner = z.infer<typeof allergyBannerSchema>;
