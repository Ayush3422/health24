import { z } from 'zod';
import { ENCOUNTER_CLASSES, PORTAL_RELATIONSHIPS } from '../enums.js';
import { phoneSchema, uuidSchema } from '../primitives.js';
import { hospitalRefSchema, staffRefSchema, timelineQuerySchema } from './clinical.js';
import { listDocumentsQuerySchema } from './documents.js';

/**
 * The patient portal's sign-in (SP5 Phase 1).
 *
 * A patient signs in with a phone number and a one-time code (planning.md D12).
 * Portal access is activated for a phone at a hospital desk, in person
 * (sp5-plan.md, Decision J1); one phone may act for several patients — a
 * family sharing a phone — so a patient is chosen after the code is accepted.
 */

export const OTP_LENGTH = 6;
export const OTP_TTL_SECONDS = 300;

export const requestOtpSchema = z.object({ phone: phoneSchema });
export type RequestOtpInput = z.infer<typeof requestOtpSchema>;

/** The same answer whether or not the number has portal access. */
export const otpRequestedSchema = z.object({
  sent: z.literal(true),
  expiresInSeconds: z.number().int(),
});
export type OtpRequested = z.infer<typeof otpRequestedSchema>;

export const verifyOtpSchema = z.object({
  phone: phoneSchema,
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Enter the 6-digit code sent to your phone'),
});
export type VerifyOtpInput = z.infer<typeof verifyOtpSchema>;

export const portalPatientOptionSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  relationship: z.enum(PORTAL_RELATIONSHIPS),
});
export type PortalPatientOption = z.infer<typeof portalPatientOptionSchema>;

export const otpVerifiedSchema = z.object({
  /** Short-lived; spent on choosing which patient to act for. */
  selectionToken: z.string(),
  patients: z.array(portalPatientOptionSchema),
});
export type OtpVerified = z.infer<typeof otpVerifiedSchema>;

export const startPortalSessionSchema = z.object({
  selectionToken: z.string().min(1),
  patientId: uuidSchema,
});
export type StartPortalSessionInput = z.infer<typeof startPortalSessionSchema>;

export const switchPortalPatientSchema = z.object({ patientId: uuidSchema });
export type SwitchPortalPatientInput = z.infer<typeof switchPortalPatientSchema>;

export const portalRefreshSchema = z.object({ refreshToken: z.string().min(1) });
export type PortalRefreshInput = z.infer<typeof portalRefreshSchema>;

export const portalSessionIssuedSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.string(),
  patient: portalPatientOptionSchema,
});
export type PortalSessionIssued = z.infer<typeof portalSessionIssuedSchema>;

export const portalMeSchema = z.object({
  accountId: uuidSchema,
  /** Masked: enough to recognise the number. */
  phone: z.string(),
  patient: portalPatientOptionSchema,
  /** Every patient this phone may act for, to switch between. */
  patients: z.array(portalPatientOptionSchema),
});
export type PortalMe = z.infer<typeof portalMeSchema>;

export const portalSessionSummarySchema = z.object({
  id: uuidSchema,
  patientName: z.string().nullable(),
  createdAt: z.string(),
  lastUsedAt: z.string(),
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  current: z.boolean(),
});
export type PortalSessionSummary = z.infer<typeof portalSessionSummarySchema>;

// ---------------------------------------------------------------------------
// Activation at the desk (Decision J1)
// ---------------------------------------------------------------------------

export const activatePortalAccessSchema = z.object({
  phone: phoneSchema,
  /** The person at the desk has checked, in person, that this is the patient. */
  identityConfirmed: z.literal(true, {
    errorMap: () => ({ message: 'Confirm that you have checked the patient’s identity in person' }),
  }),
});
export type ActivatePortalAccessInput = z.infer<typeof activatePortalAccessSchema>;

export const revokePortalAccessSchema = z.object({
  reason: z.string().trim().min(3, 'Give a reason').max(500),
});
export type RevokePortalAccessInput = z.infer<typeof revokePortalAccessSchema>;

export const PORTAL_ACCESS_STATUSES = ['active', 'ended', 'revoked'] as const;

export const portalAccessSummarySchema = z.object({
  id: uuidSchema,
  patientId: uuidSchema,
  phone: z.string(),
  relationship: z.enum(PORTAL_RELATIONSHIPS),
  status: z.enum(PORTAL_ACCESS_STATUSES),
  activatedAt: z.string(),
  activatedBy: staffRefSchema,
  activatedAtHospital: hospitalRefSchema,
  endsAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  revokedReason: z.string().nullable(),
});
export type PortalAccessSummary = z.infer<typeof portalAccessSummarySchema>;

// ---------------------------------------------------------------------------
// The patient's own summary (Phase 2)
// ---------------------------------------------------------------------------

/**
 * What a patient sees first: their own record at every hospital, without
 * consent, in plain words. Diagnoses keep the name the doctor chose and its
 * code; nothing is explained or rephrased (sp5-plan.md, DF5).
 */
export const portalSummarySchema = z.object({
  patient: z.object({
    name: z.string(),
    ageYears: z.number().int().nullable(),
  }),
  allergies: z.array(
    z.object({
      id: uuidSchema,
      substance: z.string(),
      highRisk: z.boolean(),
      reaction: z.string().nullable(),
      hospitalName: z.string(),
    }),
  ),
  problems: z.array(
    z.object({
      id: uuidSchema,
      name: z.string(),
      code: z.string().nullable(),
      since: z.string(),
      hospitalName: z.string(),
    }),
  ),
  medicines: z.array(
    z.object({
      id: uuidSchema,
      name: z.string(),
      howToTake: z.string().nullable(),
      startDate: z.string().nullable(),
      hospitalName: z.string(),
    }),
  ),
  abnormalResults: z.array(
    z.object({
      id: uuidSchema,
      label: z.string(),
      value: z.number(),
      unit: z.string(),
      direction: z.enum(['higher', 'lower', 'outside']),
      collectedAt: z.string(),
      hospitalName: z.string(),
    }),
  ),
  lastVisit: z
    .object({
      date: z.string(),
      kind: z.enum(ENCOUNTER_CLASSES),
      hospitalName: z.string(),
    })
    .nullable(),
  hospitals: z.array(z.object({ id: uuidSchema, name: z.string(), mrn: z.string() })),
});
export type PortalSummary = z.infer<typeof portalSummarySchema>;

// ---------------------------------------------------------------------------
// The patient's own record (Phase 3)
// ---------------------------------------------------------------------------

// As staff read them, less the hospital scope: a patient has no "own" hospital.

export const portalTimelineQuerySchema = timelineQuerySchema.omit({ scope: true });
export type PortalTimelineQuery = z.infer<typeof portalTimelineQuerySchema>;

export const portalDocumentsQuerySchema = listDocumentsQuerySchema.omit({ scope: true });
export type PortalDocumentsQuery = z.infer<typeof portalDocumentsQuerySchema>;
