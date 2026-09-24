import { z } from 'zod';
import { BED_STATUSES, WARD_KINDS, WARD_STATUSES, type WardKind } from '../enums.js';
import { uuidSchema } from '../primitives.js';
import { clinicalReasonSchema } from './clinical.js';

/**
 * Wards, beds, and a stay in one (sp6-plan.md, Decision P1).
 *
 * An admission is an inpatient encounter; where the patient actually lies is a
 * stay of its own, with a start and an end. A transfer ends one stay and
 * starts the next, so the ward round, the census and the bill all read the
 * same history — and a bed-day is arithmetic over it rather than a number
 * somebody typed.
 */

const wardName = z.string().trim().min(1, 'Name the ward').max(100);
const bedLabel = z.string().trim().min(1, 'Label the bed').max(40);

export const createWardSchema = z.object({
  name: wardName,
  kind: z.enum(WARD_KINDS),
  /** Created with its beds, which is how a ward is actually set up. */
  beds: z.array(bedLabel).max(200).default([]),
});
export type CreateWardInput = z.infer<typeof createWardSchema>;

export const updateWardSchema = z
  .object({
    name: wardName.optional(),
    kind: z.enum(WARD_KINDS).optional(),
    status: z.enum(WARD_STATUSES).optional(),
  })
  .refine((input) => Object.keys(input).length > 0, { message: 'Nothing to change' });
export type UpdateWardInput = z.infer<typeof updateWardSchema>;

export const addBedsSchema = z.object({
  labels: z.array(bedLabel).min(1, 'Label at least one bed').max(200),
});
export type AddBedsInput = z.infer<typeof addBedsSchema>;

export const setBedStatusSchema = z.object({
  status: z.enum(BED_STATUSES),
  /** Why it is out of service: repairs, cleaning, an outbreak. */
  reason: z.string().trim().max(200).optional(),
});
export type SetBedStatusInput = z.infer<typeof setBedStatusSchema>;

export const bedSummarySchema = z.object({
  id: uuidSchema,
  wardId: uuidSchema,
  wardName: z.string(),
  label: z.string(),
  status: z.enum(BED_STATUSES),
  blockedReason: z.string().nullable(),
  /** Who is in it now, for the people who may read the record. */
  occupant: z
    .object({
      patientId: uuidSchema,
      name: z.string(),
      mrn: z.string().nullable(),
      encounterId: uuidSchema,
      since: z.string(),
    })
    .nullable(),
});
export type BedSummary = z.infer<typeof bedSummarySchema>;

export const wardSummarySchema = z.object({
  id: uuidSchema,
  name: z.string(),
  kind: z.enum(WARD_KINDS),
  status: z.enum(WARD_STATUSES),
  beds: z.array(bedSummarySchema),
  /** The census, counted from the beds themselves. */
  occupied: z.number().int(),
  free: z.number().int(),
});
export type WardSummary = z.infer<typeof wardSummarySchema>;

export const wardListSchema = z.object({ wards: z.array(wardSummarySchema) });
export type WardList = z.infer<typeof wardListSchema>;

/**
 * Putting a patient into a bed.
 *
 * The decision to admit is clinical, and it is already recorded: it is an
 * inpatient encounter, opened by the clinician who made it (or transcribed for
 * them by records staff, as every clinical entry may be). This is the other
 * half — which bed — and the desk, who holds the board, does it.
 */
export const admitSchema = z.object({
  encounterId: uuidSchema,
  bedId: uuidSchema,
});
export type AdmitInput = z.infer<typeof admitSchema>;

export const transferSchema = z.object({
  bedId: uuidSchema,
  reason: clinicalReasonSchema,
});
export type TransferInput = z.infer<typeof transferSchema>;

export const dischargeSchema = z.object({
  /** How the stay ended, in the words the desk would use. */
  note: z.string().trim().max(500).optional(),
});
export type DischargeInput = z.infer<typeof dischargeSchema>;

export const bedStaySchema = z.object({
  id: uuidSchema,
  bedId: uuidSchema,
  bed: z.string(),
  ward: z.string(),
  wardKind: z.enum(WARD_KINDS),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  movedReason: z.string().nullable(),
  /**
   * Days this stay is charged for: part of a day counts as a day, as every
   * hospital bills it, and a stay that has not ended counts up to now.
   */
  bedDays: z.number().int(),
});
export type BedStay = z.infer<typeof bedStaySchema>;

export const admissionSchema = z.object({
  encounterId: uuidSchema,
  patientId: uuidSchema,
  patientName: z.string(),
  mrn: z.string().nullable(),
  admittedAt: z.string(),
  dischargedAt: z.string().nullable(),
  reasonForAdmission: z.string().nullable(),
  attending: z.object({ id: uuidSchema, name: z.string().nullable() }),
  currentBed: bedSummarySchema.nullable(),
  stays: z.array(bedStaySchema),
  /** Every stay's bed-days added up: what Phase 6 will charge for. */
  bedDays: z.number().int(),
});
export type Admission = z.infer<typeof admissionSchema>;

export const admissionListSchema = z.object({ admissions: z.array(admissionSchema) });
export type AdmissionList = z.infer<typeof admissionListSchema>;

export const admissionsQuerySchema = z.object({
  /** Current admissions by default; `all` includes those already discharged. */
  scope: z.enum(['current', 'all']).default('current'),
  wardId: uuidSchema.optional(),
  patientId: uuidSchema.optional(),
});
export type AdmissionsQuery = z.infer<typeof admissionsQuerySchema>;

export const WARD_KIND_LABELS: Record<WardKind, string> = {
  general: 'General',
  icu: 'Intensive care',
  private: 'Private',
  day_care: 'Day care',
};
