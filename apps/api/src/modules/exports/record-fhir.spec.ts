import { describe, expect, it } from 'vitest';
import type { ExportRecord } from './export-record';
import { buildRecordFhir } from './record-fhir';

/**
 * What the bundle says about who the patient is (sp8-plan.md, T3).
 *
 * The rest of the mapping is exercised through the export suite against a
 * real record. This is here on its own because it is a claim rather than a
 * translation: a FHIR `identifier` carrying ABDM's system URI asserts that
 * this is the person's national health identity, and whatever reads the
 * bundle will believe it. A number somebody typed at a desk does not support
 * that claim, so it is not made.
 */

const EMPTY = {
  hospitals: [{ id: 'h1', name: 'Sanjeevani Ayurveda', mrn: 'SJT-000001' }],
  encounters: [],
  conditions: [],
  medications: [],
  allergies: [],
  observations: [],
  procedures: [],
  notes: [],
  documents: [],
};

function record(abha: Partial<ExportRecord['patient']>): ExportRecord {
  return {
    ...EMPTY,
    patient: {
      id: '01a0d7c3-a410-7273-864b-ad9f69444495',
      name: 'Lakshmi Devi',
      gender: 'female',
      dateOfBirth: '1988-04-12',
      approximateAgeYears: null,
      bloodGroup: null,
      phone: null,
      emergencyContactName: null,
      emergencyContactPhone: null,
      abhaNumber: null,
      abhaAddress: null,
      abhaVerified: false,
      ...abha,
    },
  } as ExportRecord;
}

function identifiers(built: unknown): Array<{ system: string; value: string }> {
  const bundle = built as {
    entry: Array<{ resource: { resourceType: string; identifier?: Array<{ system: string; value: string }> } }>;
  };

  const patient = bundle.entry.find((entry) => entry.resource.resourceType === 'Patient');
  return patient?.resource.identifier ?? [];
}

describe('the FHIR bundle a patient is given', () => {
  const at = new Date('2026-09-28T09:00:00Z');

  it('asserts a verified ABHA under ABDM system', () => {
    const built = buildRecordFhir(
      record({ abhaNumber: '11112222333344', abhaAddress: 'lakshmi.devi@abdm', abhaVerified: true }),
      at,
    );

    expect(identifiers(built)).toEqual(
      expect.arrayContaining([
        { system: 'https://healthid.ndhm.gov.in', value: '11112222333344' },
        { system: 'https://healthid.ndhm.gov.in/address', value: 'lakshmi.devi@abdm' },
      ]),
    );
  });

  it('does not assert an ABHA nobody confirmed', () => {
    const built = buildRecordFhir(
      record({ abhaNumber: '11112222333344', abhaVerified: false }),
      at,
    );

    const systems = identifiers(built).map((entry) => entry.system);

    expect(systems).not.toContain('https://healthid.ndhm.gov.in');
    // And the record is still identified by the hospital that holds it.
    expect(systems.some((system) => system.startsWith('urn:health24:hospital'))).toBe(true);
  });

  it('still names the hospitals when there is no ABHA at all', () => {
    expect(identifiers(buildRecordFhir(record({}), at))).toEqual([
      { system: 'urn:health24:hospital:h1', value: 'SJT-000001' },
    ]);
  });
});
