import { createHash } from 'node:crypto';
import type { ExportRecord } from '../../exports/export-record';
import { buildRecordResources } from '../../exports/record-fhir';

/**
 * One visit, as the document bundle ABDM asks for (sp8-plan.md, T21).
 *
 * The resources are the ones `record-fhir.ts` already produces for the
 * patient's own export — deliberately, because a second set of mappings would
 * drift from the first and the difference would show up as two systems
 * disagreeing about the same patient. What is added here is the shape ABDM
 * wants around them: a `document` bundle whose first entry is a `Composition`
 * saying what kind of record it is and which resources belong to which
 * section.
 *
 * **What this is not.** ABDM publishes a profile per health information type,
 * with required sections and coded slices. This produces a document bundle
 * with a typed Composition and the resources grouped sensibly, which is close
 * to those profiles and is not asserted to conform to them. Checking against
 * the published profiles is T30 and reconciling with the sandbox is T38; until
 * one of those has run, `docs/abdm.md` says exactly this.
 *
 * **What a bundle omits, stated rather than dropped:**
 *
 * - **Clinicians' notes**, always. No health information type grants them
 *   (T15), so the database never returns them in this context.
 * - **The files behind a document**. A `DocumentReference` names the report
 *   and its date; the bytes are fetched through a link issued one at a time
 *   and audited, and a bundle never carries a long-lived one.
 * - **Anything recorded without a visit.** Allergies, observations and
 *   documents can be entered with no encounter, and a care context is a
 *   visit — so those rows belong to no care context and are in no bundle.
 */

/** The composition type for a visit, by what kind of visit it was. */
const COMPOSITION_TYPE: Record<string, { code: string; display: string }> = {
  inpatient: { code: 'DischargeSummary', display: 'Discharge Summary Record' },
  outpatient: { code: 'OPConsultation', display: 'OP Consultation Record' },
  emergency: { code: 'OPConsultation', display: 'OP Consultation Record' },
  teleconsultation: { code: 'OPConsultation', display: 'OP Consultation Record' },
};

const SECTIONS: Array<{ title: string; resourceTypes: string[] }> = [
  { title: 'Chief complaints', resourceTypes: ['Encounter'] },
  { title: 'Medical history', resourceTypes: ['Condition', 'AllergyIntolerance'] },
  { title: 'Medications', resourceTypes: ['MedicationRequest'] },
  { title: 'Investigations', resourceTypes: ['Observation', 'DocumentReference'] },
  { title: 'Procedures', resourceTypes: ['Procedure'] },
];

export interface CareContextBundle {
  careContextReference: string;
  /** The FHIR document bundle, ready to be serialised and encrypted. */
  bundle: Record<string, unknown>;
  /** Every clinical row it carries, for the audit trail (DF5). */
  contents: Array<{ resourceType: string; id: string }>;
}

/**
 * Builds the bundle for one care context, or nothing when the consent admits
 * none of it.
 *
 * Returning `null` rather than an empty bundle matters: a bundle containing
 * only a Composition and a patient tells the requester that a visit exists
 * and that they may see nothing of it, which is more than the consent gave
 * them.
 */
export function buildCareContextBundle(
  record: ExportRecord,
  careContextReference: string,
  visitClass: string,
  assembledAt: Date,
): CareContextBundle | null {
  const resources = buildRecordResources(record);

  // The patient is always produced; it is the rest that says whether the
  // consent admitted anything at all.
  const clinical = resources.filter((resource) => resource.resourceType !== 'Patient');
  if (clinical.length === 0) return null;

  const patient = resources.find((resource) => resource.resourceType === 'Patient');
  const patientId = String(patient?.id ?? record.patient.id);

  const sections = SECTIONS.map((section) => {
    const entries = clinical.filter((resource) =>
      section.resourceTypes.includes(String(resource.resourceType)),
    );

    return entries.length === 0
      ? null
      : {
          title: section.title,
          entry: entries.map((resource) => ({
            reference: `${String(resource.resourceType)}/${String(resource.id)}`,
          })),
        };
  }).filter((section) => section !== null);

  const type = COMPOSITION_TYPE[visitClass] ?? COMPOSITION_TYPE.outpatient!;

  const composition = {
    resourceType: 'Composition',
    // Derived from the care context rather than random, so that the same
    // visit assembled twice produces the same composition id — a requester
    // receiving a redelivery can tell it is the same document.
    id: createHash('sha256').update(`composition:${careContextReference}`).digest('hex').slice(0, 32),
    status: 'final',
    type: { coding: [{ system: 'https://ndhm.gov.in/sct', ...type }], text: type.display },
    subject: { reference: `Patient/${patientId}` },
    date: assembledAt.toISOString(),
    title: type.display,
    section: sections,
  };

  const all = [composition, ...resources];

  return {
    careContextReference,
    bundle: {
      resourceType: 'Bundle',
      id: careContextReference,
      type: 'document',
      timestamp: assembledAt.toISOString(),
      entry: all.map((resource) => ({
        fullUrl: `urn:uuid:${String(resource.id)}`,
        resource,
      })),
    },
    // The Composition and the Patient are not clinical rows; the audit trail
    // records what was read out of the record, not what was wrapped around it.
    contents: clinical.map((resource) => ({
      resourceType: String(resource.resourceType),
      id: String(resource.id),
    })),
  };
}
