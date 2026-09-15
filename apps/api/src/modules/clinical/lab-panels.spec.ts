import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  LAB_PANELS,
  LAB_PANEL_KEYS,
  findAnalyte,
  interpretResult,
  recordResultsSchema,
  toCanonicalValue,
  type LabAnalyte,
} from '@health24/shared';

const all = (): LabAnalyte[] =>
  LAB_PANEL_KEYS.flatMap((key) => LAB_PANELS[key].analytes as readonly LabAnalyte[]);

describe('lab panels', () => {
  it('give every analyte one code, a canonical unit first, and defaults inside plausibility', () => {
    const codes = all().map((analyte) => analyte.code);
    expect(new Set(codes).size).toBe(codes.length);

    for (const analyte of all()) {
      expect(analyte.units[0].toCanonical, analyte.label).toBe(1);
      expect(analyte.min, analyte.label).toBeLessThan(analyte.max);

      const { low, high } = analyte.defaultRange ?? {};
      if (low !== undefined) expect(low, analyte.label).toBeGreaterThanOrEqual(analyte.min);
      if (high !== undefined) expect(high, analyte.label).toBeLessThanOrEqual(analyte.max);
      if (low !== undefined && high !== undefined) expect(low).toBeLessThan(high);
    }
  });

  it('find an analyte by its code', () => {
    expect(findAnalyte('1742-6')).toMatchObject({ panel: 'lft', analyte: { label: 'ALT (SGPT)' } });
    expect(findAnalyte('0000-0')).toBeNull();
  });
});

describe('toCanonicalValue', () => {
  const bilirubin = findAnalyte('1975-2')!.analyte;
  const platelets = findAnalyte('777-3')!.analyte;

  it('converts only through the factors a panel defines', () => {
    expect(toCanonicalValue(bilirubin, 17.104, 'umol/L')).toBe(1);
    expect(toCanonicalValue(bilirubin, 1.2, 'mg/dL')).toBe(1.2);
    // Indian laboratories often report platelets in lakhs.
    expect(toCanonicalValue(platelets, 2.5, '10*5/uL')).toBe(250);
    expect(toCanonicalValue(bilirubin, 1, 'g/L')).toBeNull();
  });
});

describe('interpretResult', () => {
  it('compares against the range printed on the report', () => {
    expect(interpretResult({ value: 82, low: 7, high: 56 })).toBe('high');
    expect(interpretResult({ value: 5, low: 7, high: 56 })).toBe('low');
    expect(interpretResult({ value: 30, low: 7, high: 56 })).toBe('normal');
    expect(interpretResult({ value: 180, high: 200 })).toBe('normal');
  });

  it('prefers the numeric range to the lab’s flag, and uses the flag without one', () => {
    expect(interpretResult({ value: 30, low: 7, high: 56, labFlag: 'H' })).toBe('normal');
    expect(interpretResult({ value: 3.2, labFlag: 'L' })).toBe('low');
    expect(interpretResult({ value: 9, labFlag: '*' })).toBe('abnormal');
    expect(interpretResult({ value: 9 })).toBeNull();
  });
});

describe('recordResultsSchema', () => {
  const base = {
    patientId: randomUUID(),
    panel: 'lft',
    collectedAt: '2026-09-01T09:30:00+05:30',
  };

  const issues = (results: unknown[], extra: Record<string, unknown> = {}) => {
    const parsed = recordResultsSchema.safeParse({ ...base, ...extra, results });
    return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
  };

  it('accepts values of the panel, in its units, within plausibility', () => {
    expect(
      issues([
        { code: '1742-6', value: 82, unit: 'U/L', referenceLow: 7, referenceHigh: 56 },
        { code: '1975-2', value: 17.1, unit: 'umol/L' },
      ]),
    ).toEqual([]);
  });

  it('refuses another panel’s analyte, a unit it is not reported in, and a typing error', () => {
    expect(issues([{ code: '3016-3', value: 2, unit: 'm[IU]/L' }]).join()).toMatch(/Not part of/);
    expect(issues([{ code: '1742-6', value: 82, unit: 'mmol/L' }]).join()).toMatch(
      /not reported in/,
    );
    expect(issues([{ code: '1742-6', value: 999_999, unit: 'U/L' }]).join()).toMatch(
      /not plausible/,
    );
  });

  it('refuses a value entered twice, a backwards range, and a future collection', () => {
    expect(
      issues([
        { code: '1742-6', value: 82, unit: 'U/L' },
        { code: '1742-6', value: 80, unit: 'U/L' },
      ]).join(),
    ).toMatch(/entered twice/);
    expect(
      issues([
        { code: '1742-6', value: 82, unit: 'U/L', referenceLow: 56, referenceHigh: 7 },
      ]).join(),
    ).toMatch(/ends below/);
    expect(
      issues([{ code: '1742-6', value: 82, unit: 'U/L' }], {
        collectedAt: '2999-01-01T00:00:00Z',
      }).join(),
    ).toMatch(/future/);
  });
});
