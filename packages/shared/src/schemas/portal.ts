import { z } from 'zod';
import {
  ACCESS_ACTIONS,
  BREAK_GLASS_REVIEW_OUTCOMES,
  CLINICAL_DATA_CATEGORIES,
  CORRECTION_FIELDS,
  CONSENT_CAPTURE_METHODS,
  EMERGENCY_CARD_FIELDS,
  ENCOUNTER_CLASSES,
  ERASURE_OUTCOMES,
  GUARDIAN_RELATIONS,
  PORTAL_RELATIONSHIPS,
  STAFF_ROLES,
} from '../enums.js';
import { phoneSchema, uuidSchema } from '../primitives.js';
import {
  CONSENT_EFFECTIVE_STATUSES,
  clinicalDateSchema,
  hospitalRefSchema,
  staffRefSchema,
  timelineQuerySchema,
} from './clinical.js';
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

/**
 * A child's record linked to a guardian's phone (Decision M1), after the desk
 * has checked the relationship in person and a document that shows it. The
 * link ends by itself at the child's 18th birthday.
 */
export const linkGuardianSchema = z.object({
  phone: phoneSchema,
  guardianName: z.string().trim().min(2, 'Give the guardian’s name').max(120),
  guardianRelation: z.enum(GUARDIAN_RELATIONS),
  documentChecked: z.string().trim().min(3, 'Name the document you checked').max(200),
  relationshipConfirmed: z.literal(true, {
    errorMap: () => ({ message: 'Confirm that you have checked the relationship in person' }),
  }),
});
export type LinkGuardianInput = z.infer<typeof linkGuardianSchema>;

export const PORTAL_ACCESS_STATUSES = ['active', 'ended', 'revoked'] as const;

export const portalAccessSummarySchema = z.object({
  id: uuidSchema,
  patientId: uuidSchema,
  phone: z.string(),
  relationship: z.enum(PORTAL_RELATIONSHIPS),
  status: z.enum(PORTAL_ACCESS_STATUSES),
  /** For a guardian's access: who they are, how related, and what the desk checked. */
  guardian: z
    .object({
      name: z.string(),
      relation: z.enum(GUARDIAN_RELATIONS),
      documentChecked: z.string(),
    })
    .nullable(),
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

// ---------------------------------------------------------------------------
// Consent from the portal (Phase 4, Decision K1)
// ---------------------------------------------------------------------------

/**
 * The patient lets a hospital where they are registered see their record from
 * their other hospitals: the kinds of record, optionally the dates, and for how
 * long — a year at most, as at the desk.
 */
export const portalGrantConsentSchema = z
  .object({
    hospitalId: uuidSchema,
    dataCategories: z
      .array(z.enum(CLINICAL_DATA_CATEGORIES))
      .min(1, 'Choose at least one kind of record')
      .refine((values) => new Set(values).size === values.length, {
        message: 'Each kind of record once',
      }),
    dateRangeFrom: clinicalDateSchema.optional(),
    dateRangeTo: clinicalDateSchema.optional(),
    validForDays: z.number().int().min(1).max(365),
  })
  .refine(
    (value) =>
      !value.dateRangeFrom || !value.dateRangeTo || value.dateRangeFrom <= value.dateRangeTo,
    { message: 'The date range ends before it starts', path: ['dateRangeTo'] },
  );
export type PortalGrantConsentInput = z.infer<typeof portalGrantConsentSchema>;

/** A reason is the patient's to give or not. */
export const portalRevokeConsentSchema = z.object({
  reason: z.string().trim().min(1).max(500).optional(),
});
export type PortalRevokeConsentInput = z.infer<typeof portalRevokeConsentSchema>;

/** Who recorded or revoked a consent, as the patient is told: themselves, or a hospital's staff. */
const portalConsentActorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('patient'), you: z.boolean() }),
  z.object({ kind: z.literal('staff'), name: z.string().nullable() }),
]);

