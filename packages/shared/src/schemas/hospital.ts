import { z } from 'zod';
import { FACILITY_TYPES, HOSPITAL_STATUSES } from '../enums.js';
import { addressSchema, emailSchema, phoneSchema, uuidSchema } from '../primitives.js';

/**
 * Onboarding a hospital tenant. Platform admins only.
 */
export const createHospitalSchema = z.object({
  name: z.string().trim().min(2).max(200),
  facilityType: z.enum(FACILITY_TYPES),
  /** ABDM Health Facility Registry ID, where the facility is registered. */
  hfrId: z.string().trim().max(64).optional(),
  contactEmail: emailSchema,
  contactPhone: phoneSchema,
  address: addressSchema,
  /**
   * Prefix for this hospital's medical record numbers, e.g. `AH` produces
   * `AH-000123`. Hospitals care about this; it appears on every printed sheet.
   */
  mrnPrefix: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2,6}$/, 'MRN prefix must be 2-6 letters'),
});
export type CreateHospitalInput = z.infer<typeof createHospitalSchema>;

export const updateHospitalSchema = createHospitalSchema.partial().extend({
  status: z.enum(HOSPITAL_STATUSES).optional(),
});
export type UpdateHospitalInput = z.infer<typeof updateHospitalSchema>;

export const hospitalSummarySchema = z.object({
  id: uuidSchema,
  name: z.string(),
  facilityType: z.enum(FACILITY_TYPES),
  status: z.enum(HOSPITAL_STATUSES),
  hfrId: z.string().nullable(),
  mrnPrefix: z.string(),
  createdAt: z.string(),
});
export type HospitalSummary = z.infer<typeof hospitalSummarySchema>;
