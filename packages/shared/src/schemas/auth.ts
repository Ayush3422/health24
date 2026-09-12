import { z } from 'zod';
import { STAFF_ROLES, SYSTEMS_OF_MEDICINE } from '../enums.js';
import { emailSchema, phoneSchema, uuidSchema } from '../primitives.js';

/**
 * Password policy.
 *
 * Length over composition rules: a 12-character passphrase beats
 * `Passw0rd!` and users stop writing them on monitors. The blocklist of
 * obvious choices is enforced server-side.
 */
export const passwordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(200, 'Password is too long');

export const loginSchema = z.object({
  /** Staff sign in with email; patients will sign in with phone in SP5. */
  email: emailSchema,
  password: z.string().min(1, 'Password is required'),
});
export type LoginInput = z.infer<typeof loginSchema>;

/** Second factor. Mandatory for clinicians and admins. */
export const verifyTotpSchema = z.object({
  /** Short-lived token issued by /auth/login when credentials are correct. */
  challengeToken: z.string().min(1),
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$|^[A-Z0-9]{10}$/, 'Enter your 6-digit code or a recovery code'),
});
export type VerifyTotpInput = z.infer<typeof verifyTotpSchema>;

export const enrolTotpSchema = z.object({
  code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app'),
});
export type EnrolTotpInput = z.infer<typeof enrolTotpSchema>;

export const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});
export type RefreshInput = z.infer<typeof refreshSchema>;

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: passwordSchema,
});
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

/** Accepting a staff invitation: set a password and enrol a second factor. */
export const acceptInviteSchema = z.object({
  inviteToken: z.string().min(1),
  password: passwordSchema,
});
export type AcceptInviteInput = z.infer<typeof acceptInviteSchema>;

/** The authenticated actor, as returned to the client after sign-in. */
export const authenticatedStaffSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  email: z.string(),
  role: z.enum(STAFF_ROLES),
  hospitalId: uuidSchema.nullable(),
  hospitalName: z.string().nullable(),
  systemOfMedicine: z.enum(SYSTEMS_OF_MEDICINE).nullable(),
  mfaEnrolled: z.boolean(),
});
export type AuthenticatedStaff = z.infer<typeof authenticatedStaffSchema>;

export const sessionSummarySchema = z.object({
  id: uuidSchema,
  createdAt: z.string(),
  lastUsedAt: z.string(),
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  isCurrent: z.boolean(),
});
export type SessionSummary = z.infer<typeof sessionSummarySchema>;

export const inviteStaffSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: emailSchema,
  phone: phoneSchema.optional(),
  role: z.enum(['hospital_admin', 'clinician', 'front_desk']),
  systemOfMedicine: z.enum(SYSTEMS_OF_MEDICINE).optional(),
  /** Healthcare Professional Registry ID, where the clinician has one. */
  hprId: z.string().trim().max(64).optional(),
});
export type InviteStaffInput = z.infer<typeof inviteStaffSchema>;
