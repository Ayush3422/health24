import { z } from 'zod';
import { ABDM_CARE_CONTEXT_STATUSES, ABHA_VERIFICATION_METHODS } from '../enums.js';
import { abhaAddressSchema, abhaNumberSchema, uuidSchema } from '../primitives.js';

/**
 * Confirming that an ABHA belongs to the person at the desk (sp8-plan.md, T2).
 *
 * Two steps, because every method the gateway offers is a challenge and a
 * response: this system asks for a code to be sent, the patient reads it back,
 * and only then is anything written. A one-step "verify this number" would be
 * a claim by the member of staff rather than a confirmation by the patient,
 * which is the whole distinction SP8 introduces.
 */
export const startAbhaVerificationSchema = z
  .object({
    /** One of the two is required; the address is the one a patient knows. */
    abhaAddress: abhaAddressSchema.optional(),
    abhaNumber: abhaNumberSchema.optional(),
    method: z.enum(ABHA_VERIFICATION_METHODS),
  })
  .refine((v) => v.abhaAddress !== undefined || v.abhaNumber !== undefined, {
    message: 'An ABHA address or an ABHA number is required',
    path: ['abhaAddress'],
  });
export type StartAbhaVerificationInput = z.infer<typeof startAbhaVerificationSchema>;

export const abhaChallengeSchema = z.object({
  /** The gateway's handle for this challenge. Opaque here, deliberately. */
  transactionId: z.string(),
  /**
   * Where the code went, masked — enough for the patient to say "yes, that is
   * my phone", never enough to write the number down.
   */
  sentTo: z.string().nullable(),
  expiresAt: z.string(),
});
export type AbhaChallenge = z.infer<typeof abhaChallengeSchema>;

export const confirmAbhaVerificationSchema = z.object({
  transactionId: z.string().trim().min(1).max(200),
  /** What the patient read back. Never logged, and never stored. */
  code: z
    .string()
    .trim()
    .regex(/^\d{4,8}$/, 'The code is four to eight digits'),
});
export type ConfirmAbhaVerificationInput = z.infer<typeof confirmAbhaVerificationSchema>;

/**
 * A patient's ABHA, with its provenance.
 *
 * `verified` is derived rather than stored: a value with a verification
 * timestamp was confirmed against the registry, and a value without one was
 * typed by somebody. Both are shown; only the first is treated as identity.
 */
/**
 * Offering to link a patient's visits to their ABHA (sp8-plan.md, T12).
 *
 * The visits are named one by one rather than "everything": a patient who
 * wants their last visit on the national network has not asked for the other
 * eleven to be there, and a screen that offers only "share all" turns a
 * decision into a formality.
 */
export const offerCareContextLinkSchema = z.object({
  encounterIds: z.array(uuidSchema).min(1).max(50),
});
export type OfferCareContextLinkInput = z.infer<typeof offerCareContextLinkSchema>;

export const confirmCareContextLinkSchema = z.object({
  linkRequestId: uuidSchema,
  code: z
    .string()
    .trim()
    .regex(/^\d{4,8}$/, 'The code is four to eight digits'),
});
export type ConfirmCareContextLinkInput = z.infer<typeof confirmCareContextLinkSchema>;

export const unlinkCareContextSchema = z.object({
  /** Recorded on the row: a withdrawal without a reason is hard to answer for. */
  reason: z.string().trim().min(3).max(500),
});
export type UnlinkCareContextInput = z.infer<typeof unlinkCareContextSchema>;

/** One visit, and whether it is currently shared with the national network. */
export const careContextStateSchema = z.object({
  encounterId: uuidSchema,
  startedAt: z.string(),
  /** What the patient sees in their app. Never clinical (T10). */
  display: z.string(),
  careContextId: uuidSchema.nullable(),
  status: z.enum(ABDM_CARE_CONTEXT_STATUSES).nullable(),
  linkedAt: z.string().nullable(),
});
export type CareContextState = z.infer<typeof careContextStateSchema>;

export const abhaIdentitySchema = z.object({
  abhaNumber: z.string().nullable(),
  abhaAddress: z.string().nullable(),
  numberVerifiedAt: z.string().nullable(),
  addressVerifiedAt: z.string().nullable(),
  verificationMethod: z.enum(ABHA_VERIFICATION_METHODS).nullable(),
  verified: z.boolean(),
});
export type AbhaIdentity = z.infer<typeof abhaIdentitySchema>;
