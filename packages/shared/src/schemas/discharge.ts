import { z } from 'zod';
import { uuidSchema } from '../primitives.js';
import { staffRefSchema } from './clinical.js';

/**
 * The discharge summary (sp6-plan.md, DF6 and DF7).
 *
 * Composed from the encounter's own data — the diagnoses, the operation, the
 * medicines, the results, where the patient lay and for how long — then edited
 * and signed by a clinician. Nothing here is generated as clinical prose the
 * system invented: composition copies what was recorded, and a summary is not
 * a summary until a person has signed it.
 *
 * Signing writes it twice: as a versioned clinical note, which is the record,
 * and as a PDF the patient reads in the portal and the next hospital opens.
 */

/** The sections, in the order a discharge summary is read. */
export const DISCHARGE_SECTIONS = [
  { key: 'admission', label: 'Admission and stay' },
  { key: 'diagnoses', label: 'Diagnoses' },
  { key: 'procedures', label: 'Procedures and devices' },
  { key: 'investigations', label: 'Investigations' },
  { key: 'treatment', label: 'Treatment in hospital' },
  { key: 'course', label: 'Course in hospital' },
  { key: 'condition', label: 'Condition at discharge' },
  { key: 'medicines', label: 'Medicines to continue' },
  { key: 'advice', label: 'Advice' },
  { key: 'follow_up', label: 'Follow-up' },
] as const;

export type DischargeSectionKey = (typeof DISCHARGE_SECTIONS)[number]['key'];

export const DISCHARGE_SECTION_KEYS = DISCHARGE_SECTIONS.map((section) => section.key) as [
  DischargeSectionKey,
  ...DischargeSectionKey[],
];

export const DISCHARGE_STATUSES = ['draft', 'signed'] as const;
export type DischargeStatus = (typeof DISCHARGE_STATUSES)[number];

export const dischargeSectionSchema = z.object({
  key: z.enum(DISCHARGE_SECTION_KEYS),
  label: z.string(),
  /** What the clinician will sign. Composed from the record, then edited. */
  text: z.string().max(8000),
  /**
   * True while the text is exactly what composition produced. It turns false
   * the moment somebody edits it, and a re-composition leaves edited sections
   * alone rather than overwriting somebody's words.
   */
  composed: z.boolean(),
});
export type DischargeSection = z.infer<typeof dischargeSectionSchema>;

export const dischargeSummarySchema = z.object({
  id: uuidSchema,
  encounterId: uuidSchema,
  patientId: uuidSchema,
  status: z.enum(DISCHARGE_STATUSES),
  sections: z.array(dischargeSectionSchema),
  composedAt: z.string(),
  composedBy: staffRefSchema,
  signedAt: z.string().nullable(),
  signedBy: staffRefSchema.nullable(),
  /** The versioned note the signature wrote, and the PDF beside it. */
  noteId: uuidSchema.nullable(),
  documentId: uuidSchema.nullable(),
});
export type DischargeSummary = z.infer<typeof dischargeSummarySchema>;

/** Re-composing pulls in anything recorded since, without touching edited text. */
export const composeDischargeSchema = z.object({
  encounterId: uuidSchema,
  onBehalfOfClinicianId: uuidSchema.optional(),
});
export type ComposeDischargeInput = z.infer<typeof composeDischargeSchema>;

export const editDischargeSchema = z.object({
  sections: z
    .array(z.object({ key: z.enum(DISCHARGE_SECTION_KEYS), text: z.string().max(8000) }))
    .min(1),
});
export type EditDischargeInput = z.infer<typeof editDischargeSchema>;

export const signDischargeSchema = z.object({
  /**
   * The clinician signs their own summary. Records staff never sign one:
   * a signature is a clinical statement, not transcription.
   */
  confirmed: z.literal(true),
});
export type SignDischargeInput = z.infer<typeof signDischargeSchema>;
