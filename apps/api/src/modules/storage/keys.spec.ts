import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { assertStorageKey, documentFileKey, parseDocumentFileKey, quarantineKeyFor } from './keys';

const ids = () => ({
  hospitalId: randomUUID(),
  patientId: randomUUID(),
  documentId: randomUUID(),
  fileId: randomUUID(),
});

describe('storage keys', () => {
  it('give back the identifiers they were built from, even from quarantine', () => {
    const parts = ids();
    const key = documentFileKey(parts);

    expect(parseDocumentFileKey(key)).toEqual(parts);
    expect(parseDocumentFileKey(quarantineKeyFor(key))).toEqual(parts);
    expect(() => parseDocumentFileKey('hospitals/x/patients/y')).toThrow();
  });

  it('are built from identifiers alone', () => {
    const parts = ids();

    expect(documentFileKey(parts)).toBe(
      `hospitals/${parts.hospitalId}/patients/${parts.patientId}/documents/${parts.documentId}/${parts.fileId}`,
    );
  });

  it('refuse anything a person typed, or a path that escapes its place', () => {
    const parts = ids();

    for (const bad of [
      { ...parts, patientId: 'Kamala Devi' },
      { ...parts, fileId: 'lft-report.pdf' },
      { ...parts, documentId: '../../other' },
      { ...parts, hospitalId: parts.hospitalId.toUpperCase() },
    ]) {
      expect(() => documentFileKey(bad)).toThrow(/identifiers alone/);
    }

    expect(() => assertStorageKey('patients/9820011111/report.pdf')).toThrow();
    expect(() => assertStorageKey(`${documentFileKey(parts)}/extra`)).toThrow();
  });

  it('move to quarantine under their own prefix, once', () => {
    const key = documentFileKey(ids());
    const quarantined = quarantineKeyFor(key);

    expect(quarantined).toBe(`quarantine/${key}`);
    expect(() => assertStorageKey(quarantined)).not.toThrow();
    expect(() => quarantineKeyFor(quarantined)).toThrow(/already in quarantine/);
  });
});
