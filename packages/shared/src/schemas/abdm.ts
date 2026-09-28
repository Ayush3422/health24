import { z } from 'zod';
import { ABHA_VERIFICATION_METHODS } from '../enums.js';
import { abhaAddressSchema, abhaNumberSchema } from '../primitives.js';

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
export const abhaIdentitySchema = z.object({
  abhaNumber: z.string().nullable(),
  abhaAddress: z.string().nullable(),
  numberVerifiedAt: z.string().nullable(),
  addressVerifiedAt: z.string().nullable(),
  verificationMethod: z.enum(ABHA_VERIFICATION_METHODS).nullable(),
  verified: z.boolean(),
});
export type AbhaIdentity = z.infer<typeof abhaIdentitySchema>;
