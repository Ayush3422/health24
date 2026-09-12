import { describe, expect, it } from 'vitest';
import { conceptMapReleaseSchema, terminologyReleaseSchema } from '@health24/shared';
import { hashCodeSystemRelease, hashConceptMapRelease } from './release-hash';

const release = () =>
  terminologyReleaseSchema.parse({
    codeSystem: {
      key: 'namaste',
      uri: 'urn:test:namaste',
      name: 'Test',
      version: 'v1',
      publisher: 'Test publisher',
      experimental: true,
    },
    concepts: [
      {
        code: 'B',
        display: 'Jvara',
        designations: [
          { language: 'sa-Deva', use: 'transliteration', value: 'ज्वर' },
          { language: 'sa-Latn', use: 'transliteration', value: 'jvara' },
        ],
      },
      { code: 'A', display: 'Amlapitta' },
    ],
  });

describe('hashCodeSystemRelease', () => {
  it('is stable for identical content', () => {
    expect(hashCodeSystemRelease(release())).toBe(hashCodeSystemRelease(release()));
  });

  it('ignores the order concepts appear in the file', () => {
    const original = release();
    const reordered = { ...original, concepts: [...original.concepts].reverse() };

    expect(hashCodeSystemRelease(reordered)).toBe(hashCodeSystemRelease(original));
  });

  it('ignores the order of designations', () => {
    const original = release();
    const reordered = {
      ...original,
      concepts: original.concepts.map((concept) => ({
        ...concept,
        designations: [...concept.designations].reverse(),
      })),
    };

    expect(hashCodeSystemRelease(reordered)).toBe(hashCodeSystemRelease(original));
  });

  it('ignores key order within objects', () => {
    const original = release();
    const { publisher, name, ...rest } = original.codeSystem;
    const reordered = { ...original, codeSystem: { publisher, ...rest, name } };

    expect(hashCodeSystemRelease(reordered)).toBe(hashCodeSystemRelease(original));
  });

  it('treats an omitted default and an explicit default as the same release', () => {
    const base = {
      codeSystem: { key: 'namaste', uri: 'u', name: 'n', version: 'v1', publisher: 'p' },
      concepts: [{ code: 'A', display: 'Amlapitta' }],
    };

    const omitted = terminologyReleaseSchema.parse(base);
    const explicit = terminologyReleaseSchema.parse({
      ...base,
      codeSystem: { ...base.codeSystem, experimental: false },
      concepts: [{ code: 'A', display: 'Amlapitta', designations: [] }],
    });

    expect(hashCodeSystemRelease(omitted)).toBe(hashCodeSystemRelease(explicit));
  });

  it('changes when a display changes', () => {
    // The case the hash exists for: same version, different content.
    const original = release();
    const edited = {
      ...original,
      concepts: original.concepts.map((concept) =>
        concept.code === 'A' ? { ...concept, display: 'Amlapitta (edited)' } : concept,
      ),
    };

    expect(hashCodeSystemRelease(edited)).not.toBe(hashCodeSystemRelease(original));
  });

  it('changes when a code is added', () => {
    const original = release();
    const extended = {
      ...original,
      concepts: [...original.concepts, { code: 'C', display: 'Prameha', designations: [] }],
    };

    expect(hashCodeSystemRelease(extended)).not.toBe(hashCodeSystemRelease(original));
  });
});

describe('hashConceptMapRelease', () => {
  const map = () =>
    conceptMapReleaseSchema.parse({
      map: {
        key: 'namaste-to-tm2',
        name: 'Test map',
        version: 'v1',
        publisher: 'Test',
        source: { key: 'namaste', version: 'v1' },
        target: { key: 'icd11-tm2', version: 'v1' },
      },
      elements: [
        { sourceCode: 'A', targetCode: 'T1', equivalence: 'equivalent' },
        { sourceCode: 'B', targetCode: null, equivalence: 'unmatched' },
      ],
    });

  it('ignores element order', () => {
    const original = map();
    const reordered = { ...original, elements: [...original.elements].reverse() };

    expect(hashConceptMapRelease(reordered)).toBe(hashConceptMapRelease(original));
  });

  it('changes when an equivalence changes', () => {
    // equivalent → inexact decides whether a biomedical code is attached to a
    // patient's diagnosis at all. It must never pass as the same release.
    const original = map();
    const weakened = {
      ...original,
      elements: original.elements.map((element) =>
        element.sourceCode === 'A' ? { ...element, equivalence: 'inexact' as const } : element,
      ),
    };

    expect(hashConceptMapRelease(weakened)).not.toBe(hashConceptMapRelease(original));
  });

  it('changes when the review policy changes', () => {
    const original = map();
    const authoritative = {
      ...original,
      map: { ...original.map, reviewPolicy: 'authoritative' as const },
    };

    expect(hashConceptMapRelease(authoritative)).not.toBe(hashConceptMapRelease(original));
  });
});
