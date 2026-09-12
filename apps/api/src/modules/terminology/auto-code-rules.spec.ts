import { describe, expect, it } from 'vitest';
import type { Coding } from '@health24/shared';
import { byStrength, decideAutoCode, type CandidateMapping } from './auto-code-rules';

const primary: Coding = {
  system: 'namaste',
  systemVersion: 'v1',
  code: 'NAM-001',
  display: 'Amlapitta',
  role: 'primary',
  equivalence: null,
  confidence: null,
  conceptMapElementId: null,
};

let sequence = 0;

function mapping(overrides: Partial<CandidateMapping>): CandidateMapping {
  sequence += 1;
  return {
    elementId: `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
    status: 'approved',
    equivalence: 'equivalent',
    confidence: null,
    targetKey: 'icd11-tm2',
    targetVersion: 'v1',
    targetCode: `T-${sequence}`,
    targetDisplay: `Target ${sequence}`,
    experimental: false,
    ...overrides,
  };
}

const tm2 = (overrides: Partial<CandidateMapping> = {}) =>
  mapping({ targetKey: 'icd11-tm2', ...overrides });
const mms = (overrides: Partial<CandidateMapping> = {}) =>
  mapping({ targetKey: 'icd11-mms', ...overrides });

const decide = (mappings: CandidateMapping[], primaryExperimental = false) =>
  decideAutoCode({ primary, primaryExperimental, mappings });

describe('decideAutoCode — safety', () => {
  it('never attaches a proposed mapping, however plausible', () => {
    // The single most important rule. An unreviewed correspondence attached to
    // a patient's diagnosis is a clinical assertion nobody made.
    const result = decide([
      tm2({ status: 'proposed', equivalence: 'equivalent' }),
      mms({ status: 'proposed', equivalence: 'equivalent' }),
    ]);

    expect(result.translated).toBeNull();
    expect(result.advisory).toBeNull();
    expect(result.notes).toContain(
      'A TM2 mapping for this code is awaiting curator review and is not attached.',
    );
    expect(result.notes).toContain(
      'A biomedical mapping for this code is awaiting curator review and is not attached.',
    );
  });

  it('never attaches a rejected or retired mapping', () => {
    const result = decide([
      tm2({ status: 'rejected' }),
      tm2({ status: 'retired' }),
      mms({ status: 'rejected' }),
      mms({ status: 'retired' }),
    ]);

    expect(result.translated).toBeNull();
    expect(result.advisory).toBeNull();
  });

  it('never suggests a narrower biomedical correspondence', () => {
    const result = decide([mms({ equivalence: 'narrower' })]);

    expect(result.advisory).toBeNull();
    expect(result.notes.join(' ')).toContain('narrower');
  });

  it('never suggests an inexact biomedical correspondence', () => {
    const result = decide([mms({ equivalence: 'inexact' })]);

    expect(result.advisory).toBeNull();
    expect(result.notes.join(' ')).toContain('inexact');
  });

  it('marks a biomedical code as advisory, never as translated', () => {
    const result = decide([mms({ equivalence: 'equivalent' })]);

    expect(result.advisory?.role).toBe('advisory');
    expect(result.notes).toContain(
      'The biomedical code is advisory: a suggested correspondence, not a diagnosis.',
    );
  });

  it('keeps an unmatched mapping from becoming a coding', () => {
    const result = decide([
      tm2({ equivalence: 'unmatched', targetCode: null, targetDisplay: null }),
      mms({ equivalence: 'unmatched', targetCode: null, targetDisplay: null }),
    ]);

    expect(result.translated).toBeNull();
    expect(result.advisory).toBeNull();
    expect(result.notes).toContain('Reviewed: this code has no TM2 correspondence.');
    expect(result.notes).toContain('Reviewed: this code has no biomedical correspondence.');
  });
});

describe('decideAutoCode — attaching', () => {
  it('attaches an approved equivalent TM2 translation with its provenance', () => {
    const approved = tm2({ equivalence: 'equivalent', targetCode: 'TM2-A', targetDisplay: 'A' });
    const result = decide([approved]);

    expect(result.translated).toMatchObject({
      system: 'icd11-tm2',
      code: 'TM2-A',
      display: 'A',
      role: 'translated',
      equivalence: 'equivalent',
      // The coding carries the mapping it rests on, so the decision is traceable.
      conceptMapElementId: approved.elementId,
    });
  });

  it('attaches a non-equivalent TM2 translation but says so', () => {
    const result = decide([tm2({ equivalence: 'wider' })]);

    expect(result.translated?.equivalence).toBe('wider');
    expect(result.notes.join(' ')).toContain('wider, not equivalent');
  });

  it('suggests a wider biomedical correspondence', () => {
    const result = decide([mms({ equivalence: 'wider' })]);
    expect(result.advisory?.equivalence).toBe('wider');
  });

  it('chooses the strongest of several approved TM2 correspondences', () => {
    const result = decide([
      tm2({ equivalence: 'inexact', targetCode: 'WEAK' }),
      tm2({ equivalence: 'equivalent', targetCode: 'STRONG' }),
      tm2({ equivalence: 'wider', targetCode: 'MIDDLE' }),
    ]);

    expect(result.translated?.code).toBe('STRONG');
    expect(result.notes.join(' ')).toContain('2 further approved TM2');
  });

  it('prefers an attachable biomedical code over a stronger-looking unattachable one', () => {
    // A narrower mapping with high confidence must not crowd out a wider one
    // that is actually allowed to be suggested.
    const result = decide([
      mms({ equivalence: 'narrower', confidence: 0.99, targetCode: 'NARROW' }),
      mms({ equivalence: 'wider', confidence: 0.4, targetCode: 'WIDE' }),
    ]);

    expect(result.advisory?.code).toBe('WIDE');
  });

  it('ignores mappings to code systems the rules do not use', () => {
    const result = decide([mapping({ targetKey: 'snomed-ct' })]);

    expect(result.translated).toBeNull();
    expect(result.advisory).toBeNull();
  });

  it('explains an entirely unmapped code rather than failing', () => {
    const result = decide([]);

    expect(result.primary).toEqual(primary);
    expect(result.translated).toBeNull();
    expect(result.advisory).toBeNull();
    expect(result.notes).toEqual([
      'No reviewed TM2 mapping exists for this code yet.',
      'No reviewed biomedical mapping exists for this code yet.',
    ]);
  });
});

describe('decideAutoCode — demo data', () => {
  it('leads with a warning when the clinician selected a demo code', () => {
    const result = decide([], true);
    expect(result.notes[0]).toBe('Demo terminology — not for use on a real patient record.');
  });

  it('warns when an attached coding comes from demo data', () => {
    const result = decide([tm2({ experimental: true })]);
    expect(result.notes[0]).toBe('Demo terminology — not for use on a real patient record.');
  });
});

describe('byStrength', () => {
  it('orders by equivalence, then confidence, then code', () => {
    const ordered = [
      mapping({ equivalence: 'wider', confidence: 0.9, targetCode: 'b' }),
      mapping({ equivalence: 'equivalent', confidence: 0.1, targetCode: 'z' }),
      mapping({ equivalence: 'wider', confidence: 0.9, targetCode: 'a' }),
      mapping({ equivalence: 'wider', confidence: null, targetCode: 'c' }),
    ].sort(byStrength);

    expect(ordered.map((entry) => entry.targetCode)).toEqual(['z', 'a', 'b', 'c']);
  });
});
