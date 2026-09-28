import { describe, expect, it } from 'vitest';
import { CLINICAL_DATA_CATEGORIES } from '@health24/shared';
import { knownHiTypes, mapHiTypes } from './hi-type-mapping';

/**
 * The translation where a consent could quietly become wider than the patient
 * agreed to (sp8-plan.md, T15).
 *
 * Tested as rules rather than as a table, because the table will change when
 * the sandbox says it must (T38) and these must survive that.
 */
describe('mapping ABDM health information types', () => {
  it('grants exactly what a prescription is', () => {
    expect(mapHiTypes(['Prescription'])).toEqual({
      categories: ['medications'],
      unmapped: [],
    });
  });

  it('adds up what several types ask for, without repeating anything', () => {
    const mapped = mapHiTypes(['Prescription', 'DischargeSummary', 'Prescription']);

    expect(mapped.categories).toEqual(['encounters', 'diagnoses', 'medications', 'procedures']);
    expect(new Set(mapped.categories).size).toBe(mapped.categories.length);
  });

  it('puts the categories in one order however they were asked for', () => {
    const one = mapHiTypes(['DiagnosticReport', 'Prescription']);
    const other = mapHiTypes(['Prescription', 'DiagnosticReport']);

    expect(one.categories).toEqual(other.categories);
  });

  /**
   * The rule SP5 set for the patient's own export, kept here. Whether a
   * doctor's free text belongs in a bundle is a clinical reviewer's decision,
   * and no health information type may make it for them.
   */
  it('never grants clinicians’ notes, whatever is asked for', () => {
    for (const type of knownHiTypes()) {
      expect(mapHiTypes([type]).categories).not.toContain('notes');
    }

    expect(mapHiTypes(knownHiTypes()).categories).not.toContain('notes');
  });

  it('records what it could not map rather than dropping it', () => {
    const mapped = mapHiTypes(['Prescription', 'SomethingAbdmAddedLastYear']);

    expect(mapped.categories).toEqual(['medications']);
    expect(mapped.unmapped).toEqual(['SomethingAbdmAddedLastYear']);
  });

  it('treats a type it knows but does not model as unmapped, not as unknown', () => {
    // Immunisations are a real ABDM type that this system holds nothing for.
    // Saying "we grant nothing for this" is different from not recognising it.
    const mapped = mapHiTypes(['ImmunizationRecord']);

    expect(mapped.categories).toEqual([]);
    expect(mapped.unmapped).toEqual(['ImmunizationRecord']);
  });

  it('grants nothing at all for a consent it understands none of', () => {
    expect(mapHiTypes(['Nothing', 'WeKnow']).categories).toEqual([]);
  });

  it('only ever names categories this system actually has', () => {
    const everything = mapHiTypes(knownHiTypes());

    for (const category of everything.categories) {
      expect(CLINICAL_DATA_CATEGORIES).toContain(category);
    }
  });
});