export const portalConsentSchema = z.object({
  id: uuidSchema,
  /** The hospital the consent lets see the patient's other records. */
  hospital: z.object({ id: uuidSchema, name: z.string() }),
  dataCategories: z.array(z.enum(CLINICAL_DATA_CATEGORIES)),
  dateRangeFrom: z.string().nullable(),
  dateRangeTo: z.string().nullable(),
  grantedAt: z.string(),
  expiresAt: z.string(),
  status: z.enum(CONSENT_EFFECTIVE_STATUSES),
  captureMethod: z.enum(CONSENT_CAPTURE_METHODS),
  emergencyReason: z.string().nullable(),
  recordedBy: portalConsentActorSchema,
  revokedAt: z.string().nullable(),
  revokedBy: portalConsentActorSchema.nullable(),
  revocationReason: z.string().nullable(),
});
export type PortalConsent = z.infer<typeof portalConsentSchema>;

export const portalConsentsSchema = z.object({
  /** Where the patient is registered: the hospitals they may grant consent to. */
  hospitals: z.array(z.object({ id: uuidSchema, name: z.string() })),
  consents: z.array(portalConsentSchema),
});
export type PortalConsents = z.infer<typeof portalConsentsSchema>;

// ---------------------------------------------------------------------------
// Access history and notifications (Phase 5, DF6 and DF10)
// ---------------------------------------------------------------------------

export const accessHistoryQuerySchema = z.object({
  /** `nextBefore` from the previous page. */
  before: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type AccessHistoryQuery = z.infer<typeof accessHistoryQuerySchema>;

/**
 * One person's access to the record at one hospital on one day, in India
 * Standard Time — however many reads it took.
 */
export const accessHistoryEntrySchema = z.object({
  id: z.string(),
  /** YYYY-MM-DD, in India Standard Time. */
  day: z.string(),
  firstAt: z.string(),
  lastAt: z.string(),
  actor: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('staff'),
      /** Null for staff at a hospital where the patient is not registered. */
      name: z.string().nullable(),
      role: z.enum(STAFF_ROLES).nullable(),
    }),
    /** Another phone with portal access to this record, masked. */
    z.object({ kind: z.literal('patient'), label: z.string().nullable() }),
    z.object({ kind: z.literal('system') }),
  ]),
  hospital: z.object({ id: uuidSchema, name: z.string() }).nullable(),
  /** What was touched, by audit resource type; the portal words them. */
  resources: z.array(z.string()),
  actions: z.array(z.enum(ACCESS_ACTIONS)),
  count: z.number().int(),
  /** Given when emergency access was taken. */
  emergencyReason: z.string().nullable(),
  /** The consents or emergency access reads of other hospitals' records rested on. */
  consents: z.array(
    z.object({
      id: uuidSchema,
      captureMethod: z.enum(CONSENT_CAPTURE_METHODS),
      grantedAt: z.string(),
      grantedByYou: z.boolean(),
      emergencyReason: z.string().nullable(),
    }),
  ),
});
export type AccessHistoryEntry = z.infer<typeof accessHistoryEntrySchema>;

export const accessHistoryPageSchema = z.object({
  entries: z.array(accessHistoryEntrySchema),
  nextBefore: z.string().nullable(),
});
export type AccessHistoryPage = z.infer<typeof accessHistoryPageSchema>;

/** Emergency access to the patient's record, which the portal always shows (DF10). */
export const portalEmergencyAccessSchema = z.object({
  id: uuidSchema,
  hospital: z.object({ id: uuidSchema, name: z.string() }),
  clinicianName: z.string().nullable(),
  reason: z.string(),
  grantedAt: z.string(),
  expiresAt: z.string(),
  active: z.boolean(),
  review: z
    .object({ outcome: z.enum(BREAK_GLASS_REVIEW_OUTCOMES), reviewedAt: z.string() })
    .nullable(),
  /** When the patient was sent a text message about it. */
  notifiedAt: z.string().nullable(),
});
export type PortalEmergencyAccess = z.infer<typeof portalEmergencyAccessSchema>;

