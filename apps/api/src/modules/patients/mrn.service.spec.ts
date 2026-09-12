import { describe, expect, it } from 'vitest';
import { formatMrn } from './mrn.service';

describe('formatMrn', () => {
  it('joins the hospital prefix to a zero-padded sequence', () => {
    expect(formatMrn('SAH', 1)).toBe('SAH-000001');
    expect(formatMrn('CGH', 42)).toBe('CGH-000042');
  });

  it('pads to six digits so numbers line up in printed lists', () => {
    // MRNs are read off paper far more often than off a screen.
    expect(formatMrn('AUD', 7)).toHaveLength('AUD-000007'.length);
    expect(formatMrn('AUD', 999999)).toBe('AUD-999999');
  });

  it('sorts correctly as text', () => {
    const sorted = [formatMrn('X', 10), formatMrn('X', 2), formatMrn('X', 1)].sort();
    expect(sorted).toEqual(['X-000001', 'X-000002', 'X-000010']);
  });

  it('keeps growing past six digits rather than truncating', () => {
    // A large hospital will exceed a million records. Silently wrapping or
    // truncating would reissue a number that is already on a wristband.
    expect(formatMrn('BIG', 1_000_000)).toBe('BIG-1000000');
    expect(formatMrn('BIG', 12_345_678)).toBe('BIG-12345678');
  });
});
