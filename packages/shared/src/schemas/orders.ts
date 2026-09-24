import { z } from 'zod';
import {
  SERVICE_REQUEST_CATEGORIES,
  SERVICE_REQUEST_PRIORITIES,
  SERVICE_REQUEST_STATUSES,
} from '../enums.js';
import { uuidSchema } from '../primitives.js';
import {
  clinicalReasonSchema,
  entryRefSchema,
  hospitalRefSchema,
  staffRefSchema,
} from './clinical.js';

/**
 * Orders (sp6-plan.md, Decision O1).
 *
 * An order is what somebody asked for before there was a result: a liver
 * panel, an ultrasound, a Ksharasutra session. Results — typed values and
 * scanned reports alike — point back at it, so a lab can be asked what is
 * outstanding and a clinician can be told what came back.
 *
 * Asking is not an assertion about the patient, so an order is never
 * superseded the way a diagnosis is. A wrong one is cancelled with a reason,
 * and a new one placed.
 */

/** What was asked for, coded where the terminology has it and named always. */
const requestedSchema = z.object({
  category: z.enum(SERVICE_REQUEST_CATEGORIES),
  /** What the clinician would say: "Liver function panel", "Ultrasound abdomen". */
  requestedDisplay: z.string().trim().min(2, 'Say what is being ordered').max(200),
  /** A code and its system travel together or not at all. */
  requestedCodeSystem: z.string().trim().min(1).max(100).optional(),
  requestedCode: z.string().trim().min(1).max(100).optional(),
  priority: z.enum(SERVICE_REQUEST_PRIORITIES).default('routine'),
  /** Why it was asked for, for whoever performs it. Not a diagnosis. */
  clinicalNote: z.string().trim().max(1000).optional(),
});

export const placeOrderSchema = requestedSchema
  .extend({
    encounterId: uuidSchema,
    /** Required of records staff transcribing for a clinician; clinicians leave it out. */
    onBehalfOfClinicianId: uuidSchema.optional(),
  })
  .refine((order) => !order.requestedCode === !order.requestedCodeSystem, {
    message: 'A code needs the system it comes from',
    path: ['requestedCode'],
  });
export type PlaceOrderInput = z.infer<typeof placeOrderSchema>;

/**
 * Moving an order along: the sample is taken, the work has begun. Only the
 * steps before a result; recording the result is what closes an order.
 */
export const advanceOrderSchema = z.object({
  status: z.enum(['collected', 'in_progress']),
  /** A sample identifier, an accession number, whatever the lab writes down. */
  reference: z.string().trim().max(100).optional(),
});
export type AdvanceOrderInput = z.infer<typeof advanceOrderSchema>;

export const cancelOrderSchema = z.object({
  reason: clinicalReasonSchema,
});
export type CancelOrderInput = z.infer<typeof cancelOrderSchema>;

export const orderSummarySchema = z.object({
  id: uuidSchema,
  patientId: uuidSchema,
  encounterId: uuidSchema,
  hospital: hospitalRefSchema,
  category: z.enum(SERVICE_REQUEST_CATEGORIES),
  requestedDisplay: z.string(),
  requestedCodeSystem: z.string().nullable(),
  requestedCode: z.string().nullable(),
  priority: z.enum(SERVICE_REQUEST_PRIORITIES),
  clinicalNote: z.string().nullable(),
  status: z.enum(SERVICE_REQUEST_STATUSES),
  /** The lab's own reference for the sample or study, once there is one. */
  reference: z.string().nullable(),
  orderedAt: z.string(),
  orderedBy: staffRefSchema,
  entry: entryRefSchema,
  /** When each step happened, as far as the order has got. */
  collectedAt: z.string().nullable(),
  inProgressAt: z.string().nullable(),
  resultedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  cancelledReason: z.string().nullable(),
  /** How many results have been recorded against it. */
  resultCount: z.number().int(),
});
export type OrderSummary = z.infer<typeof orderSummarySchema>;

export const orderListSchema = z.object({
  orders: z.array(orderSummarySchema),
  sharedFromOtherHospitals: z.boolean(),
});
export type OrderList = z.infer<typeof orderListSchema>;

/**
 * The worklist: what this hospital still owes somebody. Outstanding by
 * default, because a finished order is of no use to the person working
 * through the list.
 */
export const worklistQuerySchema = z.object({
  category: z.enum(SERVICE_REQUEST_CATEGORIES).optional(),
  status: z.enum(SERVICE_REQUEST_STATUSES).optional(),
  patientId: uuidSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type WorklistQuery = z.infer<typeof worklistQuerySchema>;

export const worklistEntrySchema = orderSummarySchema.extend({
  patient: z.object({ id: uuidSchema, name: z.string(), mrn: z.string().nullable() }),
  /** Whole hours since it was ordered, so a list can show what has waited longest. */
  waitingHours: z.number().int(),
});
export type WorklistEntry = z.infer<typeof worklistEntrySchema>;

export const worklistSchema = z.object({
  entries: z.array(worklistEntrySchema),
});
export type Worklist = z.infer<typeof worklistSchema>;
