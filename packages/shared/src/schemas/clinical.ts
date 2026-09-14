import { z } from 'zod';
import {
  ALLERGY_CATEGORIES,
  ALLERGY_CLINICAL_STATUSES,
  ALLERGY_CRITICALITIES,
  BREAK_GLASS_REVIEW_OUTCOMES,
  CLINICAL_DATA_CATEGORIES,
  CONDITION_CLINICAL_STATUSES,
  CONDITION_VERIFICATION_STATUSES,
  CONSENT_CAPTURE_METHODS,
  DURATION_UNITS,
  ENCOUNTER_CLASSES,
  ENCOUNTER_STATUSES,
  ENTRY_SOURCES,
  FOOD_TIMINGS,
  MEDICATION_REQUEST_STATUSES,
  MEDICATION_ROUTES,
  SYSTEMS_OF_MEDICINE,
  USER_STATUSES,
  VERSION_STATUSES,
} from '../enums.js';
import { paginationSchema, uuidSchema } from '../primitives.js';
import {
  autoCodeResultSchema,
  codingSchema,
  conceptCodeSchema,
  terminologyKeySchema,
} from './terminology.js';

/**
 * The clinical record's API contracts.
 *
 * Every entry names the hospital that recorded it, and says whether that is
 * the caller's own. A clinician reading a shared record must always be able to
 * tell what their own hospital wrote from what arrived under consent.
 */

/** Why something was cancelled or corrected. Recorded, and shown in history. */
export const clinicalReasonSchema = z.string().trim().min(3).max(500);

/** A calendar date, YYYY-MM-DD, as India Standard Time understands it. */
export const clinicalDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a date as YYYY-MM-DD')
  .refine((value) => !Number.isNaN(Date.parse(value)), { message: 'Not a real date' });

export const hospitalRefSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  /** True when the caller's own hospital recorded this. */
  isOwn: z.boolean(),
});
export type HospitalRef = z.infer<typeof hospitalRefSchema>;

/**
 * A staff member as shown on a clinical entry. The name is null for another
 * hospital's staff, whose directory is not shared.
 */
export const staffRefSchema = z.object({
  id: uuidSchema,
  name: z.string().nullable(),
});

/**
 * How an entry reached the record (Decision C). `enteredBy` typed it; the
 * clinician named on the entry — attending, recordedBy or prescriber — owns
 * the clinical decision. For a direct entry they are the same person.
 */
export const entryRefSchema = z.object({
  source: z.enum(ENTRY_SOURCES),
  enteredBy: staffRefSchema,
});
export type EntryRef = z.infer<typeof entryRefSchema>;

/**
 * The clinician a transcribed entry belongs to. Required from medical records
 * staff; clinicians leave it out and enter in their own name.
 */
const onBehalfOfSchema = uuidSchema.optional();

/** A clinician records staff may transcribe for. */
export const clinicianOptionSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  systemOfMedicine: z.enum(SYSTEMS_OF_MEDICINE).nullable(),
  /** Deactivated clinicians remain, so an old file can still be transcribed in their name. */
  status: z.enum(USER_STATUSES),
});
export type ClinicianOption = z.infer<typeof clinicianOptionSchema>;

// ---------------------------------------------------------------------------
// Encounters
// ---------------------------------------------------------------------------

export const openEncounterSchema = z.object({
  patientId: uuidSchema,
  onBehalfOfClinicianId: onBehalfOfSchema,
  class: z.enum(ENCOUNTER_CLASSES).default('outpatient'),
  /** Defaults to the clinician's own system of medicine. */
  systemOfMedicine: z.enum(SYSTEMS_OF_MEDICINE).optional(),
  chiefComplaint: z.string().trim().max(1000).optional(),
});
export type OpenEncounterInput = z.infer<typeof openEncounterSchema>;

export const cancelEncounterSchema = z.object({
  reason: clinicalReasonSchema,
});
export type CancelEncounterInput = z.infer<typeof cancelEncounterSchema>;

/**
 * Listing encounters.
 *
 * With `patientId`: that patient's encounters at every hospital the caller may
 * see. Without it: the caller's hospital's worklist for one day, today by
 * default.
 */
export const listEncountersQuerySchema = paginationSchema.extend({
  patientId: uuidSchema.optional(),
  status: z.enum(ENCOUNTER_STATUSES).optional(),
  date: clinicalDateSchema.optional(),
});
export type ListEncountersQuery = z.infer<typeof listEncountersQuerySchema>;

