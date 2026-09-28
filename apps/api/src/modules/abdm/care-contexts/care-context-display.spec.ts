import { describe, expect, it } from 'vitest';
import { careContextDisplay } from './care-context-display';

/**
 * The one string in this system that a stranger reads (sp8-plan.md, T10).
 *
 * It appears in the consent manager's app, it travels with every consent
 * request, and it sits in a list somebody may glance at over the patient's
 * shoulder. The test that matters here is the negative one: whatever else
 * changes about the wording, nothing clinical may get into it.
 */
describe('what a patient sees when asked to share a visit', () => {
  const visit = {
    startedAt: '2026-04-12T04:30:00.000Z',
    class: 'outpatient',
    hospitalName: 'Sanjeevani Ayurveda',
  };

  it('names the day, the kind of visit and the hospital', () => {
    expect(careContextDisplay(visit)).toBe('OPD visit, 12 Apr 2026 · Sanjeevani Ayurveda');
  });

  it('reads the date in India Standard Time', () => {
    // Half past nine in the evening, UTC, on the eleventh — which in India is
    // already three in the morning on the twelfth. A patient reading "11 Apr"
    // for a visit they remember on the twelfth would not trust the rest.
    expect(
      careContextDisplay({ ...visit, startedAt: '2026-04-11T21:30:00.000Z' }),
    ).toContain('12 Apr 2026');
  });

  it('has a word for each kind of visit, and a safe one for anything else', () => {
    expect(careContextDisplay({ ...visit, class: 'inpatient' })).toContain('Admission');
    expect(careContextDisplay({ ...visit, class: 'emergency' })).toContain('Emergency visit');
    expect(careContextDisplay({ ...visit, class: 'teleconsultation' })).toContain(
      'Teleconsultation',
    );
    expect(careContextDisplay({ ...visit, class: 'something-new' })).toContain('Visit');
  });

  /**
   * Written as a property rather than a list of forbidden words, because the
   * failure this guards against is somebody adding the chief complaint to be
   * helpful — and being helpful is exactly how it would happen.
   */
  it('takes nothing from the visit but its date, kind and hospital', () => {
    const display = careContextDisplay({
      ...visit,
      // A neutral hospital name, so that what the assertion catches is the
      // leak rather than the word "Ayurveda" in "Sanjeevani Ayurveda".
      hospitalName: 'City Clinic',
      // Anything a real encounter carries beside the three it may use.
      ...({
        chiefComplaint: 'Burning in the chest after meals',
        clinicianName: 'Dr Meera Joshi',
        systemOfMedicine: 'ayurveda',
        diagnosis: 'Amlapitta',
      } as Record<string, unknown>),
    });

    expect(display).not.toMatch(/burning|chest|meera|ayurveda|amlapitta/i);
    expect(display).toBe('OPD visit, 12 Apr 2026 · City Clinic');
  });
});
