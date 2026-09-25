import { z } from 'zod';
import { uuidSchema } from '../primitives.js';
import { staffRefSchema } from './clinical.js';

/**
 * Reporting (sp6-plan.md, Decision S1).
 *
 * Every figure here is counted from the operational tables, under the
 * hospital's own row-level security — so a report can never show one hospital
 * another's numbers, and never disagrees with the record it was counted from.
 *
 * Days that are over are counted once and kept in a daily summary; today is
 * counted afresh each time, because it is not over.
 */

/** A period, as whole days in India Standard Time, both ends included. */
export const reportRangeSchema = z
  .object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a date as YYYY-MM-DD'),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a date as YYYY-MM-DD'),
  })
  .refine((range) => range.from <= range.to, {
    message: 'The period starts before it ends',
    path: ['to'],
  });
export type ReportRange = z.infer<typeof reportRangeSchema>;

/** One row of a counted report: what it is, and how many. */
export const countRowSchema = z.object({
  key: z.string(),
  label: z.string(),
  count: z.number().int(),
});
export type CountRow = z.infer<typeof countRowSchema>;

export const dayCountSchema = z.object({ date: z.string(), count: z.number().int() });
export type DayCount = z.infer<typeof dayCountSchema>;

export const footfallQuerySchema = reportRangeSchema.and(
  z.object({
    /** How the total is broken down beside the day-by-day series. */
    by: z.enum(['class', 'system', 'clinician']).default('class'),
  }),
);
export type FootfallQuery = z.infer<typeof footfallQuerySchema>;

export const footfallReportSchema = z.object({
  total: z.number().int(),
  byDay: z.array(dayCountSchema),
  breakdown: z.array(countRowSchema),
});
export type FootfallReport = z.infer<typeof footfallReportSchema>;

export const diagnosisReportSchema = z.object({
  total: z.number().int(),
  /** Every diagnosis coded in the period, commonest first. */
  diagnoses: z.array(
    countRowSchema.extend({
      system: z.string(),
      /** The ICD-11 code it carries as well, where the mapping gave one. */
      icd11Code: z.string().nullable(),
      icd11Display: z.string().nullable(),
    }),
  ),
});
export type DiagnosisReport = z.infer<typeof diagnosisReportSchema>;

export const prescriptionReportSchema = z.object({
  total: z.number().int(),
  medicines: z.array(countRowSchema),
  bySystem: z.array(countRowSchema),
});
export type PrescriptionReport = z.infer<typeof prescriptionReportSchema>;

export const revenueReportSchema = z.object({
  /** Invoiced, received and still owed over the period, in paise. */
  invoicedPaise: z.number().int(),
  receivedPaise: z.number().int(),
  creditedPaise: z.number().int(),
  outstandingPaise: z.number().int(),
  byDay: z.array(z.object({ date: z.string(), invoicedPaise: z.number().int() })),
  byCategory: z.array(
    z.object({ key: z.string(), label: z.string(), amountPaise: z.number().int() }),
  ),
  byMethod: z.array(
    z.object({ key: z.string(), label: z.string(), amountPaise: z.number().int() }),
  ),
});
export type RevenueReport = z.infer<typeof revenueReportSchema>;

/**
 * What the record itself says is unfinished.
 *
 * Not a scolding: each of these is a thing somebody can put right, and the
 * report exists so that nobody has to go looking for them.
 */
export const dataQualityReportSchema = z.object({
  checks: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      /** What it means and what to do about it, in a sentence. */
      explanation: z.string(),
      count: z.number().int(),
    }),
  ),
});
export type DataQualityReport = z.infer<typeof dataQualityReportSchema>;

// ---------------------------------------------------------------------------
// The statutory return (DF10)
// ---------------------------------------------------------------------------

export const STATUTORY_RETURN_KINDS = ['ayush_morbidity'] as const;
export type StatutoryReturnKind = (typeof STATUTORY_RETURN_KINDS)[number];

export const morbidityRowSchema = z.object({
  namasteCode: z.string(),
  namasteDisplay: z.string(),
  icd11Code: z.string().nullable(),
  icd11Display: z.string().nullable(),
  total: z.number().int(),
  male: z.number().int(),
  female: z.number().int(),
  other: z.number().int(),
});
export type MorbidityRow = z.infer<typeof morbidityRowSchema>;

export const statutoryReturnSchema = z.object({
  id: uuidSchema,
  kind: z.enum(STATUTORY_RETURN_KINDS),
  periodFrom: z.string(),
  periodTo: z.string(),
  generatedAt: z.string(),
  generatedBy: staffRefSchema,
  rows: z.array(morbidityRowSchema),
  total: z.number().int(),
  submittedAt: z.string().nullable(),
  submittedBy: staffRefSchema.nullable(),
  /** The acknowledgement the ministry gave, where there is one. */
  reference: z.string().nullable(),
});
export type StatutoryReturn = z.infer<typeof statutoryReturnSchema>;

export const generateReturnSchema = reportRangeSchema;
export type GenerateReturnInput = z.infer<typeof generateReturnSchema>;

export const submitReturnSchema = z.object({
  /** What the ministry gave back, if anything: an acknowledgement number. */
  reference: z.string().trim().max(120).optional(),
});
export type SubmitReturnInput = z.infer<typeof submitReturnSchema>;

export const statutoryReturnListSchema = z.object({
  returns: z.array(statutoryReturnSchema.omit({ rows: true })),
});
export type StatutoryReturnList = z.infer<typeof statutoryReturnListSchema>;