export const encounterSummarySchema = z.object({
  id: uuidSchema,
  patientId: uuidSchema,
  hospital: hospitalRefSchema,
  class: z.enum(ENCOUNTER_CLASSES),
  systemOfMedicine: z.enum(SYSTEMS_OF_MEDICINE),
  status: z.enum(ENCOUNTER_STATUSES),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  chiefComplaint: z.string().nullable(),
  statusReason: z.string().nullable(),
  attending: staffRefSchema,
  entry: entryRefSchema,
  /** Present where the caller's hospital knows the patient: name and its own MRN. */
  patient: z.object({ name: z.string(), mrn: z.string().nullable() }).nullable(),
});
export type EncounterSummary = z.infer<typeof encounterSummarySchema>;

// ---------------------------------------------------------------------------
// Allergies
// ---------------------------------------------------------------------------

export const recordAllergySchema = z.object({
  patientId: uuidSchema,
  onBehalfOfClinicianId: onBehalfOfSchema,
  encounterId: uuidSchema.optional(),
  substance: z.string().trim().min(1, 'Name the substance').max(200),
  category: z.enum(ALLERGY_CATEGORIES),
  criticality: z.enum(ALLERGY_CRITICALITIES).default('unable_to_assess'),
  reaction: z.string().trim().max(500).optional(),
  note: z.string().trim().max(1000).optional(),
});
export type RecordAllergyInput = z.infer<typeof recordAllergySchema>;

export const allergySummarySchema = z.object({
  id: uuidSchema,
  patientId: uuidSchema,
  hospital: hospitalRefSchema,
  substance: z.string(),
  category: z.enum(ALLERGY_CATEGORIES),
  criticality: z.enum(ALLERGY_CRITICALITIES),
  clinicalStatus: z.enum(ALLERGY_CLINICAL_STATUSES),
  /** The entry this one corrected, when it is a correction. */
  supersedesId: uuidSchema.nullable(),
  reaction: z.string().nullable(),
  note: z.string().nullable(),
  recordedAt: z.string(),
  recordedBy: staffRefSchema,
  entry: entryRefSchema,
});
export type AllergySummary = z.infer<typeof allergySummarySchema>;

/**
 * The allergy banner shown on every clinical screen for a patient.
 *
 * An empty list is not "no known allergies". It means none are recorded in
 * the records the caller can see — which is why the banner also says whether
 * any other hospital's allergy records are shared with the caller at all.
 */
export const allergyBannerSchema = z.object({
  allergies: z.array(allergySummarySchema),
  sharedFromOtherHospitals: z.boolean(),
});
export type AllergyBanner = z.infer<typeof allergyBannerSchema>;

// ---------------------------------------------------------------------------
// Diagnoses
// ---------------------------------------------------------------------------

/**
 * Recording a diagnosis.
 *
 * The clinician names one code in their own vocabulary. Everything else that
 * is attached — the TM2 translation, any advisory biomedical code — is decided
 * by the server from approved mappings, never supplied by the client.
 */
export const recordDiagnosisSchema = z.object({
  encounterId: uuidSchema,
  onBehalfOfClinicianId: onBehalfOfSchema,
  /** The vocabulary the code is from. NAMASTE unless the clinician codes in ICD-11 directly. */
  system: terminologyKeySchema.default('namaste'),
  code: conceptCodeSchema,
  clinicalStatus: z.enum(CONDITION_CLINICAL_STATUSES).default('active'),
  verificationStatus: z.enum(CONDITION_VERIFICATION_STATUSES).default('confirmed'),
  /** The encounter's main diagnosis. At most one per encounter. */
  isPrimary: z.boolean().default(false),
  onsetDate: clinicalDateSchema
    .refine((value) => new Date(value) <= new Date(), { message: 'Onset cannot be in the future' })
    .optional(),
  note: z.string().trim().max(2000).optional(),
});
export type RecordDiagnosisInput = z.infer<typeof recordDiagnosisSchema>;

export const conditionSummarySchema = z.object({
  id: uuidSchema,
  patientId: uuidSchema,
  encounterId: uuidSchema,
  hospital: hospitalRefSchema,
  clinicalStatus: z.enum(CONDITION_CLINICAL_STATUSES),
  verificationStatus: z.enum(CONDITION_VERIFICATION_STATUSES),
  supersedesId: uuidSchema.nullable(),
  isPrimary: z.boolean(),
  onsetDate: z.string().nullable(),
  note: z.string().nullable(),
  recordedAt: z.string(),
  recordedBy: staffRefSchema,
  entry: entryRefSchema,
  /** As attached when the diagnosis was recorded, never re-derived. */
  codings: z.object({
    primary: codingSchema,
    translated: codingSchema.nullable(),
    advisory: codingSchema.nullable(),
  }),
});
export type ConditionSummary = z.infer<typeof conditionSummarySchema>;

