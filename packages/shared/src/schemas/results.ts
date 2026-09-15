import { z } from 'zod';
import {
  OBSERVATION_SOURCES,
  RESULT_INTERPRETATIONS,
  type ResultInterpretation,
} from '../enums.js';
import { uuidSchema } from '../primitives.js';
import {
  clinicalDateSchema,
  clinicalReasonSchema,
  hospitalRefSchema,
  staffRefSchema,
} from './clinical.js';

/**
 * Lab results (SP4): numeric values typed from a report against a curated
 * panel, stored as LOINC-coded observations (planning.md D7, §9).
 *
 * UNVERIFIED. The LOINC codes, units and default reference ranges below were
 * assembled for development. Before production they must be checked against
 * a licensed LOINC release and reviewed by the clinical reviewer
 * (sp4-plan.md), and LOINC's attribution shown wherever the codes are.
 *
 * Default ranges only prefill the form: each result stores the range printed
 * on its own report (sp4-plan.md, DF3), and the abnormal flag is computed
 * against that.
 */
export const LAB_PANELS_REVIEWED = false;

export interface LabUnit {
  /** UCUM. */
  code: string;
  label: string;
  /** Multiplying a value in this unit by this gives the canonical unit. */
  toCanonical: number;
}

export interface LabAnalyte {
  code: string;
  display: string;
  label: string;
  /** The first is canonical: what trends are drawn in. Only these are accepted. */
  units: readonly [LabUnit, ...LabUnit[]];
  /** Plausibility bounds, in the canonical unit: they reject typing errors, not unusual patients. */
  min: number;
  max: number;
  defaultRange?: { low?: number; high?: number };
}

export interface LabPanel {
  label: string;
  analytes: readonly LabAnalyte[];
}

const unit = (code: string, label = code, toCanonical = 1): LabUnit => ({
  code,
  label,
  toCanonical,
});

const MG_DL = unit('mg/dL');
const G_DL = unit('g/dL');
const G_L = unit('g/L', 'g/L', 0.1);
const U_L = unit('U/L');
const MMOL_L = unit('mmol/L');

