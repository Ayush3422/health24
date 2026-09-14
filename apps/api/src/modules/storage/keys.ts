/**
 * Object storage keys.
 *
 * A key is built only from identifiers — never a patient's name, a file name,
 * or anything else a person typed. Storage access logs, bucket listings and
 * error messages all carry keys, and none of them is a place for personal
 * data.
 */

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

export const QUARANTINE_PREFIX = 'quarantine/';

const DOCUMENT_FILE_KEY = new RegExp(
  `^(?:${QUARANTINE_PREFIX})?hospitals/${UUID}/patients/${UUID}/documents/${UUID}/${UUID}$`,
);

export interface DocumentFileKeyParts {
  hospitalId: string;
  patientId: string;
  documentId: string;
  fileId: string;
}

export function documentFileKey(parts: DocumentFileKeyParts): string {
  const key = `hospitals/${parts.hospitalId}/patients/${parts.patientId}/documents/${parts.documentId}/${parts.fileId}`;
  assertStorageKey(key);
  return key;
}

/** Throws unless the key is one this application could have built. */
export function assertStorageKey(key: string): void {
  if (!DOCUMENT_FILE_KEY.test(key)) {
    throw new Error('Refusing a storage key that is not built from identifiers alone');
  }
}

export function quarantineKeyFor(key: string): string {
  assertStorageKey(key);

  if (key.startsWith(QUARANTINE_PREFIX)) {
    throw new Error('The object is already in quarantine');
  }

  return `${QUARANTINE_PREFIX}${key}`;
}
