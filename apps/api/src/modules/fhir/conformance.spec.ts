import { describe, expect, it } from 'vitest';
import type { ExportRecord } from '../exports/export-record';
import { buildRecordResources } from '../exports/record-fhir';
import { buildCareContextBundle } from '../abdm/transfer/care-context-bundle';
import { capabilityStatement, FHIR_RESOURCES } from './capability-statement';

/**
 * What FHIR R4 requires, checked (sp8-plan.md, T30).
 *
 * Not a validator. A real one needs the published StructureDefinitions and a
 * dependency this project has chosen not to take on for a read surface; what
 * this does instead is assert the part that can be asserted from the
 * specification itself — the elements R4 marks **1..1**, which a resource
 * missing is not that resource at all — and the invariants this system's own
 * bundles must hold.
 *
 * Where that is not enough, the answer is not a better test: it is
 * `docs/fhir.md`, which lists every deviation in words. This file is what
 * keeps that list honest by failing when something drifts below the floor.
 */

/** Elements FHIR R4 marks 1..1 on the resources this system produces. */
const REQUIRED: Record<string, string[]> = {
  Patient: [],
  Encounter: ['status', 'class'],
  Condition: ['subject'],
  // `medication[x]` is a choice; this system always writes the codeable one.
  MedicationRequest: ['status', 'intent', 'medicationCodeableConcept', 'subject'],
  AllergyIntolerance: ['patient'],
  Observation: ['status', 'code'],
  Procedure: ['status', 'subject'],
  DocumentReference: ['status', 'content'],
  Composition: ['status', 'type', 'date', 'title'],
};

const record: ExportRecord = {
  patient: {
    id: '01a0d7c3-a410-7273-864b-ad9f69444495',
    name: 'Kamala Nair',
    gender: 'female',
    dateOfBirth: '1986-07-19',
    approximateAgeYears: null,
    bloodGroup: 'O+',
    phone: '+919812345670',
    emergencyContactName: null,
    emergencyContactPhone: null,
    abhaNumber: '11112222333344',
    abhaAddress: 'kamala.nair@abdm',
    abhaVerified: true,
  },
  hospitals: [{ id: 'h1', name: 'Sanjeevani Ayurveda', mrn: 'SJT-000001' }],
  encounters: [
    {
      id: 'e1',
      hospital_name: 'Sanjeevani Ayurveda',
      class: 'outpatient',
      system_of_medicine: 'ayurveda',
      started_at: '2026-04-12T04:30:00Z',
      ended_at: null,
      status: 'in_progress',
      chief_complaint: 'Burning after meals',
      clinician_name: 'Dr Meera Joshi',
    },
  ],
  conditions: [
    {
      id: 'c1',
      hospital_name: 'Sanjeevani Ayurveda',
      recorded_at: '2026-04-12T05:00:00Z',
      clinical_status: 'active',
      verification_status: 'confirmed',
      is_primary: true,
      note: null,
      clinician_name: 'Dr Meera Joshi',
      codings: [
        { role: 'primary', system: 'namaste', code: 'DEMO-NAM-001', display: 'Amlapitta' },
      ],
    },
  ],
  medications: [
    {
      id: 'm1',
      hospital_name: 'Sanjeevani Ayurveda',
      recorded_at: '2026-04-12T05:05:00Z',
      medicine_name: 'Avipattikar churna',
      strength: null,
      dose: '5 g',
      frequency: '1-0-1',
      route: 'oral',
      duration: '30 days',
      start_date: '2026-04-12',
      status: 'active',
      instructions: null,
      clinician_name: 'Dr Meera Joshi',
    },
  ],
  allergies: [
    {
      id: 'a1',
      hospital_name: 'Sanjeevani Ayurveda',
      recorded_at: '2026-04-12T05:06:00Z',
      substance: 'Penicillin',
      category: 'medication',
      criticality: 'high',
      clinical_status: 'active',
      reaction: 'Rash',
      clinician_name: 'Dr Meera Joshi',
    },
  ],
  observations: [
    {
      id: 'o1',
      hospital_name: 'Sanjeevani Ayurveda',
      effective_at: '2026-04-12T05:07:00Z',
      category: 'laboratory',
      code: '718-7',
      code_system: 'loinc',
      display: 'Haemoglobin',
      value: '12.4',
      value_text: null,
      unit: 'g/dL',
      interpretation: 'normal',
      reference_low: '12',
      reference_high: '15',
      group_id: null,
      panel_code: null,
    },
  ],
  procedures: [
    {
      id: 'p1',
      hospital_name: 'Sanjeevani Ayurveda',
      performed_at: '2026-04-12T05:08:00Z',
      name: 'Virechana',
      outcome: 'Completed',
      clinician_name: 'Dr Meera Joshi',
    },
  ],
  notes: [
    {
      id: 'n1',
      hospital_name: 'Sanjeevani Ayurveda',
      recorded_at: '2026-04-12T05:09:00Z',
      title: null,
      template: 'general',
      body: 'She says it is worse at night and after travel',
      clinician_name: 'Dr Meera Joshi',
    },
  ],
  documents: [
    {
      id: 'd1',
      hospital_name: 'Sanjeevani Ayurveda',
      report_date: '2026-04-11',
      doc_type: 'lab_report',
      title: 'Complete blood count',
      performing_facility: null,
      file_count: 2,
    },
  ],
};

