import type { PortalSessionIssued } from '@health24/shared';

/**
 * The portal's API client.
 *
 * The access token lives in memory only. The refresh token lives in
 * `localStorage`: the portal runs on a patient's own phone, and signing them
 * out every time the browser is closed would push people back to the desk.
 * A family sharing a phone is expected (sp5-plan.md, Decision J1), a lost phone
 * is cut off from the desk or from another device, and every session is listed
 * in the portal.
 *
 * A 401 triggers one refresh, shared by every request waiting on it: the
 * server treats a refresh token presented twice as stolen and ends every
 * session of the phone.
 */

const REFRESH_TOKEN_KEY = 'health24.portal.refresh';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body: unknown = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let accessToken: string | null = null;
let refreshInFlight: Promise<PortalSessionIssued | null> | null = null;
let onSignedOut: (() => void) | null = null;

function readRefreshToken(): string | null {
  try {
    return localStorage.getItem(REFRESH_TOKEN_KEY);
  } catch {
    return null;
  }
}

function writeRefreshToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(REFRESH_TOKEN_KEY, token);
    else localStorage.removeItem(REFRESH_TOKEN_KEY);
  } catch {
    // Storage blocked: the session lasts as long as the page.
  }
}

export function setSession(issued: Pick<PortalSessionIssued, 'accessToken' | 'refreshToken'>): void {
  accessToken = issued.accessToken;
  writeRefreshToken(issued.refreshToken);
}

export function clearSession(): void {
  accessToken = null;
  writeRefreshToken(null);
}

export function hasStoredSession(): boolean {
  return readRefreshToken() !== null;
}

/** Called when the session has definitively ended, so the app shows sign-in. */
export function setSignedOutHandler(handler: (() => void) | null): void {
  onSignedOut = handler;
}

/** Exchanges the stored refresh token for a new pair; null when the session is over. */
export function refreshSession(): Promise<PortalSessionIssued | null> {
  refreshInFlight ??= (async () => {
    const token = readRefreshToken();
    if (!token) return null;

    const response = await fetch('/api/v1/portal/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: token }),
    });

    // An outage is not the end of the session: keep the token for later.
    if (response.status >= 500) {
      throw new ApiError(response.status, 'The service could not be reached');
    }

    if (!response.ok) {
      clearSession();
      return null;
    }

    const issued = (await response.json()) as PortalSessionIssued;
    setSession(issued);
    return issued;
  })().finally(() => {
    refreshInFlight = null;
  });

  return refreshInFlight;
}

async function send(path: string, method: string, body: unknown): Promise<Response> {
  return fetch(`/api/v1${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export async function api<T>(
  path: string,
  options: { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown } = {},
): Promise<T> {
  const method = options.method ?? 'GET';
  let response = await send(path, method, options.body);

  if (response.status === 401 && readRefreshToken() && !path.startsWith('/portal/auth/refresh')) {
    const refreshed = await refreshSession();

    if (refreshed) {
      response = await send(path, method, options.body);
    }
  }

  if (response.status === 401 && accessToken !== null) {
    clearSession();
    onSignedOut?.();
  }

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    const message =
      (payload as { message?: string | string[] } | null)?.message ?? response.statusText;

    throw new ApiError(
      response.status,
      Array.isArray(message) ? message.join('; ') : message || 'Request failed',
      payload,
    );
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
