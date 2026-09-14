import type { Sealed } from './cipher';

/**
 * IndexedDB, holding only ciphertext.
 *
 * Two stores: responses the clinician has seen, and the audit entries for
 * views made while offline. Every record carries the id of the session that
 * wrote it, so a session only ever touches its own — two tabs on one
 * workstation cannot read or clear each other's.
 */

const DB_NAME = 'health24-offline';
const VERSION = 1;

export const RESPONSES = 'responses';
export const VIEWS = 'views';

export interface ResponseRecord extends Sealed {
  /** `${session}:${path}` */
  id: string;
  session: string;
  cachedAt: number;
}

export interface ViewRecord extends Sealed {
  id?: number;
  session: string;
  queuedAt: number;
}

type StoreName = typeof RESPONSES | typeof VIEWS;

let opening: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore(RESPONSES, { keyPath: 'id' }).createIndex('session', 'session');
      db.createObjectStore(VIEWS, { keyPath: 'id', autoIncrement: true }).createIndex(
        'session',
        'session',
      );
    };

    request.onsuccess = () => {
      const db = request.result;
      // Another tab deleting the database must not be blocked by this one.
      db.onversionchange = () => {
        db.close();
        opening = null;
      };
      resolve(db);
    };

    request.onerror = () => {
      opening = null;
      reject(request.error);
    };
  });

  return opening;
}

function done(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function put(store: StoreName, record: ResponseRecord | ViewRecord): Promise<void> {
  const db = await openDb();
  const transaction = db.transaction(store, 'readwrite');
  transaction.objectStore(store).put(record);
  await done(transaction);
}

export async function getResponse(id: string): Promise<ResponseRecord | undefined> {
  const db = await openDb();
  return result<ResponseRecord | undefined>(
    db.transaction(RESPONSES).objectStore(RESPONSES).get(id),
  );
}

export async function viewsFor(session: string): Promise<ViewRecord[]> {
  const db = await openDb();
  return result<ViewRecord[]>(
    db.transaction(VIEWS).objectStore(VIEWS).index('session').getAll(session),
  );
}

/** Deletes a session's records from the given stores. */
export async function deleteSession(session: string, stores: StoreName[]): Promise<void> {
  const db = await openDb();
  const transaction = db.transaction(stores, 'readwrite');

  for (const name of stores) {
    const index = transaction.objectStore(name).index('session');
    const cursor = index.openCursor(IDBKeyRange.only(session));

    cursor.onsuccess = () => {
      const current = cursor.result;
      if (!current) return;
      current.delete();
      current.continue();
    };
  }

  await done(transaction);
}

/**
 * Deletes other sessions' records older than the cut-off: what a tab closed
 * without signing out left behind. Their keys are already gone, so this is
 * housekeeping rather than protection — the ciphertext was unreadable anyway.
 */
export async function purgeAbandoned(session: string, olderThan: number): Promise<void> {
  const db = await openDb();
  const transaction = db.transaction([RESPONSES, VIEWS], 'readwrite');

  for (const name of [RESPONSES, VIEWS] as const) {
    const cursor = transaction.objectStore(name).openCursor();

    cursor.onsuccess = () => {
      const current = cursor.result;
      if (!current) return;

      const record = current.value as ResponseRecord | ViewRecord;
      const writtenAt = 'cachedAt' in record ? record.cachedAt : record.queuedAt;

      if (record.session !== session && writtenAt < olderThan) current.delete();
      current.continue();
    };
  }

  await done(transaction);
}
