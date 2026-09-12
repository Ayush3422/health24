import { z } from 'zod';

/**
 * Primitive value schemas. Defined once so the API, both clients and the tests
 * agree on exactly what a valid phone number or ABHA address is.
 */

/** UUID (we issue v7, but validate as any UUID so fixtures stay easy). */
export const uuidSchema = z.string().uuid();

/**
 * Indian mobile number.
 *
 * Accepts what a receptionist will actually type — `9876543210`,
 * `+91 98765 43210`, `098765-43210` — and normalises to E.164 (`+919876543210`)
 * so that duplicate detection can compare numbers reliably.
 */
export const phoneSchema = z
  .string()
  .trim()
  .transform((raw) => raw.replace(/[\s\-()]/g, ''))
  .refine((v) => /^(?:\+91|91|0)?[6-9]\d{9}$/.test(v), {
    message: 'Must be a valid Indian mobile number',
  })
  .transform((v) => `+91${v.slice(-10)}`);

/** ABHA number: 14 digits, commonly written as XX-XXXX-XXXX-XXXX. */
export const abhaNumberSchema = z
  .string()
  .trim()
  .transform((raw) => raw.replace(/[\s-]/g, ''))
  .refine((v) => /^\d{14}$/.test(v), { message: 'ABHA number must be 14 digits' });

/** ABHA address, e.g. `someone@abdm`. */
export const abhaAddressSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9._]{4,}@[a-z]{3,}$/, 'Must be a valid ABHA address, e.g. name@abdm');

/**
 * A person's name.
 *
 * Permissive on script — Devanagari, Tamil and Latin names must all pass — but
 * rejects digits and the punctuation that signals a paste error.
 */
export const personNameSchema = z
  .string()
  .trim()
  .min(1, 'Name is required')
  .max(120, 'Name is too long')
  .regex(/^[^\d<>{}[\]\\/|@#$%^*_=+~`]+$/u, 'Name contains invalid characters');

/** Date of birth as YYYY-MM-DD. Rejects the future and implausible ages. */
export const dateOfBirthSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date of birth must be YYYY-MM-DD')
  .refine((v) => !Number.isNaN(Date.parse(v)), { message: 'Not a real date' })
  .refine((v) => new Date(v) <= new Date(), { message: 'Date of birth cannot be in the future' })
  .refine(
    (v) => {
      const oldest = new Date();
      oldest.setFullYear(oldest.getFullYear() - 130);
      return new Date(v) >= oldest;
    },
    { message: 'Date of birth is implausible' },
  );

/** Six-digit Indian PIN code. */
export const pincodeSchema = z
  .string()
  .trim()
  .regex(/^[1-9]\d{5}$/, 'Must be a valid 6-digit PIN code');

export const emailSchema = z.string().trim().toLowerCase().email();

/** A hospital's own medical record number for a patient. */
export const mrnSchema = z.string().trim().min(1).max(32);

export const addressSchema = z.object({
  line1: z.string().trim().max(200).optional(),
  line2: z.string().trim().max(200).optional(),
  city: z.string().trim().max(100).optional(),
  district: z.string().trim().max(100).optional(),
  state: z.string().trim().max(100).optional(),
  pincode: pincodeSchema.optional(),
});
export type Address = z.infer<typeof addressSchema>;

/** Standard pagination envelope for list endpoints. */
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type Pagination = z.infer<typeof paginationSchema>;
