import { useSyncExternalStore } from 'react';

/**
 * Whether the API can be reached.
 *
 * Decided by what requests actually do, not by `navigator.onLine`: a ward
 * workstation can be "online" to the hospital network while the internet link
 * is down, and then only a failed request tells the truth. Once unreachable,
 * the health endpoint is probed until it answers.
 */

export interface Connectivity {
  offline: boolean;
  /** When the connection was lost. */
  since: number | null;
  /** When the oldest cached response shown since then was saved. */
  oldestCachedAt: number | null;
}

const PROBE_INTERVAL_MS = 10_000;

let state: Connectivity = { offline: false, since: null, oldestCachedAt: null };
let probeTimer: number | null = null;

const listeners = new Set<() => void>();
const reconnectHandlers = new Set<() => void>();

function update(next: Connectivity): void {
  state = next;
  listeners.forEach((listener) => listener());
}

export const isOffline = (): boolean => state.offline;

/**
 * A reverse proxy answers 502, 503 or 504 when the API behind it is down —
 * as the development server's proxy is configured to — so those mean the
 * same as a request that never left the machine.
 */
export const isUnreachableStatus = (status: number): boolean =>
  status === 502 || status === 503 || status === 504;

export function markUnreachable(): void {
  if (state.offline) return;

  update({ offline: true, since: Date.now(), oldestCachedAt: null });
  probeTimer ??= window.setInterval(() => void probe(), PROBE_INTERVAL_MS);
}

export function markReachable(): void {
  if (!state.offline) return;

  if (probeTimer !== null) {
    window.clearInterval(probeTimer);
    probeTimer = null;
  }

  update({ offline: false, since: null, oldestCachedAt: null });
  reconnectHandlers.forEach((handler) => handler());
}

export function noteServedFromCache(cachedAt: number): void {
  if (!state.offline) return;

  if (state.oldestCachedAt === null || cachedAt < state.oldestCachedAt) {
    update({ ...state, oldestCachedAt: cachedAt });
  }
}

/** Runs when the connection returns. Returns the unsubscribe. */
export function onReconnect(handler: () => void): () => void {
  reconnectHandlers.add(handler);
  return () => reconnectHandlers.delete(handler);
}

async function probe(): Promise<void> {
  try {
    const response = await fetch('/health', { cache: 'no-store' });
    if (response.ok) markReachable();
  } catch {
    // Still unreachable.
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('offline', markUnreachable);
  window.addEventListener('online', () => void probe());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useConnectivity(): Connectivity {
  return useSyncExternalStore(subscribe, () => state);
}
