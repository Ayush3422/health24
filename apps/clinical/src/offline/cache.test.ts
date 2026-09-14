import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OFFLINE_CACHE_MAX_AGE_MS } from '@health24/shared';

/**
 * The offline cache's lifecycle, against a real IndexedDB implementation.
 *
 * Each test is a fresh browser tab (its own sessionStorage); a page reload is
 * a fresh copy of the module in the same tab, with the same storage.
 */

type CacheModule = typeof import('./cache');

const PATIENT = '01a09ac1-27c2-714e-a229-da3da9307ac4';
const ALLERGIES = `/patients/${PATIENT}/allergies`;
const SUMMARY = `/patients/${PATIENT}/summary`;
const TAB_SESSION_KEY = 'health24.offline-session';

const decoder = new TextDecoder();

/** What a page load gives the tab: the module with no key, no session. */
async function loadPage(): Promise<CacheModule> {
  vi.resetModules();
  return import('./cache');
}

type RawRecord = { session: string; data: ArrayBuffer; iv: Uint8Array; cachedAt?: number };

async function rawRecords(store: 'responses' | 'views'): Promise<RawRecord[]> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('health24-offline');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  try {
    return await new Promise<RawRecord[]>((resolve, reject) => {
      const request = db.transaction(store).objectStore(store).getAll();
      request.onsuccess = () => resolve(request.result as RawRecord[]);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

const tabSession = () => sessionStorage.getItem(TAB_SESSION_KEY);

async function tabRecords(store: 'responses' | 'views'): Promise<RawRecord[]> {
  const session = tabSession();
  return (await rawRecords(store)).filter((record) => record.session === session);
}

describe('offline cache lifecycle', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('holds nothing before a session starts', async () => {
    const cache = await loadPage();

    await cache.remember(ALLERGIES, { allergies: [] });

    expect(await cache.recall(ALLERGIES)).toBeNull();
    expect(tabSession()).toBeNull();
  });

  it('serves back what was cached, and stores only ciphertext', async () => {
    const cache = await loadPage();
    await cache.startOfflineSession();

    const body = { allergies: [{ substance: 'Penicillin', criticality: 'high' }] };
    await cache.remember(ALLERGIES, body);

    const recalled = await cache.recall<typeof body>(ALLERGIES);
    expect(recalled?.body).toEqual(body);
    expect(recalled?.cachedAt).toBeTypeOf('number');

    const [stored] = await tabRecords('responses');
    expect(stored?.data).toBeInstanceOf(ArrayBuffer);
    expect(decoder.decode(stored!.data)).not.toContain('Penicillin');
    expect(JSON.stringify(stored)).not.toContain('Penicillin');
  });

  it('holds only what the offline cache is allowed to hold', async () => {
    const cache = await loadPage();
    await cache.startOfflineSession();

    await cache.remember(`/patients/${PATIENT}/timeline`, { items: [] });
    await cache.remember(`/patients/${PATIENT}/consents`, []);
    await cache.remember('/staff', []);

    expect(await cache.recall(`/patients/${PATIENT}/timeline`)).toBeNull();
    expect(await tabRecords('responses')).toHaveLength(0);
  });

  it('does not serve an entry older than the cache keeps', async () => {
    const cache = await loadPage();
    await cache.startOfflineSession();
    await cache.remember(SUMMARY, { problems: [] });

    const later = Date.now() + OFFLINE_CACHE_MAX_AGE_MS + 1_000;
    vi.spyOn(Date, 'now').mockReturnValue(later);

    expect(await cache.recall(SUMMARY)).toBeNull();
  });

  it('queues offline views for upload, and clears them once uploaded', async () => {
    const cache = await loadPage();
    await cache.startOfflineSession();

    await cache.queueView(ALLERGIES);
    await cache.queueView(SUMMARY);

    const views = await cache.queuedViews();
    expect(views.map((view) => view.path).sort()).toEqual([ALLERGIES, SUMMARY].sort());
    expect(views.every((view) => !Number.isNaN(Date.parse(view.viewedAt)))).toBe(true);

    await cache.clearQueuedViews();
    expect(await cache.queuedViews()).toEqual([]);
    expect(await tabRecords('views')).toHaveLength(0);
  });

  it('forgets cached responses on reconnection, but not views still to upload', async () => {
    const cache = await loadPage();
    await cache.startOfflineSession();
    await cache.remember(ALLERGIES, { allergies: [] });
    await cache.queueView(ALLERGIES);

    await cache.forgetResponses();

    expect(await cache.recall(ALLERGIES)).toBeNull();
    expect(await cache.queuedViews()).toHaveLength(1);
  });

  it('discards the key and the ciphertext at sign-out', async () => {
    const cache = await loadPage();
    await cache.startOfflineSession();
    await cache.remember(ALLERGIES, { allergies: [] });
    await cache.queueView(ALLERGIES);

    await cache.endOfflineSession();

    expect(await cache.recall(ALLERGIES)).toBeNull();
    expect(await tabRecords('responses')).toHaveLength(0);
    expect(await tabRecords('views')).toHaveLength(0);
  });

  it('cannot read what the tab stored before a reload, and deletes it', async () => {
    const before = await loadPage();
    await before.startOfflineSession();
    await before.remember(ALLERGIES, { allergies: [{ substance: 'Penicillin' }] });
    expect(await tabRecords('responses')).toHaveLength(1);

    const after = await loadPage();
    // The key died with the page; the ciphertext is still on disk until the
    // new page starts its session.
    expect(await after.recall(ALLERGIES)).toBeNull();
    expect(await tabRecords('responses')).toHaveLength(1);

    await after.startOfflineSession();
    expect(await tabRecords('responses')).toHaveLength(0);
    expect(await after.recall(ALLERGIES)).toBeNull();

    // The same tab keeps one record id, so the cache fills again in place.
    await after.remember(ALLERGIES, { allergies: [] });
    expect(await after.recall(ALLERGIES)).not.toBeNull();
    expect(await tabRecords('responses')).toHaveLength(1);
  });

  it('removes what abandoned tabs left once it is older than the cache keeps', async () => {
    const store = await import('./store');
    const sealed = { iv: new Uint8Array(12), data: new ArrayBuffer(8) };
    const now = Date.now();

    await store.put(store.RESPONSES, {
      id: `abandoned-old:${ALLERGIES}`,
      session: 'abandoned-old',
      cachedAt: now - OFFLINE_CACHE_MAX_AGE_MS - 60_000,
      ...sealed,
    });
    await store.put(store.RESPONSES, {
      id: `another-tab:${ALLERGIES}`,
      session: 'another-tab',
      cachedAt: now,
      ...sealed,
    });

    const cache = await loadPage();
    await cache.startOfflineSession();

    const sessions = (await rawRecords('responses')).map((record) => record.session);
    expect(sessions).not.toContain('abandoned-old');
    // A tab still in use is left alone.
    expect(sessions).toContain('another-tab');
  });
});