/** A newly recorded diagnosis, with the reasons anything was not attached. */
export const recordedDiagnosisSchema = conditionSummarySchema.extend({
  codingNotes: z.array(z.string()),
});
export type RecordedDiagnosis = z.infer<typeof recordedDiagnosisSchema>;

/** Active problems across every record the caller may see. */
export const problemListSchema = z.object({
  problems: z.array(conditionSummarySchema),
  sharedFromOtherHospitals: z.boolean(),
});
export type ProblemList = z.infer<typeof problemListSchema>;

// ---------------------------------------------------------------------------
// Prescriptions
// ---------------------------------------------------------------------------

const optionalText = (max: number) => z.string().trim().max(max).optional();

/**
 * Prescribing a medicine, Ayurvedic or allopathic (Decision B1).
 *
 * The medicine name is free text; everything a "currently taking" view needs
 * is structured. Dose and duration are objects so that a quantity cannot
 * arrive without its unit.
 */
export const prescribeSchema = z.object({
  encounterId: uuidSchema,
  onBehalfOfClinicianId: onBehalfOfSchema,
  /** Defaults to the encounter's system of medicine. */
  systemOfMedicine: z.enum(SYSTEMS_OF_MEDICINE).optional(),
  medicineName: z.string().trim().min(1, 'Name the medicine').max(200),
  /** Tablet, syrup, churna, kashayam, vati. */
  form: optionalText(100),
  strength: optionalText(100),
  dose: z
    .object({
      quantity: z.number().positive().max(100_000),
      unit: z.string().trim().min(1).max(50),
    })
    .optional(),
  /** As written on the prescription: `1-0-1`, `twice daily`, `SOS`. */
  frequency: z.string().trim().min(1).max(100),
  route: z.enum(MEDICATION_ROUTES),
  duration: z
    .object({
      value: z.number().int().positive().max(3650),
      unit: z.enum(DURATION_UNITS),
    })
    .optional(),
  /** Defaults to today, India Standard Time. */
  startDate: clinicalDateSchema.optional(),
  /** Anupana: warm water, honey, ghee, milk. */
  vehicle: optionalText(200),
  foodTiming: z.enum(FOOD_TIMINGS).optional(),
  instructions: optionalText(1000),
  /**
   * Required to prescribe when a recorded allergy matches. The reason is kept
   * on the prescription.
   */
  allergyOverride: z.object({ reason: clinicalReasonSchema }).optional(),
});
export type PrescribeInput = z.infer<typeof prescribeSchema>;

export const stopPrescriptionSchema = z.object({
  reason: clinicalReasonSchema,
});
export type StopPrescriptionInput = z.infer<typeof stopPrescriptionSchema>;

export const medicationSummarySchema = z.object({
  id: uuidSchema,
  patientId: uuidSchema,
  encounterId: uuidSchema,
  hospital: hospitalRefSchema,
  systemOfMedicine: z.enum(SYSTEMS_OF_MEDICINE),
  medicineName: z.string(),
  form: z.string().nullable(),
  strength: z.string().nullable(),
  dose: z.object({ quantity: z.number(), unit: z.string() }).nullable(),
  frequency: z.string(),
  route: z.enum(MEDICATION_ROUTES),
  duration: z.object({ value: z.number(), unit: z.enum(DURATION_UNITS) }).nullable(),
  startDate: z.string(),
  /** The last day of the course, inclusive. Null for an open-ended prescription. */
  endDate: z.string().nullable(),
  vehicle: z.string().nullable(),
  foodTiming: z.enum(FOOD_TIMINGS).nullable(),
  instructions: z.string().nullable(),
  status: z.enum(MEDICATION_REQUEST_STATUSES),
  supersedesId: uuidSchema.nullable(),
  endedAt: z.string().nullable(),
  endReason: z.string().nullable(),
  allergyOverrideReason: z.string().nullable(),
  prescribedAt: z.string(),
  prescriber: staffRefSchema,
  entry: entryRefSchema,
});
export type MedicationSummary = z.infer<typeof medicationSummarySchema>;

/** A recorded allergy that matched a prescription by name. */
export const allergyMatchSchema = z.object({
  allergyId: uuidSchema,
  substance: z.string(),
  criticality: z.enum(ALLERGY_CRITICALITIES),
  reaction: z.string().nullable(),
  /** Whether the medicine itself or its vehicle matched. */
  matchedField: z.enum(['medicine', 'vehicle']),
  hospital: hospitalRefSchema,
});
export type AllergyMatch = z.infer<typeof allergyMatchSchema>;

/**
 * What the allergy check at prescribing can and cannot see. It compares
 * names exactly — a penicillin allergy does not flag amoxicillin — and only
 * allergies the caller may see.
 */
