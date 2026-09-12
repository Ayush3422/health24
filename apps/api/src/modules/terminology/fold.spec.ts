import { describe, expect, it } from 'vitest';
import { foldTerm } from '@health24/shared';

describe('foldTerm', () => {
  it('reaches the same key from Devanagari, plain Latin, capitals and IAST', () => {
    // The requirement from planning.md §7.2: a vaidya searching any of these
    // must land on the same concept.
    const key = foldTerm('अम्लपित्त');

    expect(key).toBe('amlapitt');
    expect(foldTerm('amlapitta')).toBe(key);
    expect(foldTerm('Amlapitta')).toBe(key);
    expect(foldTerm('AMLAPITTA')).toBe(key);
  });

  it('meets Sanskrit spelling and the way Hindi speakers type', () => {
    // ज्वर is written jvara in Sanskrit and typed "jwar" by most users.
    expect(foldTerm('ज्वर')).toBe('jvar');
    expect(foldTerm('Jvara')).toBe('jvar');
    expect(foldTerm('jwar')).toBe('jvar');
    expect(foldTerm('Jvāra')).toBe('jvar');
  });

  it('treats IAST sibilants the same as their Devanagari letters', () => {
    // Stripping the mark from ś would give s, while श transliterates to sh —
    // the two would never meet without special handling.
    expect(foldTerm('श्वास')).toBe('shvas');
    expect(foldTerm('śvāsa')).toBe('shvas');
    expect(foldTerm('shvasa')).toBe('shvas');
  });

  it('folds c and ch together, as IAST and common spelling disagree on them', () => {
    expect(foldTerm('चित्त')).toBe('citt');
    expect(foldTerm('citta')).toBe('citt');
    expect(foldTerm('chitta')).toBe('citt');
  });

  it('resolves an anusvara to the nasal the following letter needs', () => {
    expect(foldTerm('संधिगत वात')).toBe('sandhigat vat');
    expect(foldTerm('Sandhigata Vata')).toBe('sandhigat vat');
    // Before a labial it is m, not n.
    expect(foldTerm('कंप')).toBe('kamp');
    expect(foldTerm('kampa')).toBe('kamp');
  });

  it('handles conjuncts and vowel signs', () => {
    expect(foldTerm('प्रमेह')).toBe('prameh');
    expect(foldTerm('Prameha')).toBe('prameh');
  });

  it('meets doubled vowels typed for long ones', () => {
    // Users write "ee" and "oo" for ई and ऊ.
    expect(foldTerm('दीपक')).toBe(foldTerm('deepak'));
  });

  it('keeps separate words separate', () => {
    expect(foldTerm('Sandhigata  -  Vata')).toBe('sandhigat vat');
  });

  it('converts Devanagari digits', () => {
    expect(foldTerm('१२३')).toBe('123');
  });

  it('leaves short words their final vowel', () => {
    // Dropping it from a three-letter word costs more precision than it earns.
    expect(foldTerm('ama')).toBe('ama');
  });

  it('returns an empty key for empty or punctuation-only input', () => {
    expect(foldTerm('')).toBe('');
    expect(foldTerm('  --  ')).toBe('');
    expect(foldTerm('्')).toBe('');
  });

  it('is idempotent', () => {
    // Folding an already-folded key must not change it again, or a stored
    // index value would drift from a re-folded query.
    for (const term of ['अम्लपित्त', 'Jvāra', 'संधिगत वात', 'śvāsa', 'चित्त', 'दीपक']) {
      const once = foldTerm(term);
      expect(foldTerm(once)).toBe(once);
    }
  });
});