export const portalNotificationsSchema = z.object({
  /** The last 90 days, newest first. */
  emergencyAccesses: z.array(portalEmergencyAccessSchema),
});
export type PortalNotifications = z.infer<typeof portalNotificationsSchema>;

// ---------------------------------------------------------------------------
// The emergency card (Phase 6, Decision L1)
// ---------------------------------------------------------------------------

/**
 * What a card shows. Name and age always identify the patient; every other
 * key is present only when the patient chose it for the card.
 */
export const emergencyFactsSchema = z.object({
  name: z.string(),
  ageYears: z.number().int().nullable(),
  /** As recorded; null when no hospital has recorded it. */
  bloodGroup: z.string().nullable().optional(),
  allergies: z
    .array(z.object({ substance: z.string(), highRisk: z.boolean(), reaction: z.string().nullable() }))
    .optional(),
  medicines: z.array(z.object({ name: z.string(), howToTake: z.string().nullable() })).optional(),
  conditions: z.array(z.object({ name: z.string(), code: z.string().nullable() })).optional(),
  /** As registered at a hospital; null when none is. */
  emergencyContact: z.object({ name: z.string(), phone: z.string() }).nullable().optional(),
});
export type EmergencyFacts = z.infer<typeof emergencyFactsSchema>;

export const emergencyCardSettingsSchema = z.object({
  fields: z
    .array(z.enum(EMERGENCY_CARD_FIELDS))
    .min(1, 'Choose at least one thing for the card')
    .refine((values) => new Set(values).size === values.length, { message: 'Each once' }),
});
export type EmergencyCardSettings = z.infer<typeof emergencyCardSettingsSchema>;

