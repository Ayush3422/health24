import { OFFLINE_CACHE_MAX_AGE_MS, describeOfflineRead } from '@health24/shared';
import { createSessionKey, seal, unseal } from './cipher';
import {
  RESPONSES,
  VIEWS,
  deleteSession,
  getResponse,
  purgeAbandoned,
  put,
  viewsFor,
} from './store';

/**
 * The read-only offline cache (sp3-plan.md, decision S1).
 *
 * Lives exactly as long as the signed-in session in this tab. What it holds is
 * decided by `describeOfflineRead` in the shared package: today's worklist and
 * the essentials of patients the clinician actually opened — never data they
 * did not look at, so nothing is read on their behalf.
 *
 * A cache failure never breaks the request it rides on: every storage
 * operation here swallows its own errors, and the page behaves as if there
 * were no cache.
 */

interface Session {
  id: string;
  key: CryptoKey;
}

let session: Session | null = null;
let starting: Promise<void> | null = null;

export interface OfflineView {
  path: string;
  viewedAt: string;
}

async function quietly<T>(operation: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await operation();
  } catch {
    return fallback;
  }
}

const TAB_SESSION_KEY = 'health24.offline-session';

/**
 * The cache's record id for this tab, kept across reloads so each page load
 * replaces what the last one left rather than piling up beside it. Only an
 * identifier: the key it pairs with is never stored anywhere.
 */
function tabSessionId(): string {
  try {
    const existing = sessionStorage.getItem(TAB_SESSION_KEY);
    if (existing) return existing;

    const created = crypto.randomUUID();
    sessionStorage.setItem(TAB_SESSION_KEY, created);
    return created;
  } catch {
    return crypto.randomUUID();
  }
}

const supported = () =>
  typeof indexedDB !== 'undefined' && typeof crypto !== 'undefined' && Boolean(crypto.subtle);

/** On sign-in or session restore. */
export function startOfflineSession(): Promise<void> {
  if (!supported()) return Promise.resolve();

  starting ??= (async () => {
    const next = { id: tabSessionId(), key: await createSessionKey() };

    // Whatever this tab stored before a reload was sealed under a key that no
    // longer exists: delete it before writing anything new.
    await quietly(() => deleteSession(next.id, [RESPONSES, VIEWS]), undefined);
    await quietly(() => purgeAbandoned(next.id, Date.now() - OFFLINE_CACHE_MAX_AGE_MS), undefined);

    session = next;
  })();

  return starting;
}

/** On sign-out, idle timeout or a session the server ended: the key goes, then the ciphertext. */
export async function endOfflineSession(): Promise<void> {
  const ending = session;
  session = null;
  starting = null;

  if (ending) await quietly(() => deleteSession(ending.id, [RESPONSES, VIEWS]), undefined);
}

export async function remember(path: string, body: unknown): Promise<void> {
  const current = session;
  if (!current || !describeOfflineRead(path)) return;

  await quietly(async () => {
    const sealed = await seal(current.key, body);
    await put(RESPONSES, {
      id: `${current.id}:${path}`,
      session: current.id,
      cachedAt: Date.now(),
      ...sealed,
    });
  }, undefined);
}

export function recall<T>(path: string): Promise<{ body: T; cachedAt: number } | null> {
  const current = session;
  if (!current || !describeOfflineRead(path)) return Promise.resolve(null);

  return quietly(async () => {
    const record = await getResponse(`${current.id}:${path}`);
    if (!record || Date.now() - record.cachedAt > OFFLINE_CACHE_MAX_AGE_MS) return null;

    return { body: await unseal<T>(current.key, record), cachedAt: record.cachedAt };
  }, null);
}

/** Records that a cached response was shown, for upload on reconnection. */
export async function queueView(path: string): Promise<void> {
  const current = session;
  if (!current) return;

  const view: OfflineView = { path, viewedAt: new Date().toISOString() };

  await quietly(async () => {
    const sealed = await seal(current.key, view);
    await put(VIEWS, { session: current.id, queuedAt: Date.now(), ...sealed });
  }, undefined);
}

export function queuedViews(): Promise<OfflineView[]> {
  const current = session;
  if (!current) return Promise.resolve([]);

  return quietly(async () => {
    const records = await viewsFor(current.id);
    const views: OfflineView[] = [];

    for (const record of records) {
      views.push(await unseal<OfflineView>(current.key, record));
    }

    return views;
  }, []);
}

export async function clearQueuedViews(): Promise<void> {
  const current = session;
  if (current) await quietly(() => deleteSession(current.id, [VIEWS]), undefined);
}

/**
 * Drops every cached response. Done on reconnection: a consent revoked while
 * offline must not leave its data behind, and the screens refetch what they
 * show — so the cache refills with what the server permits now.
 */
export async function forgetResponses(): Promise<void> {
  const current = session;
  if (current) await quietly(() => deleteSession(current.id, [RESPONSES]), undefined);
}
