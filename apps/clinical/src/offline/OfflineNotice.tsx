import { formatTime } from '../clinical/format';
import { useConnectivity } from './connectivity';

/**
 * The persistent offline banner inside the app. Says the data may be out of
 * date and from when, and that nothing can be recorded — every write control
 * is disabled beneath it, so nobody believes an entry was saved.
 */
export function OfflineBanner(): JSX.Element | null {
  const { offline, oldestCachedAt } = useConnectivity();

  if (!offline) return null;

  return (
    <div className="offline-banner" role="status">
      <strong>You are offline.</strong>{' '}
      {oldestCachedAt
        ? `Showing records saved at ${formatTime(new Date(oldestCachedAt).toISOString())}; they may be out of date.`
        : 'Records you opened earlier in this session can still be viewed; they may be out of date.'}{' '}
      Nothing can be recorded until the connection returns.
    </div>
  );
}

/** On the sign-in screen, when the connection is down. */
export function OfflineSignInNotice(): JSX.Element | null {
  const { offline } = useConnectivity();

  if (!offline) return null;

  return (
    <div className="offline-banner" role="status">
      <strong>You are offline.</strong> Signing in needs the connection; this page will continue by
      itself when it returns. Records viewed before the page was reloaded cannot be opened again:
      they were encrypted with a key that existed only in that page.
    </div>
  );
}