export const ALLERGY_CHECK_LIMITATION =
  'Checked by exact name against allergies visible to your hospital. Related medicines and interactions are not checked.';

export const prescriptionResultSchema = medicationSummarySchema.extend({
  allergyCheck: z.object({
    matches: z.array(allergyMatchSchema),
    sharedFromOtherHospitals: z.boolean(),
    limitation: z.string(),
  }),
});
export type PrescriptionResult = z.infer<typeof prescriptionResultSchema>;

export const currentMedicationsSchema = z.object({
  medications: z.array(medicationSummarySchema),
  sharedFromOtherHospitals: z.boolean(),
});
export type CurrentMedications = z.infer<typeof currentMedicationsSchema>;

/** A date-time that has already happened, give or take a workstation's clock drift. */
const pastDateTimeSchema = z
  .string()
  .datetime({ offset: true })
  .refine((value) => Date.parse(value) <= Date.now() + 5 * 60_000, {
    message: 'Cannot be in the future',
  });

// ---------------------------------------------------------------------------
// Vitals
// ---------------------------------------------------------------------------

export const LOINC_SYSTEM = 'http://loinc.org';

/**
 * The vital signs panel, with the LOINC codes of the FHIR R4 vital signs
 * profile. To be checked against the licensed LOINC release loaded in
 * production; LOINC's licence requires {@link LOINC_ATTRIBUTION} wherever the
 * codes are shown.
 *
 * The bounds reject typing errors — a pulse of 720 — not unusual patients.
 */
export const VITAL_SIGNS = {
  systolic: {
    code: '8480-6',
    display: 'Systolic blood pressure',
    label: 'Systolic BP',
    unit: 'mm[Hg]',
    min: 40,
    max: 300,
  },
  diastolic: {
    code: '8462-4',
    display: 'Diastolic blood pressure',
    label: 'Diastolic BP',
    unit: 'mm[Hg]',
    min: 20,
    max: 200,
  },
  heartRate: {
    code: '8867-4',
    display: 'Heart rate',
    label: 'Pulse',
    unit: '/min',
    min: 20,
    max: 300,
  },
  respiratoryRate: {
    code: '9279-1',
    display: 'Respiratory rate',
    label: 'Respiratory rate',
    unit: '/min',
    min: 4,
    max: 80,
  },
  temperature: {
    code: '8310-5',
    display: 'Body temperature',
    label: 'Temperature',
    unit: 'Cel',
    min: 30,
    max: 45,
  },
  oxygenSaturation: {
    code: '59408-5',
    display: 'Oxygen saturation in Arterial blood by Pulse oximetry',
    label: 'SpO₂',
    unit: '%',
    min: 50,
    max: 100,
  },
  height: {
    code: '8302-2',
    display: 'Body height',
    label: 'Height',
    unit: 'cm',
    min: 30,
    max: 250,
  },
  weight: {
    code: '29463-7',
    display: 'Body weight',
    label: 'Weight',
    unit: 'kg',
    min: 0.5,
    max: 400,
  },
  /** Derived by the server from height and weight; never entered. */
  bmi: {
    code: '39156-5',
    display: 'Body mass index (BMI) [Ratio]',
    label: 'BMI',
    unit: 'kg/m2',
    min: 5,
    max: 150,
  },
} as const;
export type VitalSignKey = keyof typeof VITAL_SIGNS;
export const VITAL_SIGN_KEYS = Object.keys(VITAL_SIGNS) as [VitalSignKey, ...VitalSignKey[]];

export const LOINC_ATTRIBUTION =
  'This material contains content from LOINC (http://loinc.org). LOINC is copyright © Regenstrief Institute, Inc. and the Logical Observation Identifiers Names and Codes (LOINC) Committee and is available at no cost under the license at http://loinc.org/license. LOINC® is a registered United States trademark of Regenstrief Institute, Inc.';

const vitalReading = (key: Exclude<VitalSignKey, 'bmi'>) =>
  z.number().min(VITAL_SIGNS[key].min).max(VITAL_SIGNS[key].max).optional();

