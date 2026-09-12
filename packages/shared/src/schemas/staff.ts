import { z } from 'zod';
import { STAFF_ROLES, SYSTEMS_OF_MEDICINE, TENANT_ROLES, USER_STATUSES } from '../enums.js';
import { emailSchema, phoneSchema, uuidSchema } from '../primitives.js';

/**
 * Inviting a staff member.
 *
 * The role list excludes `platform_admin` deliberately: a hospital
 * administrator must not be able to mint Health24 platform staff. That is a
 * privilege boundary, and encoding it in the schema means it cannot be missed
 * at a call site.
 */
export const inviteStaffSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: emailSchema,
  phone: phoneSchema.optional(),
  role: z.enum(TENANT_ROLES),
  systemOfMedicine: z.enum(SYSTEMS_OF_MEDICINE).optional(),
  /** Healthcare Professional Registry ID, where the clinician has one. */
  hprId: z.string().trim().max(64).optional(),
});
export type InviteStaffInput = z.infer<typeof inviteStaffSchema>;

export const updateStaffSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    phone: phoneSchema.optional(),
    role: z.enum(TENANT_ROLES).optional(),
    systemOfMedicine: z.enum(SYSTEMS_OF_MEDICINE).optional(),
    hprId: z.string().trim().max(64).optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'No changes supplied',
  });
export type UpdateStaffInput = z.infer<typeof updateStaffSchema>;

export const staffSummarySchema = z.object({
  id: uuidSchema,
  name: z.string(),
  email: z.string(),
  phone: z.string().nullable(),
  role: z.enum(STAFF_ROLES),
  systemOfMedicine: z.enum(SYSTEMS_OF_MEDICINE).nullable(),
  hprId: z.string().nullable(),
  status: z.enum(USER_STATUSES),
  mfaEnrolled: z.boolean(),
  lastLoginAt: z.string().nullable(),
  createdAt: z.string(),
});
export type StaffSummary = z.infer<typeof staffSummarySchema>;

/**
 * Result of an invitation.
 *
 * The token is returned to the inviting administrator because Health24 has no
 * mail transport yet — they pass the link on themselves. Once email exists the
 * token stops crossing this boundary, since a token in an API response is a
 * token in someone's browser history.
 */
export const staffInviteResultSchema = z.object({
  staff: staffSummarySchema,
  inviteToken: z.string(),
  expiresAt: z.string(),
});
export type StaffInviteResult = z.infer<typeof staffInviteResultSchema>;

export const deactivateStaffSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});
export type DeactivateStaffInput = z.infer<typeof deactivateStaffSchema>;
