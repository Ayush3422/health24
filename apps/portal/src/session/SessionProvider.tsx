import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { PortalMe, PortalSessionIssued } from '@health24/shared';
import {
  api,
  clearSession,
  hasStoredSession,
  refreshSession,
  setSession,
  setSignedOutHandler,
} from '../api/client';

type Status = 'restoring' | 'signed-out' | 'signed-in';

interface SessionContextValue {
  status: Status;
  me: PortalMe | null;
  /** Starts a session issued by sign-in. */
  begin: (issued: PortalSessionIssued) => Promise<void>;
  switchTo: (patientId: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

/**
 * The signed-in patient. On a page load, a stored refresh token restores the
 * session; switching patient or signing out clears everything cached, so one
 * family member's record never shows under another's name.
 */
export function SessionProvider({ children }: { children: ReactNode }): JSX.Element {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<Status>(() =>
    hasStoredSession() ? 'restoring' : 'signed-out',
  );
  const [me, setMe] = useState<PortalMe | null>(null);

  const end = useCallback(() => {
    clearSession();
    queryClient.clear();
    setMe(null);
    setStatus('signed-out');
  }, [queryClient]);

  useEffect(() => {
    setSignedOutHandler(end);
    return () => setSignedOutHandler(null);
  }, [end]);

  useEffect(() => {
    if (status !== 'restoring') return;

    let cancelled = false;

    void (async () => {
      try {
        const issued = await refreshSession();
        if (!issued) {
          if (!cancelled) end();
          return;
        }
        const profile = await api<PortalMe>('/portal/auth/me');
        if (!cancelled) {
          setMe(profile);
          setStatus('signed-in');
        }
      } catch {
        // Unreachable: keep the stored token and show sign-in for now.
        if (!cancelled) setStatus('signed-out');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [status, end]);

  const begin = useCallback(async (issued: PortalSessionIssued) => {
    setSession(issued);
    setMe(await api<PortalMe>('/portal/auth/me'));
    setStatus('signed-in');
  }, []);

  const switchTo = useCallback(
    async (patientId: string) => {
      const issued = await api<PortalSessionIssued>('/portal/auth/switch', {
        method: 'POST',
        body: { patientId },
      });
      queryClient.clear();
      await begin(issued);
    },
    [begin, queryClient],
  );

  const signOut = useCallback(async () => {
    try {
      await api('/portal/auth/logout', { method: 'POST' });
    } finally {
      end();
    }
  }, [end]);

  const value = useMemo(
    () => ({ status, me, begin, switchTo, signOut }),
    [status, me, begin, switchTo, signOut],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession outside SessionProvider');
  return value;
}
