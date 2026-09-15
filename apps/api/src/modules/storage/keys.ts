/**
 * Object storage keys.
 *
 * A key is built only from identifiers — never a patient's name, a file name,
 * or anything else a person typed. Storage access logs, bucket listings and
 * error messages all carry keys, and none of them is a place for personal
 * data.
 *
 * Three kinds of object live under a patient's record:
 *
 *   documents/{document}/{file}   a file of a document, served once scanned clean
 *   imports/{batch}/files/{file}  a legacy folder's file as uploaded, kept as the original
 *   imports/{batch}/pages/{page}  one page cut from an import file that scanned clean
 */

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

export const QUARANTINE_PREFIX = 'quarantine/';

const RECORD = `hospitals/(${UUID})/patients/(${UUID})`;

const DOCUMENT_FILE_KEY = new RegExp(`^(?:${QUARANTINE_PREFIX})?${RECORD}/documents/(${UUID})/(${UUID})$`);
const IMPORT_FILE_KEY = new RegExp(`^(?:${QUARANTINE_PREFIX})?${RECORD}/imports/(${UUID})/files/(${UUID})$`);
// A page is cut from a file already scanned clean, so it is never quarantined.
const IMPORT_PAGE_KEY = new RegExp(`^${RECORD}/imports/(${UUID})/pages/(${UUID})$`);

export type StorageKeyKind = 'document_file' | 'import_file' | 'import_page';

export interface DocumentFileKeyParts {
  hospitalId: string;
  patientId: string;
  documentId: string;
  fileId: string;
}

export interface ImportFileKeyParts {
  hospitalId: string;
  patientId: string;
  batchId: string;
  fileId: string;
}

export interface ImportPageKeyParts {
  hospitalId: string;
  patientId: string;
  batchId: string;
  pageId: string;
}

export function documentFileKey(parts: DocumentFileKeyParts): string {
  const key = `hospitals/${parts.hospitalId}/patients/${parts.patientId}/documents/${parts.documentId}/${parts.fileId}`;
  assertStorageKey(key);
  return key;
}

export function importFileKey(parts: ImportFileKeyParts): string {
  const key = `hospitals/${parts.hospitalId}/patients/${parts.patientId}/imports/${parts.batchId}/files/${parts.fileId}`;
  assertStorageKey(key);
  return key;
}

export function importPageKey(parts: ImportPageKeyParts): string {
  const key = `hospitals/${parts.hospitalId}/patients/${parts.patientId}/imports/${parts.batchId}/pages/${parts.pageId}`;
  assertStorageKey(key);
  return key;
}

/** Which kind of object a key names, or null for a key this application could not have built. */
export function storageKeyKind(key: string): StorageKeyKind | null {
  if (DOCUMENT_FILE_KEY.test(key)) return 'document_file';
  if (IMPORT_FILE_KEY.test(key)) return 'import_file';
  if (IMPORT_PAGE_KEY.test(key)) return 'import_page';
  return null;
}

/** Throws unless the key is one this application could have built. */
export function assertStorageKey(key: string): void {
  if (!storageKeyKind(key)) {
    throw new Error('Refusing a storage key that is not built from identifiers alone');
  }
}

/** The identifiers a document file's key was built from, whether or not it has moved to quarantine. */
export function parseDocumentFileKey(key: string): DocumentFileKeyParts {
  const match = DOCUMENT_FILE_KEY.exec(key);
  if (!match) throw new Error('Not a document file key');

  return { hospitalId: match[1]!, patientId: match[2]!, documentId: match[3]!, fileId: match[4]! };
}

/** The identifiers an import file's key was built from, whether or not it has moved to quarantine. */
export function parseImportFileKey(key: string): ImportFileKeyParts {
  const match = IMPORT_FILE_KEY.exec(key);
  if (!match) throw new Error('Not an import file key');

  return { hospitalId: match[1]!, patientId: match[2]!, batchId: match[3]!, fileId: match[4]! };
}

export function quarantineKeyFor(key: string): string {
  const kind = storageKeyKind(key);

  if (kind !== 'document_file' && kind !== 'import_file') {
    throw new Error('Only an uploaded file is ever quarantined');
  }
  if (key.startsWith(QUARANTINE_PREFIX)) {
    throw new Error('The object is already in quarantine');
  }

  return `${QUARANTINE_PREFIX}${key}`;
}