export const recordVitalsSchema = z.object({
  patientId: uuidSchema,
  encounterId: uuidSchema.optional(),
  /** When the readings were taken. Defaults to now. */
  effectiveAt: pastDateTimeSchema.optional(),
  onBehalfOfClinicianId: onBehalfOfSchema,
  readings: z
    .object({
      systolic: vitalReading('systolic'),
      diastolic: vitalReading('diastolic'),
      heartRate: vitalReading('heartRate'),
      respiratoryRate: vitalReading('respiratoryRate'),
      /** Celsius. */
      temperature: vitalReading('temperature'),
      oxygenSaturation: vitalReading('oxygenSaturation'),
      height: vitalReading('height'),
      weight: vitalReading('weight'),
    })
    .refine((readings) => Object.values(readings).some((value) => value !== undefined), {
      message: 'Record at least one reading',
    })
    .refine(
      (readings) => (readings.systolic === undefined) === (readings.diastolic === undefined),
      {
        message: 'A blood pressure needs both systolic and diastolic',
        path: ['diastolic'],
      },
    )
    .refine(
      (readings) =>
        readings.systolic === undefined ||
        readings.diastolic === undefined ||
        readings.systolic > readings.diastolic,
      { message: 'Systolic must be higher than diastolic', path: ['systolic'] },
    ),
});
export type RecordVitalsInput = z.infer<typeof recordVitalsSchema>;

/** One set of readings taken together, such as at the start of a consultation. */
export const vitalSetSchema = z.object({
  /** The set's group id; also what marks the whole set entered in error. */
  id: uuidSchema,
  patientId: uuidSchema,
  encounterId: uuidSchema.nullable(),
  hospital: hospitalRefSchema,
  effectiveAt: z.string(),
  recordedAt: z.string(),
  recordedBy: staffRefSchema,
  entry: entryRefSchema,
  readings: z.array(
    z.object({
      key: z.enum(VITAL_SIGN_KEYS),
      observationId: uuidSchema,
      code: z.string(),
      display: z.string(),
      value: z.number(),
      unit: z.string(),
    }),
  ),
});
export type VitalSet = z.infer<typeof vitalSetSchema>;

export const vitalsListSchema = z.object({
  sets: z.array(vitalSetSchema),
  sharedFromOtherHospitals: z.boolean(),
});
export type VitalsList = z.infer<typeof vitalsListSchema>;

// ---------------------------------------------------------------------------
// Clinical notes
// ---------------------------------------------------------------------------

/**
 * Note templates. Sections are stored separately as well as composed into the
 * note's text, so a later discharge summary can draw on "Plan" without parsing
 * prose.
 */
export const NOTE_TEMPLATES = {
  general: {
    label: 'Consultation (SOAP)',
    sections: [
      { key: 'subjective', label: 'Subjective' },
      { key: 'objective', label: 'Objective' },
      { key: 'assessment', label: 'Assessment' },
      { key: 'plan', label: 'Plan' },
    ],
  },
  ayurveda_initial: {
    label: 'Ayurveda initial assessment',
    sections: [
      { key: 'pradhana_vedana', label: 'Pradhana vedana (chief complaints)' },
      { key: 'vyadhi_vrittanta', label: 'Vyadhi vrittanta (history of illness)' },
      { key: 'ashtavidha_pariksha', label: 'Ashtavidha pariksha (eightfold examination)' },
      { key: 'dashavidha_pariksha', label: 'Dashavidha pariksha (tenfold assessment)' },
      { key: 'assessment', label: 'Assessment' },
      { key: 'ahara_vihara', label: 'Ahara-vihara (diet and lifestyle advice)' },
      { key: 'plan', label: 'Plan' },
    ],
  },
  follow_up: {
    label: 'Follow-up',
    sections: [
      { key: 'progress', label: 'Progress since last visit' },
      { key: 'findings', label: 'Findings' },
      { key: 'plan', label: 'Plan' },
      { key: 'next_visit', label: 'Next visit' },
    ],
  },
} as const;
export type NoteTemplateKey = keyof typeof NOTE_TEMPLATES;
export const NOTE_TEMPLATE_KEYS = Object.keys(NOTE_TEMPLATES) as [
  NoteTemplateKey,
  ...NoteTemplateKey[],
];

const noteContentSchema = z.object({
  template: z.enum(NOTE_TEMPLATE_KEYS),
  title: optionalText(200),
  /** Section key to text. Empty sections are left out of the note. */
  sections: z.record(z.string(), z.string().trim().max(10_000)),
});

function checkNoteSections(
  value: { template: NoteTemplateKey; sections: Record<string, string> },
  ctx: z.RefinementCtx,
): void {
  const template = NOTE_TEMPLATES[value.template];
  const allowed = new Set<string>(template.sections.map((section) => section.key));

  for (const key of Object.keys(value.sections)) {
    if (!allowed.has(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sections', key],
        message: `Not a section of the ${template.label} template`,
      });
    }
  }

  if (!Object.values(value.sections).some((text) => text.trim() !== '')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['sections'],
      message: 'Write at least one section',
    });
  }
}

export const writeNoteSchema = noteContentSchema
  .extend({ encounterId: uuidSchema, onBehalfOfClinicianId: onBehalfOfSchema })
  .superRefine(checkNoteSections);
export type WriteNoteInput = z.infer<typeof writeNoteSchema>;

