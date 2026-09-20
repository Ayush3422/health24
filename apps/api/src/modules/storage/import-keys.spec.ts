import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  assertStorageKey,
  exportFileKey,
  documentFileKey,
  importFileKey,
  importPageKey,
  parseDocumentFileKey,
  parseImportFileKey,
  quarantineKeyFor,
  storageKeyKind,
} from './keys';

const batch = () => ({
  hospitalId: randomUUID(),
  patientId: randomUUID(),
  batchId: randomUUID(),
});

describe('import storage keys', () => {
  it('name a folder file and a page under the batch, from identifiers alone', () => {
    const parts = batch();
    const fileId = randomUUID();
    const pageId = randomUUID();

    expect(importFileKey({ ...parts, fileId })).toBe(
      `hospitals/${parts.hospitalId}/patients/${parts.patientId}/imports/${parts.batchId}/files/${fileId}`,
    );
    expect(importPageKey({ ...parts, pageId })).toBe(
      `hospitals/${parts.hospitalId}/patients/${parts.patientId}/imports/${parts.batchId}/pages/${pageId}`,
    );
    expect(() => importFileKey({ ...parts, fileId: 'folder-scan.pdf' })).toThrow(/identifiers alone/);
  });

  it('tell each kind apart, and parse only their own kind', () => {
    const parts = batch();
    const fileKey = importFileKey({ ...parts, fileId: randomUUID() });
    const pageKey = importPageKey({ ...parts, pageId: randomUUID() });
    const documentKey = documentFileKey({
      hospitalId: parts.hospitalId,
      patientId: parts.patientId,
      documentId: randomUUID(),
      fileId: randomUUID(),
    });

    expect(storageKeyKind(fileKey)).toBe('import_file');
    expect(storageKeyKind(pageKey)).toBe('import_page');
    expect(storageKeyKind(documentKey)).toBe('document_file');
    expect(storageKeyKind('hospitals/x/imports/y')).toBeNull();

    expect(parseImportFileKey(quarantineKeyFor(fileKey)).batchId).toBe(parts.batchId);
    expect(() => parseImportFileKey(documentKey)).toThrow();
    expect(() => parseDocumentFileKey(fileKey)).toThrow();
  });

  it('quarantine an uploaded folder file, but never a page cut from a clean one', () => {
    const parts = batch();
    const fileKey = importFileKey({ ...parts, fileId: randomUUID() });
    const pageKey = importPageKey({ ...parts, pageId: randomUUID() });

    expect(() => assertStorageKey(quarantineKeyFor(fileKey))).not.toThrow();
    expect(() => quarantineKeyFor(pageKey)).toThrow(/Only an uploaded file/);
    expect(() => assertStorageKey(`quarantine/${pageKey}`)).toThrow();
  });
});

describe("an export’s key", () => {
  const parts = () => ({ patientId: randomUUID(), exportId: randomUUID() });

  it('belongs to the patient, not to a hospital, and names only identifiers', () => {
    const { patientId, exportId } = parts();

    expect(exportFileKey({ patientId, exportId, format: 'pdf' })).toBe(
      `patients/${patientId}/exports/${exportId}/record.pdf`,
    );
    expect(storageKeyKind(exportFileKey({ patientId, exportId, format: 'pdf' }))).toBe('export_file');
    expect(storageKeyKind(exportFileKey({ patientId, exportId, format: 'fhir' }))).toBe('export_file');
  });

  it('is never quarantined: nothing is uploaded to it', () => {
    expect(() => quarantineKeyFor(exportFileKey({ ...parts(), format: 'pdf' }))).toThrow(
      /uploaded file/,
    );
  });

  it('refuses a key that is not built from identifiers alone', () => {
    const { patientId, exportId } = parts();

    expect(() => assertStorageKey(`patients/${patientId}/exports/${exportId}/lakshmi.pdf`)).toThrow();
    expect(() => assertStorageKey(`patients/whoever/exports/${exportId}/record.pdf`)).toThrow();
  });
});
