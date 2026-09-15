import { describe, expect, it } from 'vitest';
import { describeResults } from './timeline.service';

describe('describing a lab set on the timeline', () => {
  it('names the values outside their range first, with the count of tests', () => {
    expect(
      describeResults([
        { code: '1975-2', value: '0.9', unit: 'mg/dL', interpretation: 'normal' },
        { code: '1742-6', value: '82', unit: 'U/L', interpretation: 'high' },
        { code: '1751-7', value: '3.2', unit: 'g/dL', interpretation: 'low' },
      ]),
    ).toBe('ALT (SGPT) 82 U/L high · Albumin 3.2 g/dL low · 3 tests');
  });

  it('says a set is within range only when every value was compared and is', () => {
    expect(
      describeResults([
        { code: '1975-2', value: '0.9', unit: 'mg/dL', interpretation: 'normal' },
        { code: '1742-6', value: '40', unit: 'U/L', interpretation: 'normal' },
      ]),
    ).toBe('2 tests, all within range');

    expect(
      describeResults([
        { code: '1975-2', value: '0.9', unit: 'mg/dL', interpretation: 'normal' },
        { code: '1742-6', value: '40', unit: 'U/L', interpretation: null },
      ]),
    ).toBe('2 tests');
  });

  it('falls back to the code for an analyte no panel knows', () => {
    expect(
      describeResults([{ code: '9999-9', value: '5', unit: null, interpretation: 'abnormal' }]),
    ).toBe('9999-9 5 abnormal · 1 test');
  });
});