export const LAB_PANELS = {
  cbc: {
    label: 'Complete blood count (CBC)',
    analytes: [
      {
        code: '718-7',
        display: 'Hemoglobin [Mass/volume] in Blood',
        label: 'Haemoglobin',
        units: [G_DL, G_L],
        min: 1,
        max: 25,
        defaultRange: { low: 12, high: 17 },
      },
      {
        code: '4544-3',
        display: 'Hematocrit [Volume Fraction] of Blood by Automated count',
        label: 'Haematocrit (PCV)',
        units: [unit('%')],
        min: 5,
        max: 80,
        defaultRange: { low: 36, high: 50 },
      },
      {
        code: '789-8',
        display: 'Erythrocytes [#/volume] in Blood by Automated count',
        label: 'RBC count',
        units: [unit('10*6/uL', 'million/µL')],
        min: 0.5,
        max: 10,
        defaultRange: { low: 4, high: 5.9 },
      },
      {
        code: '6690-2',
        display: 'Leukocytes [#/volume] in Blood by Automated count',
        label: 'WBC count',
        units: [unit('10*3/uL', 'thousand/µL'), unit('/uL', 'cells/µL', 0.001)],
        min: 0.1,
        max: 500,
        defaultRange: { low: 4, high: 11 },
      },
      {
        code: '777-3',
        display: 'Platelets [#/volume] in Blood by Automated count',
        label: 'Platelet count',
        units: [unit('10*3/uL', 'thousand/µL'), unit('10*5/uL', 'lakh/µL', 100)],
        min: 1,
        max: 2000,
        defaultRange: { low: 150, high: 450 },
      },
      {
        code: '787-2',
        display: 'MCV [Entitic volume] by Automated count',
        label: 'MCV',
        units: [unit('fL')],
        min: 40,
        max: 150,
        defaultRange: { low: 80, high: 100 },
      },
    ],
  },
  lft: {
    label: 'Liver function tests (LFT)',
    analytes: [
      {
        code: '1975-2',
        display: 'Bilirubin.total [Mass/volume] in Serum or Plasma',
        label: 'Bilirubin, total',
        units: [MG_DL, unit('umol/L', 'µmol/L', 1 / 17.104)],
        min: 0,
        max: 50,
        defaultRange: { low: 0.2, high: 1.2 },
      },
      {
        code: '1968-7',
        display: 'Bilirubin.direct [Mass/volume] in Serum or Plasma',
        label: 'Bilirubin, direct',
        units: [MG_DL, unit('umol/L', 'µmol/L', 1 / 17.104)],
        min: 0,
        max: 40,
        defaultRange: { high: 0.3 },
      },
      {
        code: '1742-6',
        display: 'Alanine aminotransferase [Enzymatic activity/volume] in Serum or Plasma',
        label: 'ALT (SGPT)',
        units: [U_L],
        min: 1,
        max: 20000,
        defaultRange: { low: 7, high: 56 },
      },
      {
        code: '1920-8',
        display: 'Aspartate aminotransferase [Enzymatic activity/volume] in Serum or Plasma',
        label: 'AST (SGOT)',
        units: [U_L],
        min: 1,
        max: 20000,
        defaultRange: { low: 10, high: 40 },
      },
      {
        code: '6768-6',
        display: 'Alkaline phosphatase [Enzymatic activity/volume] in Serum or Plasma',
        label: 'Alkaline phosphatase',
        units: [U_L],
        min: 1,
        max: 5000,
        defaultRange: { low: 44, high: 147 },
      },
      {
        code: '2885-2',
        display: 'Protein [Mass/volume] in Serum or Plasma',
        label: 'Total protein',
        units: [G_DL, G_L],
        min: 1,
        max: 15,
        defaultRange: { low: 6, high: 8.3 },
      },
      {
        code: '1751-7',
        display: 'Albumin [Mass/volume] in Serum or Plasma',
        label: 'Albumin',
        units: [G_DL, G_L],
        min: 0.5,
        max: 7,
        defaultRange: { low: 3.5, high: 5 },
      },
    ],
  },
  kft: {
    label: 'Kidney function tests (KFT)',
    analytes: [
      {
        code: '3091-6',
        display: 'Urea [Mass/volume] in Serum or Plasma',
        label: 'Urea',
        units: [MG_DL, unit('mmol/L', 'mmol/L', 6.006)],
        min: 1,
        max: 500,
        defaultRange: { low: 15, high: 40 },
      },
      {
        code: '2160-0',
        display: 'Creatinine [Mass/volume] in Serum or Plasma',
        label: 'Creatinine',
        units: [MG_DL, unit('umol/L', 'µmol/L', 1 / 88.42)],
        min: 0.1,
        max: 30,
        defaultRange: { low: 0.6, high: 1.3 },
      },
      {
        code: '3084-1',
        display: 'Urate [Mass/volume] in Serum or Plasma',
        label: 'Uric acid',
        units: [MG_DL, unit('umol/L', 'µmol/L', 1 / 59.48)],
        min: 0.5,
        max: 30,
        defaultRange: { low: 3.5, high: 7.2 },
      },
      {
        code: '2951-2',
        display: 'Sodium [Moles/volume] in Serum or Plasma',
        label: 'Sodium',
        units: [MMOL_L, unit('meq/L', 'mEq/L')],
        min: 90,
        max: 200,
        defaultRange: { low: 135, high: 145 },
      },
      {
        code: '2823-3',
        display: 'Potassium [Moles/volume] in Serum or Plasma',
        label: 'Potassium',
        units: [MMOL_L, unit('meq/L', 'mEq/L')],
        min: 1,
        max: 10,
        defaultRange: { low: 3.5, high: 5.1 },
      },
      {
        code: '2075-0',
        display: 'Chloride [Moles/volume] in Serum or Plasma',
        label: 'Chloride',
        units: [MMOL_L, unit('meq/L', 'mEq/L')],
        min: 60,
        max: 150,
        defaultRange: { low: 98, high: 107 },
      },
    ],
  },
  lipid: {
    label: 'Lipid profile',
    analytes: [
      {
        code: '2093-3',
        display: 'Cholesterol [Mass/volume] in Serum or Plasma',
        label: 'Total cholesterol',
        units: [MG_DL, unit('mmol/L', 'mmol/L', 38.67)],
        min: 20,
        max: 1000,
        defaultRange: { high: 200 },
      },
      {
        code: '2571-8',
        display: 'Triglyceride [Mass/volume] in Serum or Plasma',
        label: 'Triglycerides',
        units: [MG_DL, unit('mmol/L', 'mmol/L', 88.57)],
        min: 10,
        max: 5000,
        defaultRange: { high: 150 },
      },
      {
        code: '2085-9',
        display: 'Cholesterol in HDL [Mass/volume] in Serum or Plasma',
        label: 'HDL cholesterol',
        units: [MG_DL, unit('mmol/L', 'mmol/L', 38.67)],
        min: 5,
        max: 200,
        defaultRange: { low: 40 },
      },
      {
        code: '13457-7',
        display: 'Cholesterol in LDL [Mass/volume] in Serum or Plasma by calculation',
        label: 'LDL cholesterol',
        units: [MG_DL, unit('mmol/L', 'mmol/L', 38.67)],
        min: 5,
        max: 600,
        defaultRange: { high: 100 },
      },
    ],
  },
  hba1c: {
    label: 'HbA1c',
    analytes: [
      {
        code: '4548-4',
        display: 'Hemoglobin A1c/Hemoglobin.total in Blood',
        label: 'HbA1c',
        units: [unit('%')],
        min: 3,
        max: 20,
        defaultRange: { high: 5.7 },
      },
    ],
  },
  thyroid: {
    label: 'Thyroid (TSH)',
    analytes: [
      {
        code: '3016-3',
        display: 'Thyrotropin [Units/volume] in Serum or Plasma',
        label: 'TSH',
        units: [unit('m[IU]/L', 'mIU/L'), unit('u[IU]/mL', 'µIU/mL')],
        min: 0.001,
        max: 500,
        defaultRange: { low: 0.4, high: 4 },
      },
    ],
  },
  glucose: {
    label: 'Blood glucose (fasting and post-prandial)',
    analytes: [
      {
        code: '1558-6',
        display: 'Fasting glucose [Mass/volume] in Serum or Plasma',
        label: 'Glucose, fasting',
        units: [MG_DL, unit('mmol/L', 'mmol/L', 18.016)],
        min: 10,
        max: 1500,
        defaultRange: { low: 70, high: 100 },
      },
      {
        code: '1521-4',
        display: 'Glucose [Mass/volume] in Serum or Plasma --2 hours post meal',
        label: 'Glucose, post-prandial (2 h)',
        units: [MG_DL, unit('mmol/L', 'mmol/L', 18.016)],
        min: 10,
        max: 1500,
        defaultRange: { high: 140 },
      },
    ],
  },
} as const satisfies Record<string, LabPanel>;

