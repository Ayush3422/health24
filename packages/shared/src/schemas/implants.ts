import { z } from 'zod';
import { uuidSchema } from '../primitives.js';
import {
  clinicalReasonSchema,
  entryRefSchema,
  hospitalRefSchema,
  staffRefSchema,
} from './clinical.js';

/**
 * Implants and devices (sp6-plan.md, Decision Q1).
 *
 * A record of what was put into a patient, and how it can be found again. Not
 * housekeeping: when a manufacturer recalls a batch, a hospital has to answer
 * "which of our patients has one of these" the same day — so the serial or lot
 * is searchable, and the record is never deleted, only superseded like every
 * other clinical entry.
 *
 * It hangs off the encounter rather than the procedure row, because a
 * procedure may be corrected into a new version and the device is a fact about
 * the patient either way. The procedure it belongs to is named on it, so the
 * operation it came from is never lost.
 */

const implantContentSchema = z.object({
  /** What it is: "Titanium hip stem", "Drug-eluting stent". */
  name: z.string().trim().min(2, 'Name the device').max(200),
  manufacturer: z.string().trim().max(200).optional(),
  model: z.string().trim().max(120).optional(),
  /**
   * What identifies this one: a serial number, or the lot a batch came from.
   * Optional because a recall notice is sometimes the first time anybody
   * writes one down — and a device with no number is still worth recording.
   */
  serialOrLot: z.string().trim().max(120).optional(),
  /** Defaults to the procedure's own time, and then to now. */
  implantedAt: z.string().datetime({ offset: true }).optional(),
  /** Site, size, anything the next surgeon needs: "left hip, 36 mm head". */
  notes: z.string().trim().max(2000).optional(),
});

export const recordImplantSchema = implantContentSchema.extend({
  encounterId: uuidSchema,
  /** The procedure it was implanted during, where there is one recorded. */
  procedureId: uuidSchema.optional(),
  onBehalfOfClinicianId: uuidSchema.optional(),
});
export type RecordImplantInput = z.infer<typeof recordImplantSchema>;

export const correctImplantSchema = implantContentSchema.extend({
  procedureId: uuidSchema.optional(),
  reason: clinicalReasonSchema,
});
export type CorrectImplantInput = z.infer<typeof correctImplantSchema>;

export const implantSummarySchema = z.object({
  id: uuidSchema,
  patientId: uuidSchema,
  encounterId: uuidSchema,
  hospital: hospitalRefSchema,
  procedureId: uuidSchema.nullable(),
  /** Kept on the row, so the operation is named even after a correction. */
  procedureName: z.string().nullable(),
  name: z.string(),
  manufacturer: z.string().nullable(),
  model: z.string().nullable(),
  serialOrLot: z.string().nullable(),
  implantedAt: z.string(),
  notes: z.string().nullable(),
  recordedAt: z.string(),
  recordedBy: staffRefSchema,
  entry: entryRefSchema,
  supersedesId: uuidSchema.nullable(),
});
export type ImplantSummary = z.infer<typeof implantSummarySchema>;

export const implantListSchema = z.object({
  implants: z.array(implantSummarySchema),
  sharedFromOtherHospitals: z.boolean(),
});
export type ImplantList = z.infer<typeof implantListSchema>;

/** A recall: find every device of this batch, and the patients who carry one. */
export const implantSearchSchema = z.object({
  /** Matched against the serial or lot, and against the model. */
  q: z.string().trim().min(2, 'Enter a serial number, a lot or a model').max(120),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ImplantSearch = z.infer<typeof implantSearchSchema>;

export const implantSearchResultSchema = implantSummarySchema.extend({
  patient: z.object({ id: uuidSchema, name: z.string(), mrn: z.string().nullable() }),
});
export type ImplantSearchResult = z.infer<typeof implantSearchResultSchema>;

export const implantSearchResultsSchema = z.object({
  results: z.array(implantSearchResultSchema),
});
export type ImplantSearchResults = z.infer<typeof implantSearchResultsSchema>;