describe('what this system produces, against what R4 requires', () => {
  const resources = buildRecordResources(record);

  it('produces something of every kind the capability statement claims', () => {
    const produced = new Set(resources.map((resource) => String(resource.resourceType)));

    for (const claimed of FHIR_RESOURCES) {
      // The terminology resources are not built from a patient's record.
      if (claimed.type === 'CodeSystem' || claimed.type === 'ConceptMap') continue;

      expect(produced, `${claimed.type} is claimed but never produced`).toContain(claimed.type);
    }
  });

  it('gives every resource an id and a type', () => {
    for (const resource of resources) {
      expect(resource.resourceType).toBeTruthy();
      expect(resource.id, `${String(resource.resourceType)} has no id`).toBeTruthy();
    }
  });

  it('carries every element R4 marks as required', () => {
    const missing: string[] = [];

    for (const resource of resources) {
      const type = String(resource.resourceType);
      const required = REQUIRED[type];

      // A resource this file has no rule for is a rule somebody forgot to
      // write, and is reported as such rather than passing quietly.
      expect(required, `no conformance rule for ${type}`).toBeDefined();

      for (const element of required ?? []) {
        if (resource[element] === undefined || resource[element] === null) {
          missing.push(`${type}.${element}`);
        }
      }
    }

    expect(missing, 'required FHIR elements this system does not write').toEqual([]);
  });

  /**
   * AllergyIntolerance says `patient`, everything else says `subject`. It is
   * the kind of difference a mapping written from memory gets wrong, and a
   * receiving system would reject the resource outright.
   */
  it('names the subject the way each resource spells it', () => {
    const allergy = resources.find((resource) => resource.resourceType === 'AllergyIntolerance');

    expect(allergy?.patient).toBeDefined();
    expect(allergy?.subject).toBeUndefined();
  });

  it('points every subject reference at the patient it is about', () => {
    for (const resource of resources) {
      const reference = (resource.subject ?? resource.patient) as
        | { reference?: string }
        | undefined;

      if (!reference) continue;

      expect(reference.reference).toBe(`Patient/${record.patient.id}`);
    }
  });
});

describe('the document bundle a requester receives', () => {
  const built = buildCareContextBundle(record, 'e1', 'outpatient', new Date('2026-04-12T06:00:00Z'));

  it('is a document bundle led by a Composition', () => {
    expect(built).not.toBeNull();
    expect(built!.bundle).toMatchObject({ resourceType: 'Bundle', type: 'document' });

    const entries = (built!.bundle.entry as Array<{ resource: { resourceType: string } }>).map(
      (entry) => entry.resource.resourceType,
    );

    // R4 requires the first entry of a document bundle to be its Composition.
    expect(entries[0]).toBe('Composition');
  });

  it('references only resources the bundle actually carries', () => {
    const entries = built!.bundle.entry as Array<{ resource: Record<string, unknown> }>;
    const present = new Set(
      entries.map((entry) => `${String(entry.resource.resourceType)}/${String(entry.resource.id)}`),
    );

    const composition = entries[0]!.resource as {
      section: Array<{ entry: Array<{ reference: string }> }>;
    };

    for (const section of composition.section) {
      for (const reference of section.entry) {
        expect(present, `${reference.reference} is referenced but not in the bundle`).toContain(
          reference.reference,
        );
      }
    }
  });

  it('carries no clinician’s note, in any section', () => {
    expect(JSON.stringify(built!.bundle)).not.toContain('worse at night');
  });

  /**
   * The chief complaint **is** carried, and the difference from a note is
   * worth being explicit about.
   *
   * A care context's *display* deliberately says nothing clinical, because it
   * is shown on a consent screen anybody may glance at (T10). A bundle is the
   * opposite situation: it goes only to a requester the patient authorised
   * for the `encounters` category, and the reason for a visit is what an
   * encounter is. Leaving it out would produce a visit with no reason, which
   * is not a safer record — it is a less useful one that says the same
   * amount about the patient.
   */
  it('carries the reason for the visit, which is what an encounter is', () => {
    const entries = built!.bundle.entry as Array<{ resource: Record<string, unknown> }>;
    const encounter = entries.find((entry) => entry.resource.resourceType === 'Encounter');

    expect(JSON.stringify(encounter)).toContain('Burning after meals');
  });
});

describe('the capability statement', () => {
  it('claims only read and search, on every resource', () => {
    const statement = capabilityStatement(new Date()) as {
      rest: Array<{ resource: Array<{ type: string; interaction: Array<{ code: string }> }> }>;
    };

    for (const resource of statement.rest[0]!.resource) {
      const codes = resource.interaction.map((interaction) => interaction.code).sort();
      expect(codes, `${resource.type} claims more than it serves`).toEqual([
        'read',
        'search-type',
      ]);
    }
  });

  it('says what it does not do, rather than leaving it to be found', () => {
    const statement = capabilityStatement(new Date()) as { description: string };

    for (const phrase of ['Read-only', 'must name a patient', 'not claimed', 'notes']) {
      expect(statement.description).toContain(phrase);
    }
  });
});
