import { describe, expect, it } from 'vitest';
import {
  CLINICAL_DATA_CATEGORIES,
  DOCUMENT_TYPES,
  RESULT_INTERPRETATIONS,
  STAFF_ROLES,
  TIMELINE_KINDS,
} from '@health24/shared';
import en from './locales/en.json';
import { describeDevice, displayPhone, formatBytes, formatDate } from './format';

describe('portal formatting', () => {
  it('shows a calendar date as the day in India, not the day in UTC', () => {
    expect(formatDate('2026-04-12')).toBe('12 Apr 2026');
    // 20:00 UTC is already the next day in India.
    expect(formatDate('2026-04-11T20:00:00.000Z')).toBe('12 Apr 2026');
  });

  it('shows an Indian mobile number back as it is read aloud', () => {
    expect(displayPhone('+919820012345')).toBe('+91 98200 12345');
    expect(displayPhone('098200-12345')).toBe('+91 98200 12345');
  });

  it('names a device from its browser', () => {
    expect(
      describeDevice(
        'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36',
      ),
    ).toBe('Chrome on Android');
    expect(describeDevice(null)).toBeNull();
  });

  it('gives a small file in kilobytes, never as 0 MB', () => {
    expect(formatBytes(1200)).toBe('1 KB');
    expect(formatBytes(340_000)).toBe('332 KB');
    expect(formatBytes(2_500_000)).toBe('2.4 MB');
  });
});

describe('the message catalogue', () => {
  const leaves = (value: unknown, path = ''): Array<[string, unknown]> =>
    value && typeof value === 'object'
      ? Object.entries(value).flatMap(([key, child]) => leaves(child, path ? `${path}.${key}` : key))
      : [[path, value]];

  it('has words for every message', () => {
    const empty = leaves(en).filter(([, text]) => typeof text !== 'string' || text.trim() === '');
    expect(empty).toEqual([]);
  });

  it('names a visit for every kind of encounter', () => {
    expect(Object.keys(en.visit).sort()).toEqual(
      ['emergency', 'inpatient', 'outpatient', 'teleconsultation'].sort(),
    );
  });

  it('names every kind of timeline entry, document and result flag', () => {
    expect(Object.keys(en.kind).sort()).toEqual([...TIMELINE_KINDS].sort());
    expect(Object.keys(en.docType).sort()).toEqual([...DOCUMENT_TYPES].sort());
    expect(Object.keys(en.category).sort()).toEqual([...CLINICAL_DATA_CATEGORIES].sort());
    expect(Object.keys(en.role).sort()).toEqual([...STAFF_ROLES].sort());
    // Access history words an unknown resource type rather than showing its name.
    expect(en.resource.other).toBeTruthy();
    for (const interpretation of RESULT_INTERPRETATIONS) {
      expect(en.results).toHaveProperty(`flag_${interpretation}`);
    }
  });
});