export const portalEmergencyCardSchema = z.object({
  id: uuidSchema,
  fields: z.array(z.enum(EMERGENCY_CARD_FIELDS)),
  /** The link's secret, shown only to the patient, for printing the card again. */
  token: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PortalEmergencyCard = z.infer<typeof portalEmergencyCardSchema>;

export const portalEmergencyCardStateSchema = z.object({
  card: portalEmergencyCardSchema.nullable(),
  /** Every field, so the patient can see what each would show before choosing. */
  facts: emergencyFactsSchema,
});
export type PortalEmergencyCardState = z.infer<typeof portalEmergencyCardStateSchema>;

/** The page a card's QR code opens, without signing in. */
export const emergencyPageSchema = z.object({
  facts: emergencyFactsSchema,
  /** When the patient last changed what the card shows. The facts themselves are current. */
  cardUpdatedAt: z.string(),
});
export type EmergencyPage = z.infer<typeof emergencyPageSchema>;

// ---------------------------------------------------------------------------
// The patient's copy of their record (Phase 8, Decision N1)
// ---------------------------------------------------------------------------

export const EXPORT_STATUSES = ['pending', 'ready', 'failed', 'expired'] as const;
export const EXPORT_FORMATS = ['pdf', 'fhir'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const dataExportSchema = z.object({
  id: uuidSchema,
  status: z.enum(EXPORT_STATUSES),
  requestedAt: z.string(),
  readyAt: z.string().nullable(),
  /** After this the files are removed; the patient can ask for another copy. */
  expiresAt: z.string().nullable(),
  entryCount: z.number().int().nullable(),
  failureReason: z.string().nullable(),
});
export type DataExportSummary = z.infer<typeof dataExportSchema>;

export const exportDownloadQuerySchema = z.object({ format: z.enum(EXPORT_FORMATS) });
export type ExportDownloadQuery = z.infer<typeof exportDownloadQuerySchema>;

export const exportDownloadSchema = z.object({
  url: z.string(),
  expiresAt: z.string(),
  format: z.enum(EXPORT_FORMATS),
});
export type ExportDownload = z.infer<typeof exportDownloadSchema>;

// ---------------------------------------------------------------------------
// Corrections (Phase 8, Decision N1)
// ---------------------------------------------------------------------------

export const CORRECTION_STATUSES = ['pending', 'applied', 'declined'] as const;

/** A patient asking a hospital to correct something it holds about them. */
export const requestCorrectionSchema = z.object({
  hospitalId: uuidSchema,
  field: z.enum(CORRECTION_FIELDS),
  requestedValue: z.string().trim().min(1, 'Say what it should be').max(200),
  note: z.string().trim().max(500).optional(),
});
export type RequestCorrectionInput = z.infer<typeof requestCorrectionSchema>;

export const correctionRequestSchema = z.object({
  id: uuidSchema,
  patientId: uuidSchema,
  hospital: z.object({ id: uuidSchema, name: z.string() }),
  field: z.enum(CORRECTION_FIELDS),
  /** What the record said when the patient asked. */
  currentValue: z.string().nullable(),
  requestedValue: z.string(),
  note: z.string().nullable(),
  status: z.enum(CORRECTION_STATUSES),
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
  resolvedBy: staffRefSchema.nullable(),
  resolutionNote: z.string().nullable(),
});
export type CorrectionRequestSummary = z.infer<typeof correctionRequestSchema>;

/** What the portal needs to ask for a correction: where to send it, and what the record says now. */
export const portalCorrectionsSchema = z.object({
  hospitals: z.array(z.object({ id: uuidSchema, name: z.string() })),
  current: z.record(z.enum(CORRECTION_FIELDS), z.string().nullable()),
  requests: z.array(correctionRequestSchema),
});
export type PortalCorrections = z.infer<typeof portalCorrectionsSchema>;

/** A hospital's queue of corrections patients have asked for. */
export const correctionQueueItemSchema = correctionRequestSchema.extend({
  patient: z.object({ id: uuidSchema, name: z.string(), mrn: z.string().nullable() }),
});
export type CorrectionQueueItem = z.infer<typeof correctionQueueItemSchema>;

export const resolveCorrectionSchema = z.object({
  note: z.string().trim().max(500).optional(),
});
export type ResolveCorrectionInput = z.infer<typeof resolveCorrectionSchema>;

export const declineCorrectionSchema = z.object({
  note: z.string().trim().min(3, 'Say why it is declined').max(500),
});
export type DeclineCorrectionInput = z.infer<typeof declineCorrectionSchema>;

// ---------------------------------------------------------------------------
// Erasure (Phase 8, Decision N1)
// ---------------------------------------------------------------------------

export const requestErasureSchema = z.object({
  /** The patient's own words, if they want to give a reason. */
  reason: z.string().trim().max(1000).optional(),
});
export type RequestErasureInput = z.infer<typeof requestErasureSchema>;

export const erasureRequestSchema = z.object({
  id: uuidSchema,
  status: z.enum(['pending', 'decided']),
  reason: z.string().nullable(),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  outcome: z.enum(ERASURE_OUTCOMES).nullable(),
  /** What law requires be kept, and for how long. */
  retentionNote: z.string().nullable(),
  /** What was erased. */
  erasedSummary: z.string().nullable(),
});
export type ErasureRequestSummary = z.infer<typeof erasureRequestSchema>;

/** As the data-protection officer sees a request: never the record it is about. */
export const erasureQueueItemSchema = erasureRequestSchema.extend({
  patientId: uuidSchema,
  /** Masked, so the officer can tell requests apart without reading contact details. */
  requestedByPhone: z.string(),
  decidedBy: staffRefSchema.nullable(),
});
export type ErasureQueueItem = z.infer<typeof erasureQueueItemSchema>;

export const decideErasureSchema = z.object({
  outcome: z.enum(ERASURE_OUTCOMES),
  retentionNote: z
    .string()
    .trim()
    .min(10, 'Say what is kept, and what law requires it')
    .max(2000),
});
export type DecideErasureInput = z.infer<typeof decideErasureSchema>;