export const correctNoteSchema = noteContentSchema
  .extend({ reason: clinicalReasonSchema })
  .superRefine(checkNoteSections);
export type CorrectNoteInput = z.infer<typeof correctNoteSchema>;

export const noteSummarySchema = z.object({
  id: uuidSchema,
  patientId: uuidSchema,
  encounterId: uuidSchema,
  hospital: hospitalRefSchema,
  template: z.string(),
  templateLabel: z.string(),
  title: z.string().nullable(),
  sections: z.array(z.object({ key: z.string(), label: z.string(), text: z.string() })),
  recordedAt: z.string(),
  recordedBy: staffRefSchema,
  entry: entryRefSchema,
  supersedesId: uuidSchema.nullable(),
});
export type NoteSummary = z.infer<typeof noteSummarySchema>;

// ---------------------------------------------------------------------------
// Procedures
// ---------------------------------------------------------------------------

/** Suggestions for the procedure name on Ayurvedic encounters. The name stays free text. */
export const PANCHAKARMA_THERAPIES = [
  'Abhyanga (therapeutic oil massage)',
  'Pizhichil',
  'Patra pinda pottali (herbal bolus)',
  'Shirodhara',
  'Kati dhara',
  'Bashpa snana (herbal steam)',
  'Nasya',
  'Lepa application',
  'Ksharasutra',
  'Agnikarma',
  'Jalaukavacharana (leech therapy)',
] as const;

const procedureContentSchema = z.object({
  /** Defaults to the encounter's system of medicine. */
  systemOfMedicine: z.enum(SYSTEMS_OF_MEDICINE).optional(),
  name: z.string().trim().min(1, 'Name the procedure').max(200),
  /** Defaults to now. */
  performedAt: pastDateTimeSchema.optional(),
  /** A clinician of the same hospital. Defaults to the clinician the entry is attributed to. */
  performerClinicianId: uuidSchema.optional(),
  outcome: optionalText(500),
  notes: optionalText(2000),
});

export const recordProcedureSchema = procedureContentSchema.extend({
  encounterId: uuidSchema,
  onBehalfOfClinicianId: onBehalfOfSchema,
});
export type RecordProcedureInput = z.infer<typeof recordProcedureSchema>;

export const correctProcedureSchema = procedureContentSchema.extend({
  reason: clinicalReasonSchema,
});
export type CorrectProcedureInput = z.infer<typeof correctProcedureSchema>;

export const procedureSummarySchema = z.object({
  id: uuidSchema,
  patientId: uuidSchema,
  encounterId: uuidSchema,
  hospital: hospitalRefSchema,
  systemOfMedicine: z.enum(SYSTEMS_OF_MEDICINE),
  name: z.string(),
  performedAt: z.string(),
  performer: staffRefSchema,
  outcome: z.string().nullable(),
  notes: z.string().nullable(),
  recordedAt: z.string(),
  recordedBy: staffRefSchema,
  entry: entryRefSchema,
  supersedesId: uuidSchema.nullable(),
});
export type ProcedureSummary = z.infer<typeof procedureSummarySchema>;

export const procedureListSchema = z.object({
  procedures: z.array(procedureSummarySchema),
  sharedFromOtherHospitals: z.boolean(),
});
export type ProcedureList = z.infer<typeof procedureListSchema>;

// ---------------------------------------------------------------------------
// Corrections
// ---------------------------------------------------------------------------

/**
 * Nothing clinical is edited or deleted. A correction replaces an entry with a
 * new version; a mistake is marked entered in error. Either way the original
 * stays in the entry's history, with who changed it, when, and why.
 */
export const markEnteredInErrorSchema = z.object({ reason: clinicalReasonSchema });
export type MarkEnteredInErrorInput = z.infer<typeof markEnteredInErrorSchema>;

export const correctDiagnosisSchema = recordDiagnosisSchema
  .omit({ encounterId: true, onBehalfOfClinicianId: true })
  .extend({ reason: clinicalReasonSchema });
export type CorrectDiagnosisInput = z.infer<typeof correctDiagnosisSchema>;

export const correctPrescriptionSchema = prescribeSchema
  .omit({ encounterId: true, onBehalfOfClinicianId: true })
  .extend({ reason: clinicalReasonSchema });
export type CorrectPrescriptionInput = z.infer<typeof correctPrescriptionSchema>;

/** Also how an allergy is resolved: a correction with a new clinical status. */
export const correctAllergySchema = recordAllergySchema
  .omit({ patientId: true, encounterId: true, onBehalfOfClinicianId: true })
  .extend({
    clinicalStatus: z.enum(ALLERGY_CLINICAL_STATUSES).default('active'),
    reason: clinicalReasonSchema,
  });
