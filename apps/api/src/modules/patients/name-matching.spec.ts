import { describe, expect, it } from 'vitest';
import {
  AUTO_LINK_THRESHOLD,
  MAX_PROBABILISTIC_SCORE,
  REVIEW_THRESHOLD,
  deriveBirthYear,
  maskName,
  maskPhone,
  nameSimilarity,
  normalizeName,
  scoreIdentities,
} from './name-matching';

describe('normalizeName', () => {
  it('lowercases and collapses whitespace', () => {
    expect(normalizeName('  Ramesh   Kumar  ')).toBe('ramesh kumar');
  });

  it('strips honorifics, including stacked ones', () => {
    expect(normalizeName('Dr. Meera Joshi')).toBe('meera joshi');
    expect(normalizeName('Dr. Mrs. Meera Joshi')).toBe('meera joshi');
    expect(normalizeName('Shri Ramesh Kumar')).toBe('ramesh kumar');
  });

  it('strips relationship prefixes common on Indian registers', () => {
    // Newborns are routinely registered as "baby of <mother>" before naming.
    expect(normalizeName('B/O Sunita Devi')).toBe('sunita devi');
    expect(normalizeName('S/O Ramesh Kumar')).toBe('ramesh kumar');
    expect(normalizeName('W/O Arun Nair')).toBe('arun nair');
  });

  it('strips Latin diacritics', () => {
    expect(normalizeName('José Fernándes')).toBe('jose fernandes');
  });

  it('leaves Devanagari intact', () => {
    // Indic combining marks carry vowels; stripping them would corrupt the name.
    expect(normalizeName('अम्लपित्त')).toBe('अम्लपित्त');
    expect(normalizeName('रमेश कुमार')).toBe('रमेश कुमार');
  });

  it('does not strip a title-like word that is part of the name', () => {
    // "Kumari" is a title, but "Kumari Selja" is a real name — the leading
    // token is removed, which is the documented trade-off.
    expect(normalizeName('Ramesh Kumar Master')).toBe('ramesh kumar master');
  });
});

describe('nameSimilarity', () => {
  it('scores identical names as 1', () => {
    expect(nameSimilarity('Ramesh Kumar', 'ramesh kumar')).toBe(1);
  });

  it('matches reordered given and family names', () => {
    // Indian records reverse name order constantly.
    expect(nameSimilarity('Meera Joshi', 'Joshi Meera')).toBeGreaterThan(0.9);
  });

  it('matches an initial against the full given name', () => {
    expect(nameSimilarity('A. Nair', 'Arun Nair')).toBeGreaterThan(0.7);
  });

  it('tolerates a spelling variant', () => {
    expect(nameSimilarity('Sunita Devi', 'Suneeta Devi')).toBeGreaterThan(0.7);
  });

  it('scores genuinely different names low', () => {
    expect(nameSimilarity('Ramesh Kumar', 'Sunita Devi')).toBeLessThan(0.3);
  });

  it('penalises an extra name rather than ignoring it', () => {
    const withMiddle = nameSimilarity('Ramesh Kumar', 'Ramesh Suresh Kumar');
    expect(withMiddle).toBeGreaterThan(0.5);
    expect(withMiddle).toBeLessThan(1);
  });

  it('returns 0 when either name is empty after normalisation', () => {
    expect(nameSimilarity('Dr.', 'Ramesh')).toBe(0);
  });
});

describe('deriveBirthYear', () => {
  const now = new Date('2026-06-15T00:00:00Z');

  it('reads the year from a date of birth', () => {
    expect(deriveBirthYear('1984-03-02', null, now)).toBe(1984);
  });

  it('derives a year from an approximate age', () => {
    expect(deriveBirthYear(null, 42, now)).toBe(1984);
  });

  it('prefers the date of birth when both are present', () => {
    expect(deriveBirthYear('1990-01-01', 42, now)).toBe(1990);
  });

  it('returns null when neither is known', () => {
    expect(deriveBirthYear(null, null, now)).toBeNull();
  });
});

