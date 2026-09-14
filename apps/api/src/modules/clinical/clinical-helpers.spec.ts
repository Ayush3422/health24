import { describe, expect, it } from 'vitest';
import { LOINC_SYSTEM, VITAL_SIGNS } from '@health24/shared';
import { violatedConstraint } from './clinical-access';
import { composeSections } from './notes.service';
import { describeVitals } from './timeline.service';
import { bodyMassIndex } from './vitals.service';

describe('bodyMassIndex', () => {
  it('works from centimetres and kilograms, to one decimal place', () => {
    expect(bodyMassIndex(160, 64)).toBe(25);
    expect(bodyMassIndex(175, 70)).toBe(22.9);
  });
});

describe('composeSections', () => {
  it('keeps the sections that were written, in the template’s order, trimmed', () => {
    expect(
      composeSections('general', {
        plan: 'Review in two weeks',
        subjective: '  Burning after meals  ',
        objective: '   ',
      }),
    ).toEqual([
      { key: 'subjective', label: 'Subjective', text: 'Burning after meals' },
      { key: 'plan', label: 'Plan', text: 'Review in two weeks' },
    ]);
  });

  it('ignores a key the template does not have', () => {
    expect(composeSections('follow_up', { pradhana_vedana: 'Not a follow-up section' })).toEqual(
      [],
    );
  });
});

describe('describeVitals', () => {
  const reading = (key: keyof typeof VITAL_SIGNS, value: string) => ({
    code: VITAL_SIGNS[key].code,
    value,
    unit: VITAL_SIGNS[key].unit,
  });

  it('writes blood pressure as one reading, then the rest in panel order', () => {
    expect(
      describeVitals([
        reading('temperature', '37.2'),
        reading('diastolic', '85'),
        reading('heartRate', '80'),
        reading('systolic', '130'),
      ]),
    ).toBe('BP 130/85 mmHg · Pulse 80 /min · Temperature 37.2 °C');
  });

  it('leaves out half a blood pressure and codes it does not know', () => {
    expect(
      describeVitals([
        reading('systolic', '130'),
        { code: '99999-9', value: '1', unit: null },
        reading('weight', '64'),
      ]),
    ).toBe('Weight 64 kg');
  });

  it('is empty for no readings', () => {
    expect(describeVitals([])).toBe('');
    expect(LOINC_SYSTEM).toBe('http://loinc.org');
  });
});

describe('violatedConstraint', () => {
  it('names the constraint a database error broke, however it is wrapped', () => {
    expect(violatedConstraint({ constraint_name: 'condition_one_primary_per_encounter' })).toBe(
      'condition_one_primary_per_encounter',
    );
    expect(violatedConstraint({ cause: { constraint_name: 'consent_artefact_is_brief' } })).toBe(
      'consent_artefact_is_brief',
    );
  });

  it('is null for anything else', () => {
    expect(violatedConstraint(new Error('boom'))).toBeNull();
    expect(violatedConstraint(null)).toBeNull();
  });
});
