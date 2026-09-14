import { describe, expect, it } from 'vitest';
import { describeOfflineRead } from '@health24/shared';

const PATIENT = '01a09ac1-27c2-714e-a229-da3da9307ac4';
const ENCOUNTER = '01a09ac2-0000-7000-8000-000000000001';

/**
 * The shared list of what the offline cache may hold. The client caches from
 * it and the server accepts uploaded views by it, so its edges matter twice.
 */
describe('what the offline cache may hold', () => {
  it('holds the day’s worklist, as a search', () => {
    expect(describeOfflineRead('/encounters?date=2026-09-14&limit=100')).toEqual({
      resourceType: 'encounter',
      action: 'search',
      patientId: null,
      resourceId: null,
      clinical: true,
    });
  });

  it('does not hold other encounter searches', () => {
    expect(describeOfflineRead('/encounters?date=2026-09-14&limit=50')).toBeNull();
    expect(describeOfflineRead(`/encounters?patientId=${PATIENT}&limit=100`)).toBeNull();
  });

  it('holds a patient’s registry record, as registry data rather than clinical', () => {
    expect(describeOfflineRead(`/patients/${PATIENT}`)).toMatchObject({
      resourceType: 'patient',
      patientId: PATIENT,
      clinical: false,
    });
  });

  it('holds the essentials of a patient, each audited as its own kind of record', () => {
    const kinds = ['summary', 'allergies', 'problems', 'medications', 'vitals'].map(
      (part) => describeOfflineRead(`/patients/${PATIENT}/${part}`)?.resourceType,
    );

    expect(kinds).toEqual([
      'patient_summary',
      'allergy_intolerance',
      'condition',
      'medication_request',
      'observation',
    ]);
  });

  it('holds an encounter, naming it but not guessing its patient', () => {
    expect(describeOfflineRead(`/encounters/${ENCOUNTER.toUpperCase()}`)).toEqual({
      resourceType: 'encounter',
      action: 'read',
      patientId: null,
      resourceId: ENCOUNTER,
      clinical: true,
    });
  });

  it('never holds the full history, notes, consents or anything malformed', () => {
    for (const path of [
      `/patients/${PATIENT}/timeline`,
      `/patients/${PATIENT}/consents`,
      `/patients/${PATIENT}/procedures`,
      `/encounters/${ENCOUNTER}/notes`,
      `/patients/${PATIENT}/allergies/`,
      '/patients/not-a-uuid/allergies',
      `/patients/${PATIENT}?include=everything`,
    ]) {
      expect(describeOfflineRead(path), path).toBeNull();
    }
  });
});
