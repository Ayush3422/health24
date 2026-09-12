/**
 * The API client.
 *
 * Three decisions worth stating, because they are security choices rather
 * than conveniences:
 *
 * 1. The access token lives in memory only. It never touches storage, so it
 *    cannot be read back by script after a page load, and it dies with the tab.
 *
 * 2. The refresh token lives in `sessionStorage`, not `localStorage`. Hospital
 *    workstations are shared: a clinician finishes a shift, closes the browser,
 *    and the next person sits down. `localStorage` would hand them a live
 *    session. `sessionStorage` is scoped to the tab and cleared when it closes.
 *
 *    This is still readable by script, so it is a step rather than a
 *    destination — the eventual answer is an httpOnly, SameSite cookie issued
 *    by the API, which requires a change on the server side too.
 *
 * 3. A 401 triggers exactly one refresh attempt, and concurrent requests share
 *    it. Without that sharing, a screen issuing four queries on mount would
 *    fire four refreshes, three of which present an already-rotated token —
 *    which the server correctly treats as theft and responds to by revoking
 *    every session the user has.
 */

const REFRESH_TOKEN_KEY = 'health24.refresh';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body: unknown = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Field-level validation messages, when the server returned them. */
  get fieldErrors(): Array<{ field: string; message: string }> {
    const body = this.body as { errors?: Array<{ field: string; message: string }> } | null;
    return body?.errors ?? [];
  }
}

let accessToken: string | null = null;
let onUnauthenticated: (() => void) | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function setRefreshToken(token: string | null): void {
  try {
    if (token) {
      sessionStorage.setItem(REFRESH_TOKEN_KEY, token);
    } else {
      sessionStorage.removeItem(REFRESH_TOKEN_KEY);
    }
  } catch {
    // Private browsing, or storage disabled by policy. The session still works
    // for as long as the tab is open; it simply will not survive a reload.
  }
}

export function getRefreshToken(): string | null {
  try {
    return sessionStorage.getItem(REFRESH_TOKEN_KEY);
  } catch {
    return null;
  }
}

/** Called when the session is definitively gone, so the UI can react. */
export function setUnauthenticatedHandler(handler: (() => void) | null): void {
  onUnauthenticated = handler;
}

export function clearSession(): void {
  accessToken = null;
  setRefreshToken(null);
}

/** In-flight refresh, shared by every caller that needs one at the same time. */
let refreshInFlight: Promise<boolean> | null = null;

/** The profile returned by the most recent refresh, for session restore. */
let lastRefreshedStaff: unknown = null;

async function refreshSession(): Promise<boolean> {
  const token = getRefreshToken();

  if (!token) return false;

  const response = await fetch('/api/v1/auth/refresh', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken: token }),
  });

  if (!response.ok) {
    clearSession();
    return false;
  }

  const body = (await response.json()) as {
    accessToken: string;
    refreshToken: string;
    staff?: unknown;
  };

  accessToken = body.accessToken;
  setRefreshToken(body.refreshToken);
  lastRefreshedStaff = body.staff ?? null;
  return true;
}

/**
 * Restores a session after a page load.
 *
 * Deliberately routed through the same shared in-flight promise as a 401
 * retry. Refresh tokens rotate and are single-use, and the server treats a
 * replayed one as theft — correctly — by revoking every session the user has.
 *
 * So two simultaneous restores are not a harmless duplicate request: they read
 * the same stored token, the second presents one that has just been rotated,
 * and the user is signed out everywhere. That happens in development from
 * StrictMode's double-invoked effects, and in production the moment someone
 * opens two tabs at once. Sharing the promise means only one request is ever
 * made.
 */
export async function restoreSession(): Promise<unknown | null> {
  if (!getRefreshToken()) return null;

  const refreshed = await ensureRefresh();
  return refreshed ? lastRefreshedStaff : null;
}

function ensureRefresh(): Promise<boolean> {
  refreshInFlight ??= refreshSession().finally(() => {
    refreshInFlight = null;
  });

  return refreshInFlight;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Internal: prevents a refresh loop. */
  retrying?: boolean;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });

  if (response.status === 401 && !options.retrying && getRefreshToken()) {
    const refreshed = await ensureRefresh();

    if (refreshed) {
      return api<T>(path, { ...options, retrying: true });
    }

    onUnauthenticated?.();
    throw new ApiError(401, 'Your session has ended. Please sign in again.');
  }

  if (response.status === 401) {
    onUnauthenticated?.();
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const text = await response.text();
  let parsed: unknown = null;

  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }

  if (!response.ok) {
    const message =
      (parsed as { message?: string | string[] } | null)?.message ?? response.statusText;

    throw new ApiError(
      response.status,
      Array.isArray(message) ? message.join(', ') : String(message),
      parsed,
    );
  }

  return parsed as T;
}

/** Sign-in is deliberately outside `api`: there is no token to attach yet. */
export async function postPublic<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let parsed: unknown = null;

  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }

  if (!response.ok) {
    const message =
      (parsed as { message?: string | string[] } | null)?.message ?? response.statusText;

    throw new ApiError(
      response.status,
      Array.isArray(message) ? message.join(', ') : String(message),
      parsed,
    );
  }

  return parsed as T;
}