export type LabPanelKey = keyof typeof LAB_PANELS;
export const LAB_PANEL_KEYS = Object.keys(LAB_PANELS) as [LabPanelKey, ...LabPanelKey[]];

export function findAnalyte(code: string): { panel: LabPanelKey; analyte: LabAnalyte } | null {
  for (const panel of LAB_PANEL_KEYS) {
    const analyte = (LAB_PANELS[panel].analytes as readonly LabAnalyte[]).find(
      (candidate) => candidate.code === code,
    );
    if (analyte) return { panel, analyte };
  }
  return null;
}

/** A value in the analyte's canonical unit, or null for a unit the analyte does not accept. */
export function toCanonicalValue(
  analyte: LabAnalyte,
  value: number,
  unitCode: string,
): number | null {
  const found = analyte.units.find((candidate) => candidate.code === unitCode);
  if (!found) return null;
  return Math.round(value * found.toCanonical * 10_000) / 10_000;
}

/**
 * The abnormal flag: a comparison against the range printed on the report —
 * not an interpretation (sp4-plan.md, S7). With no numeric range, the lab's
 * own flag is used; with neither, there is no flag.
 */
export function interpretResult(input: {
  value: number;
  low?: number | null;
  high?: number | null;
  labFlag?: string | null;
}): ResultInterpretation | null {
  const { value, low, high } = input;

  if (low != null && value < low) return 'low';
  if (high != null && value > high) return 'high';
  if (low != null || high != null) return 'normal';

  const flag = input.labFlag?.trim().toUpperCase();
  if (!flag) return null;
  if (flag.startsWith('H')) return 'high';
  if (flag.startsWith('L')) return 'low';
  return 'abnormal';
}

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

const finite = z.number().finite();

