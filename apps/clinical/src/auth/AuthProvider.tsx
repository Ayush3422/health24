import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { AuthenticatedStaff } from '@health24/shared';
import {
  api,
  clearSession,
  getRefreshToken,
  restoreSession,
  setAccessToken,
  setRefreshToken,
  setUnauthenticatedHandler,
} from '../api/client';

interface AuthState {
  staff: AuthenticatedStaff | null;
  status: 'restoring' | 'signed-out' | 'signed-in';
}

interface AuthContextValue extends AuthState {
  completeSignIn: (result: {
    accessToken: string;
    refreshToken: string;
    staff: AuthenticatedStaff;
  }) => void;
  signOut: () => Promise<void>;
  /** Seconds until an idle sign-out, or null when not near the limit. */
  idleWarningSeconds: number | null;
  stayActive: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * Idle timeout.
 *
 * Ward computers are shared and rarely signed out of. A logged-in session left
 * open on a corridor workstation is one of the most ordinary ways patient data
 * actually leaks — far more likely than anything an attacker does deliberately.
 *
 * Fifteen minutes with a one-minute warning: long enough not to interrupt a
 * consultation, short enough that an abandoned terminal does not stay open
 * through a shift change.
 */
const IDLE_LIMIT_MS = 15 * 60 * 1000;
const IDLE_WARNING_MS = 60 * 1000;

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [state, setState] = useState<AuthState>({ staff: null, status: 'restoring' });
  const [idleWarningSeconds, setIdleWarningSeconds] = useState<number | null>(null);
  const lastActivity = useRef(Date.now());

  const signOutLocally = useCallback(() => {
    clearSession();
    setState({ staff: null, status: 'signed-out' });
    setIdleWarningSeconds(null);
  }, []);

  const completeSignIn = useCallback(
    (result: { accessToken: string; refreshToken: string; staff: AuthenticatedStaff }) => {
      setAccessToken(result.accessToken);
      setRefreshToken(result.refreshToken);
      lastActivity.current = Date.now();
      setState({ staff: result.staff, status: 'signed-in' });
    },
    [],
  );

  const signOut = useCallback(async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
    } catch {
      // Already gone server-side; the local state still needs clearing.
    }

    signOutLocally();
  }, [signOutLocally]);

  // A 401 that survives a refresh attempt means the session is finished.
  useEffect(() => {
    setUnauthenticatedHandler(signOutLocally);
    return () => setUnauthenticatedHandler(null);
  }, [signOutLocally]);

  // Restore a session across a page reload, using the refresh token held in
  // sessionStorage. Without this, reloading the page would sign a clinician
  // out mid-consultation.
  //
  // Routed through `restoreSession` rather than fetching here, so that two
  // simultaneous restores share one request. Refresh tokens are single-use,
  // and presenting a rotated one is indistinguishable from theft — so a
  // duplicate restore would sign the user out of every session they have.
  useEffect(() => {
    let cancelled = false;

    const restore = async () => {
      if (!getRefreshToken()) {
        setState({ staff: null, status: 'signed-out' });
        return;
      }

      try {
        const staff = (await restoreSession()) as AuthenticatedStaff | null;

        if (cancelled) return;

        if (staff) {
          setState({ staff, status: 'signed-in' });
        } else {
          signOutLocally();
        }
      } catch {
        if (!cancelled) signOutLocally();
      }
    };

    void restore();

    return () => {
      cancelled = true;
    };
  }, [signOutLocally]);

  const stayActive = useCallback(() => {
    lastActivity.current = Date.now();
    setIdleWarningSeconds(null);
  }, []);

  // Idle tracking.
  useEffect(() => {
    if (state.status !== 'signed-in') return;

    const markActive = () => {
      lastActivity.current = Date.now();
    };

    const events: Array<keyof WindowEventMap> = ['mousedown', 'keydown', 'scroll', 'touchstart'];
    events.forEach((event) => window.addEventListener(event, markActive, { passive: true }));

    const timer = window.setInterval(() => {
      const idleFor = Date.now() - lastActivity.current;

      if (idleFor >= IDLE_LIMIT_MS) {
        void signOut();
        return;
      }

      if (idleFor >= IDLE_LIMIT_MS - IDLE_WARNING_MS) {
        setIdleWarningSeconds(Math.ceil((IDLE_LIMIT_MS - idleFor) / 1000));
      } else {
        setIdleWarningSeconds(null);
      }
    }, 1000);

    return () => {
      events.forEach((event) => window.removeEventListener(event, markActive));
      window.clearInterval(timer);
    };
  }, [state.status, signOut]);

  const value = useMemo<AuthContextValue>(
    () => ({ ...state, completeSignIn, signOut, idleWarningSeconds, stayActive }),
    [state, completeSignIn, signOut, idleWarningSeconds, stayActive],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);

  if (!context) {
    throw new Error('useAuth must be used inside AuthProvider');
  }

  return context;
}