export type CorrectAllergyInput = z.infer<typeof correctAllergySchema>;

export const CORRECTABLE_KINDS = [
  'diagnoses',
  'prescriptions',
  'allergies',
  'notes',
  'procedures',
] as const;
export type CorrectableKind = (typeof CORRECTABLE_KINDS)[number];

export const versionHistoryEntrySchema = z.object({
  id: uuidSchema,
  /** 1 for the original, counting up through each correction. */
  version: z.number().int(),
  versionStatus: z.enum(VERSION_STATUSES),
  /** A one-line description of the version, so versions can be compared at a glance. */
  label: z.string(),
  hospital: hospitalRefSchema,
  recordedAt: z.string(),
  recordedBy: staffRefSchema,
  entry: entryRefSchema,
  statusChangedAt: z.string().nullable(),
  statusChangedBy: staffRefSchema.nullable(),
  statusReason: z.string().nullable(),
});
export type VersionHistoryEntry = z.infer<typeof versionHistoryEntrySchema>;

// ---------------------------------------------------------------------------
// Consent (Decision A1) and emergency access
// ---------------------------------------------------------------------------

/**
 * Recording a patient's consent for this hospital to see their history from
 * other hospitals. Asked of the patient in person, at the desk.
 */
export const recordConsentSchema = z
  .object({
    dataCategories: z
      .array(z.enum(CLINICAL_DATA_CATEGORIES))
      .min(1, 'Choose at least one kind of record')
      .refine((values) => new Set(values).size === values.length, {
        message: 'Each kind of record once',
      }),
    /** The clinical dates covered, inclusive. Left out, all dates. */
    dateRangeFrom: clinicalDateSchema.optional(),
    dateRangeTo: clinicalDateSchema.optional(),
    /** Consent lapses on its own; a year at most, then the patient is asked again. */
    validForDays: z.number().int().min(1).max(365),
    captureMethod: z.enum(['signed_form', 'verbal_witnessed']),
    witnessName: z.string().trim().min(2).max(120).optional(),
  })
  .refine((value) => value.captureMethod !== 'verbal_witnessed' || Boolean(value.witnessName), {
    message: 'Name the witness to verbal consent',
    path: ['witnessName'],
  })
  .refine(
    (value) =>
      !value.dateRangeFrom || !value.dateRangeTo || value.dateRangeFrom <= value.dateRangeTo,
    { message: 'The date range ends before it starts', path: ['dateRangeTo'] },
  );
export type RecordConsentInput = z.infer<typeof recordConsentSchema>;

export const revokeConsentSchema = z.object({ reason: clinicalReasonSchema });
export type RevokeConsentInput = z.infer<typeof revokeConsentSchema>;

/**
 * Emergency access. The reason is read by the hospital's reviewers and, from
 * SP5, by the patient — so it must say why, not just that.
 */
export const breakGlassSchema = z.object({
  reason: z.string().trim().min(10, 'Say why emergency access is needed').max(1000),
  hours: z.number().int().min(1).max(24).default(4),
});
export type BreakGlassInput = z.infer<typeof breakGlassSchema>;

export const reviewBreakGlassSchema = z.object({
  outcome: z.enum(BREAK_GLASS_REVIEW_OUTCOMES),
  note: clinicalReasonSchema,
});
export type ReviewBreakGlassInput = z.infer<typeof reviewBreakGlassSchema>;

export const CONSENT_EFFECTIVE_STATUSES = ['active', 'expired', 'revoked'] as const;
export type ConsentEffectiveStatus = (typeof CONSENT_EFFECTIVE_STATUSES)[number];

export const consentSummarySchema = z.object({
  id: uuidSchema,
  patientId: uuidSchema,
  dataCategories: z.array(z.enum(CLINICAL_DATA_CATEGORIES)),
  dateRangeFrom: z.string().nullable(),
  dateRangeTo: z.string().nullable(),
  grantedAt: z.string(),
  expiresAt: z.string(),
  /** Expiry is worked out from the date, so an expired consent says so without anyone acting. */
  status: z.enum(CONSENT_EFFECTIVE_STATUSES),
  captureMethod: z.enum(CONSENT_CAPTURE_METHODS),
  witnessName: z.string().nullable(),
  emergencyReason: z.string().nullable(),
  recordedBy: staffRefSchema,
  revokedAt: z.string().nullable(),
  revokedBy: staffRefSchema.nullable(),
  revocationReason: z.string().nullable(),
  review: z
    .object({
      outcome: z.enum(BREAK_GLASS_REVIEW_OUTCOMES),
      note: z.string(),
      reviewedAt: z.string(),
      reviewedBy: staffRefSchema,
    })
    .nullable(),
  /** Null until the patient can be told, which the portal (SP5) will do. */
  patientNotifiedAt: z.string().nullable(),
});
export type ConsentSummary = z.infer<typeof consentSummarySchema>;

