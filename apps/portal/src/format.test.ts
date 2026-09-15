import { describe, expect, it } from 'vitest';
import en from './locales/en.json';
import { describeDevice, displayPhone, formatDate } from './format';

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
});
