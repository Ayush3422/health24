import { z } from 'zod';
import { BLOOD_GROUPS, GENDERS, MATCH_METHODS } from '../enums.js';
import {
  abhaAddressSchema,
  abhaNumberSchema,
  addressSchema,
  dateOfBirthSchema,
  mrnSchema,
  paginationSchema,
  personNameSchema,
  phoneSchema,
  uuidSchema,
} from '../primitives.js';

/**
 * Registering a patient.
 *
 * Only name, gender and either a date of birth or an age are required — a
 * front desk cannot hold up an emergency registration for a PIN code. Every
 * additional field improves duplicate detection, which is why the UI should
 * encourage them without enforcing them.
 */
export const registerPatientSchema = z
  .object({
    name: personNameSchema,
    gender: z.enum(GENDERS),
    dateOfBirth: dateOfBirthSchema.optional(),
    /** Used when the patient does not know their date of birth, which is common. */
    approximateAgeYears: z.number().int().min(0).max(130).optional(),
    phone: phoneSchema.optional(),
    abhaNumber: abhaNumberSchema.optional(),
    abhaAddress: abhaAddressSchema.optional(),
    bloodGroup: z.enum(BLOOD_GROUPS).optional(),
    address: addressSchema.optional(),
    emergencyContactName: personNameSchema.optional(),
    emergencyContactPhone: phoneSchema.optional(),
    /** Set when the front desk has already reviewed match candidates and wants a new record anyway. */
    forceCreate: z.boolean().default(false),
  })
  .refine((v) => v.dateOfBirth !== undefined || v.approximateAgeYears !== undefined, {
    message: 'Either a date of birth or an approximate age is required',
    path: ['dateOfBirth'],
  });
export type RegisterPatientInput = z.input<typeof registerPatientSchema>;

/** Demographic corrections. Clinical data is never edited through this route. */
export const updatePatientSchema = z
  .object({
    name: personNameSchema.optional(),
    gender: z.enum(GENDERS).optional(),
    dateOfBirth: dateOfBirthSchema.optional(),
    phone: phoneSchema.optional(),
    abhaNumber: abhaNumberSchema.optional(),
    abhaAddress: abhaAddressSchema.optional(),
    bloodGroup: z.enum(BLOOD_GROUPS).optional(),
    address: addressSchema.optional(),
    emergencyContactName: personNameSchema.optional(),
    emergencyContactPhone: phoneSchema.optional(),
    /** Why the correction was made. Recorded in the change history. */
    reason: z.string().trim().min(3).max(500),
  })
  .refine((v) => Object.keys(v).length > 1, {
    message: 'No changes supplied',
  });
export type UpdatePatientInput = z.infer<typeof updatePatientSchema>;

/** Searching within the caller's own hospital. */
export const searchPatientsSchema = paginationSchema.extend({
  /** Free text matched against name, phone, MRN and ABHA number. */
  q: z.string().trim().min(1).max(100),
});
export type SearchPatientsInput = z.infer<typeof searchPatientsSchema>;

/**
 * Looking for a person across every hospital, before creating a new record.
 * Returns candidates with scores; it never returns clinical data.
 */
export const lookupPatientSchema = z.object({
  name: personNameSchema,
  gender: z.enum(GENDERS).optional(),
  dateOfBirth: dateOfBirthSchema.optional(),
  phone: phoneSchema.optional(),
  abhaNumber: abhaNumberSchema.optional(),
});
export type LookupPatientInput = z.infer<typeof lookupPatientSchema>;

export const patientMatchCandidateSchema = z.object({
  patientId: uuidSchema,
  score: z.number().min(0).max(1),
  method: z.enum(MATCH_METHODS),
  /** Which fields agreed, for the reviewer to see. Never the values themselves. */
  matchedOn: z.array(z.string()),
  /** Masked for display before a merge is approved. */
  maskedName: z.string(),
  maskedPhone: z.string().nullable(),
  yearOfBirth: z.number().int().nullable(),
  hospitalCount: z.number().int(),
});
export type PatientMatchCandidate = z.infer<typeof patientMatchCandidateSchema>;

/** Approving or rejecting a queued duplicate pairing. */
export const resolveMergeCandidateSchema = z.object({
  decision: z.enum(['merge', 'reject']),
  reason: z.string().trim().min(3).max(500),
  /** Which record survives. Required when merging. */
  keepPatientId: uuidSchema.optional(),
});
export type ResolveMergeCandidateInput = z.infer<typeof resolveMergeCandidateSchema>;

export const patientSummarySchema = z.object({
  id: uuidSchema,
  name: z.string(),
  gender: z.enum(GENDERS),
  dateOfBirth: z.string().nullable(),
  approximateAgeYears: z.number().int().nullable(),
  phone: z.string().nullable(),
  abhaNumber: z.string().nullable(),
  bloodGroup: z.enum(BLOOD_GROUPS).nullable(),
  /** The caller's own hospital's MRN for this patient. */
  mrn: mrnSchema.nullable(),
  createdAt: z.string(),
});
export type PatientSummary = z.infer<typeof patientSummarySchema>;

/**
 * Confirming that an existing record is the same person.
 *
 * The identifying details are re-sent deliberately. Linking grants a hospital
 * access to a patient's history, so the caller must demonstrate they can
 * already identify the person rather than simply naming an id — otherwise this
 * endpoint becomes a way to attach yourself to any record on the platform.
 */
export const linkPatientSchema = z.object({
  name: personNameSchema,
  gender: z.enum(GENDERS).optional(),
  dateOfBirth: dateOfBirthSchema.optional(),
  phone: phoneSchema.optional(),
  abhaNumber: abhaNumberSchema.optional(),
});
export type LinkPatientInput = z.infer<typeof linkPatientSchema>;

export const revertMergeSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});
export type RevertMergeInput = z.infer<typeof revertMergeSchema>;