describe('scoreIdentities', () => {
  const base = {
    name: 'Ramesh Kumar',
    gender: 'male',
    phone: '+919812345670',
    birthYear: 1984,
  };

  it('treats a shared ABHA number as decisive', () => {
    const result = scoreIdentities(
      { ...base, abhaNumber: '12345678901234' },
      { name: 'Totally Different', gender: 'female', abhaNumber: '12345678901234' },
    );

    expect(result.score).toBe(1);
    expect(result.method).toBe('abha_exact');
  });

  it('reaches the auto-link threshold only with phone, name and birth year agreeing', () => {
    const result = scoreIdentities(base, { ...base });
    expect(result.score).toBeGreaterThanOrEqual(AUTO_LINK_THRESHOLD);
    expect(result.matchedOn).toContain('phone');
  });

  it('NEVER auto-links on a name match alone', () => {
    // There are a great many people called Ramesh Kumar. This is the single
    // most important property in the file: without a corroborating
    // identifier, a name match is a suggestion for a human, never a
    // conclusion.
    const result = scoreIdentities(
      { name: 'Ramesh Kumar', gender: 'male', birthYear: 1984 },
      { name: 'Ramesh Kumar', gender: 'male', birthYear: 1984 },
    );

    expect(result.score).toBeLessThan(AUTO_LINK_THRESHOLD);
  });

  it('caps any phoneless pairing below the auto-link threshold', () => {
    const result = scoreIdentities(
      { name: 'Meera Joshi', gender: 'female', birthYear: 1990, phone: null },
      { name: 'Meera Joshi', gender: 'female', birthYear: 1990, phone: '+919812345670' },
    );

    expect(result.score).toBeLessThanOrEqual(0.7);
  });

  it('surfaces a plausible pairing for human review', () => {
    const result = scoreIdentities(base, { ...base, name: 'Ramesh Kumarr' });
    expect(result.score).toBeGreaterThanOrEqual(REVIEW_THRESHOLD);
    expect(result.score).toBeLessThan(1);
  });

  it('reserves a score of exactly 1 for ABHA, never for accumulated evidence', () => {
    // Every probabilistic signal agreeing is strong evidence, not proof. If
    // this ever reaches 1, certainty and suspicion become indistinguishable
    // to anything reading the score downstream.
    const everythingAgrees = scoreIdentities(base, { ...base });
    expect(everythingAgrees.score).toBeLessThanOrEqual(MAX_PROBABILISTIC_SCORE);
    expect(everythingAgrees.score).toBeLessThan(1);
    expect(everythingAgrees.method).toBe('probabilistic');
  });

  it('can still auto-link without a recorded gender', () => {
    // Gender is often "undisclosed" in practice; requiring it for auto-link
    // would push every such patient into the review queue.
    const result = scoreIdentities(
      { name: 'Ramesh Kumar', phone: '+919812345670', birthYear: 1984 },
      { name: 'Ramesh Kumar', phone: '+919812345670', birthYear: 1984 },
    );

    expect(result.score).toBeGreaterThanOrEqual(AUTO_LINK_THRESHOLD);
  });

  it('subtracts for a gender mismatch rather than merely not adding', () => {
    const agreeing = scoreIdentities(base, { ...base });
    const conflicting = scoreIdentities(base, { ...base, gender: 'female' });

    // A mismatch is positive evidence of two different people.
    expect(conflicting.score).toBeLessThan(agreeing.score - 0.3);
  });

  it('subtracts for a large age gap', () => {
    const result = scoreIdentities(base, { ...base, birthYear: 1960 });
    expect(result.score).toBeLessThan(AUTO_LINK_THRESHOLD);
  });

  it('keeps two different people well below review', () => {
    const result = scoreIdentities(base, {
      name: 'Sunita Devi',
      gender: 'female',
      phone: '+919899999999',
      birthYear: 1995,
    });

    expect(result.score).toBeLessThan(REVIEW_THRESHOLD);
  });

  it('does not let a shared family handset alone trigger a match', () => {
    // Families share mobile numbers, so phone plus a weak name must stay
    // below review rather than pairing a husband with his wife.
    const result = scoreIdentities(
      { name: 'Ramesh Kumar', gender: 'male', phone: '+919812345670', birthYear: 1984 },
      { name: 'Sunita Devi', gender: 'female', phone: '+919812345670', birthYear: 1988 },
    );

    expect(result.score).toBeLessThan(REVIEW_THRESHOLD);
  });

  it('is symmetric', () => {
    const left = scoreIdentities(base, { ...base, name: 'R. Kumar' });
    const right = scoreIdentities({ ...base, name: 'R. Kumar' }, base);
    expect(left.score).toBe(right.score);
  });
});

describe('masking for the review queue', () => {
  it('masks a name while leaving it recognisable', () => {
    expect(maskName('Ramesh Kumar')).toBe('R••••• K••••');
  });

  it('masks a phone number, keeping the last four digits', () => {
    expect(maskPhone('+919812345670')).toBe('••••••5670');
  });

  it('handles an absent phone number', () => {
    expect(maskPhone(null)).toBeNull();
  });
});
