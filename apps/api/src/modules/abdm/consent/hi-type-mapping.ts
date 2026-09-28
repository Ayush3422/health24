import { CLINICAL_DATA_CATEGORIES, type ClinicalDataCategory } from '@health24/shared';

/**
 * What ABDM's health information types mean here (sp8-plan.md, T15).
 *
 * A consent arrives naming the kinds of information the patient agreed to
 * share — `Prescription`, `OPConsultation`, `DischargeSummary` and so on —
 * and this system's consent model is in categories of its own. The mapping
 * between them is where a consent quietly becomes wider than the patient
 * intended, so three rules govern it:
 *
 * 1. **Conservative.** A type grants only what it plainly contains. Where a
 *    bundle *may* include something, that is not the same as the patient
 *    having agreed to share it.
 *
 * 2. **Clinicians' notes are never granted through ABDM, by any type.** SP5
 *    made this call for the patient's own downloadable export — whether free
 *    text written by a doctor belongs in a bundle is a decision for a
 *    clinical reviewer, not a mapping choice — and nothing about ABDM changes
 *    it. A consent that meant to include them will produce a record without
 *    them, which is the safe direction to be wrong in.
 *
 * 3. **What does not map is recorded, not dropped.** An unrecognised type
 *    grants nothing and is written onto the artefact, so a person can see
 *    that the consent is narrower than what was asked for. A consent that
 *    maps to nothing at all is refused rather than stored: an artefact that
 *    grants nothing would leave the patient believing their records are
 *    flowing when none can.
 *
 * The list is what the specification publishes today; reconciling it against
 * the sandbox is T38.
 */

type Mapping = Record<string, readonly ClinicalDataCategory[]>;

const HI_TYPES: Mapping = {
  /** Medicines advised. Nothing else travels with it. */
  Prescription: ['medications'],

  /** Typed results and the report they were read from. */
  DiagnosticReport: ['observations', 'documents'],

  /**
   * An outpatient consultation: the visit, what was found, what was advised.
   * The broadest type ABDM has, and still not notes.
   */
  OPConsultation: [
    'encounters',
    'diagnoses',
    'medications',
    'allergies',
    'observations',
    'procedures',
  ],

  /** The admission and what was done during it. */
  DischargeSummary: ['encounters', 'diagnoses', 'medications', 'procedures'],

  /** Scanned reports and other files. */
  HealthDocumentRecord: ['documents'],

  /** Vitals and readings a patient records themselves. */
  WellnessRecord: ['observations'],

  /**
   * Deliberately empty, not absent: immunisations are a type ABDM defines and
   * this system does not model at all, so a consent for them grants nothing
   * and says so rather than appearing unrecognised.
   */
  ImmunizationRecord: [],
};

export interface HiTypeMapping {
  /** What the consent grants here, de-duplicated and in a stable order. */
  categories: ClinicalDataCategory[];
  /** Types that granted nothing: unknown to us, or known and not modelled. */
  unmapped: string[];
}

export function mapHiTypes(hiTypes: readonly string[]): HiTypeMapping {
  const granted = new Set<ClinicalDataCategory>();
  const unmapped: string[] = [];

  for (const type of hiTypes) {
    const categories = HI_TYPES[type];

    if (!categories || categories.length === 0) {
      unmapped.push(type);
      continue;
    }

    for (const category of categories) granted.add(category);
  }

  return {
    // Ordered by the canonical list rather than by arrival, so two consents
    // asking for the same things store the same array.
    categories: CLINICAL_DATA_CATEGORIES.filter((category) => granted.has(category)),
    unmapped,
  };
}

/** Every type this system recognises, for the documentation and the tests. */
export function knownHiTypes(): string[] {
  return Object.keys(HI_TYPES);
}