export const recordResultsSchema = z
  .object({
    patientId: uuidSchema,
    encounterId: uuidSchema.optional(),
    /** The report the values were typed from. */
    documentId: uuidSchema.optional(),
    panel: z.enum(LAB_PANEL_KEYS),
    /** When the specimen was collected. */
    collectedAt: z.string().datetime({ offset: true }),
    performingFacility: z.string().trim().min(1).max(200).optional(),
    results: z
      .array(
        z.object({
          code: z.string(),
          value: finite,
          unit: z.string(),
          referenceLow: finite.optional(),
          referenceHigh: finite.optional(),
          /** A range printed as text: "< 200", "Adults: 3.5 – 5.0". */
          referenceText: z.string().trim().min(1).max(200).optional(),
          /** As printed beside the value: H, L, *. */
          labFlag: z.string().trim().min(1).max(10).optional(),
        }),
      )
      .min(1, 'Enter at least one result')
      .max(40),
  })
  .superRefine((input, ctx) => {
    if (Date.parse(input.collectedAt) > Date.now() + 5 * 60_000) {
      ctx.addIssue({
        code: 'custom',
        path: ['collectedAt'],
        message: 'The collection time is in the future',
      });
    }

    const analytes = LAB_PANELS[input.panel].analytes as readonly LabAnalyte[];
    const seen = new Set<string>();

    input.results.forEach((result, index) => {
      const path = ['results', index];
      const analyte = analytes.find((candidate) => candidate.code === result.code);

      if (!analyte) {
        ctx.addIssue({
          code: 'custom',
          path: [...path, 'code'],
          message: `Not part of ${LAB_PANELS[input.panel].label}`,
        });
        return;
      }

      if (seen.has(result.code)) {
        ctx.addIssue({
          code: 'custom',
          path: [...path, 'code'],
          message: `${analyte.label} is entered twice`,
        });
      }
      seen.add(result.code);

      const canonical = toCanonicalValue(analyte, result.value, result.unit);

      if (canonical === null) {
        ctx.addIssue({
          code: 'custom',
          path: [...path, 'unit'],
          message: `${analyte.label} is not reported in ${result.unit}`,
        });
      } else if (canonical < analyte.min || canonical > analyte.max) {
        ctx.addIssue({
          code: 'custom',
          path: [...path, 'value'],
          message: `${analyte.label} of ${result.value} ${result.unit} is not plausible`,
        });
      }

      if (
        result.referenceLow !== undefined &&
        result.referenceHigh !== undefined &&
        result.referenceLow > result.referenceHigh
      ) {
        ctx.addIssue({
          code: 'custom',
          path: [...path, 'referenceHigh'],
          message: 'The range ends below where it starts',
        });
      }
    });
  });
export type RecordResultsInput = z.infer<typeof recordResultsSchema>;

export const markResultsInErrorSchema = z.object({ reason: clinicalReasonSchema });
export type MarkResultsInErrorInput = z.infer<typeof markResultsInErrorSchema>;

export const listResultsQuerySchema = z.object({
  panel: z.enum(LAB_PANEL_KEYS).optional(),
  /** Collection dates, inclusive, in India Standard Time. */
  from: clinicalDateSchema.optional(),
  to: clinicalDateSchema.optional(),
});
export type ListResultsQuery = z.infer<typeof listResultsQuerySchema>;

export const resultTrendQuerySchema = z.object({ code: z.string().min(1) });
export type ResultTrendQuery = z.infer<typeof resultTrendQuerySchema>;

export const labResultSchema = z.object({
  observationId: uuidSchema,
  code: z.string(),
  display: z.string(),
  label: z.string(),
  value: z.number(),
  unit: z.string(),
  valueCanonical: z.number(),
  unitCanonical: z.string(),
  referenceLow: z.number().nullable(),
  referenceHigh: z.number().nullable(),
  referenceText: z.string().nullable(),
  labFlag: z.string().nullable(),
  interpretation: z.enum(RESULT_INTERPRETATIONS).nullable(),
});
export type LabResult = z.infer<typeof labResultSchema>;

export const resultSetSchema = z.object({
  /** The group id: one panel as collected. */
  id: uuidSchema,
  patientId: uuidSchema,
  encounterId: uuidSchema.nullable(),
  documentId: uuidSchema.nullable(),
  hospital: hospitalRefSchema,
  panel: z.enum(LAB_PANEL_KEYS),
  panelLabel: z.string(),
  collectedAt: z.string(),
  performingFacility: z.string().nullable(),
  source: z.enum(OBSERVATION_SOURCES),
  results: z.array(labResultSchema),
  recordedBy: staffRefSchema,
  recordedAt: z.string(),
});
export type ResultSet = z.infer<typeof resultSetSchema>;

export const resultSetListSchema = z.object({
  sets: z.array(resultSetSchema),
  sharedFromOtherHospitals: z.boolean(),
});
export type ResultSetList = z.infer<typeof resultSetListSchema>;

export const resultTrendSchema = z.object({
  analyte: z.object({ code: z.string(), display: z.string(), label: z.string(), unit: z.string() }),
  /** Oldest first, every value in the canonical unit, with its range converted alike. */
  points: z.array(
    z.object({
      observationId: uuidSchema,
      setId: uuidSchema,
      collectedAt: z.string(),
      value: z.number(),
      referenceLow: z.number().nullable(),
      referenceHigh: z.number().nullable(),
      interpretation: z.enum(RESULT_INTERPRETATIONS).nullable(),
      hospital: hospitalRefSchema,
      valueAsEntered: z.number(),
      unitAsEntered: z.string(),
    }),
  ),
  sharedFromOtherHospitals: z.boolean(),
});
export type ResultTrend = z.infer<typeof resultTrendSchema>;