/** An emergency access awaiting review. Identifies the patient by MRN only. */
export const breakGlassReviewItemSchema = z.object({
  id: uuidSchema,
  mrn: z.string().nullable(),
  reason: z.string(),
  grantedAt: z.string(),
  expiresAt: z.string(),
  status: z.enum(CONSENT_EFFECTIVE_STATUSES),
  clinician: staffRefSchema,
  patientNotified: z.boolean(),
});
export type BreakGlassReviewItem = z.infer<typeof breakGlassReviewItemSchema>;

// ---------------------------------------------------------------------------
// Timeline and summary
// ---------------------------------------------------------------------------

export const TIMELINE_KINDS = [
  'encounter',
  'diagnosis',
  'prescription',
  'allergy',
  'vitals',
  'note',
  'procedure',
] as const;
export type TimelineKind = (typeof TIMELINE_KINDS)[number];

export const timelineQuerySchema = z.object({
  /** Comma-separated data categories. Left out, every category. */
  categories: z.preprocess(
    (value) => (typeof value === 'string' && value ? value.split(',') : undefined),
    z.array(z.enum(CLINICAL_DATA_CATEGORIES)).optional(),
  ),
  /** `own`: only this hospital's records. `all`: every record the hospital may see. */
  scope: z.enum(['all', 'own']).default('all'),
  /** Entries strictly before this moment, for loading older ones. */
  before: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type TimelineQuery = z.infer<typeof timelineQuerySchema>;

export const timelineItemSchema = z.object({
  kind: z.enum(TIMELINE_KINDS),
  id: uuidSchema,
  at: z.string(),
  category: z.enum(CLINICAL_DATA_CATEGORIES),
  hospital: hospitalRefSchema,
  encounterId: uuidSchema.nullable(),
  /** Null where the encounter it belongs to is not shared with the caller. */
  systemOfMedicine: z.enum(SYSTEMS_OF_MEDICINE).nullable(),
  title: z.string(),
  detail: z.string().nullable(),
  clinician: staffRefSchema,
  entry: entryRefSchema,
  corrected: z.boolean(),
});
export type TimelineItem = z.infer<typeof timelineItemSchema>;

export const timelinePageSchema = z.object({
  items: z.array(timelineItemSchema),
  /** Pass as `before` to load older entries; null when there are none. */
  nextBefore: z.string().nullable(),
  /** The categories another hospital shares with the caller, for saying what may be missing. */
  sharedCategories: z.array(z.enum(CLINICAL_DATA_CATEGORIES)),
});
export type TimelinePage = z.infer<typeof timelinePageSchema>;

/** The thirty-second view of a patient. */
export const patientSummaryCardSchema = z.object({
  allergies: allergyBannerSchema,
  problems: problemListSchema,
  medications: currentMedicationsSchema,
  latestVitals: vitalSetSchema.nullable(),
  recentEncounters: z.array(encounterSummarySchema),
  sharing: z.object({
    /** Categories other hospitals share with this one, under active consent. */
    categories: z.array(z.enum(CLINICAL_DATA_CATEGORIES)),
    /** When the soonest of those consents lapses. */
    expiresAt: z.string().nullable(),
    /** Set while this hospital holds emergency access to the patient. */
    breakGlassUntil: z.string().nullable(),
  }),
});
export type PatientSummaryCard = z.infer<typeof patientSummaryCardSchema>;

// ---------------------------------------------------------------------------
// Coding review
// ---------------------------------------------------------------------------

/**
 * A diagnosis whose attached translation or advisory code rests on a mapping
 * that has since been retired or rejected. The diagnosis still shows what was
 * attached; a clinician decides whether to keep it or correct the diagnosis.
 */
export const codingReviewItemSchema = z.object({
  conditionId: uuidSchema,
  encounterId: uuidSchema,
  patient: z.object({ id: uuidSchema, name: z.string().nullable(), mrn: z.string().nullable() }),
  recordedAt: z.string(),
  primary: codingSchema,
  flagged: codingSchema.extend({ mappingStatus: z.string() }),
  /** What auto-coding would attach to the same term today, when the term still resolves. */
  suggestion: autoCodeResultSchema.nullable(),
});
export type CodingReviewItem = z.infer<typeof codingReviewItemSchema>;

export const acknowledgeCodingReviewSchema = z.object({
  conceptMapElementId: uuidSchema,
  note: clinicalReasonSchema,
});
export type AcknowledgeCodingReviewInput = z.infer<typeof acknowledgeCodingReviewSchema>;
