import { useTranslation } from 'react-i18next';
import type { AccessHistoryEntry, PortalEmergencyAccess } from '@health24/shared';
import { useAccessHistory, useNotifications } from '../api/activity';
import { formatDate, formatDateTime, formatTime } from '../format';

/** Entries in order, gathered under their day; a day split across pages is joined again. */
function byDay(entries: AccessHistoryEntry[]): Array<[string, AccessHistoryEntry[]]> {
  const days: Array<[string, AccessHistoryEntry[]]> = [];

  for (const entry of entries) {
    const last = days.at(-1);
    if (last && last[0] === entry.day) last[1].push(entry);
    else days.push([entry.day, [entry]]);
  }

  return days;
}

const verbFor = (actions: AccessHistoryEntry['actions']) =>
  actions.includes('export')
    ? 'export'
    : actions.some((action) => action === 'create' || action === 'update' || action === 'delete')
      ? 'change'
      : 'view';

/**
 * Who has seen the patient's record (sp5-plan.md, DF6): each person, their
 * role and hospital, what they looked at, and whether it rested on the
 * patient's consent or on emergency access. The patient's own reads are left out.
 */
export function AccessHistoryScreen(): JSX.Element {
  const { t } = useTranslation();
  const history = useAccessHistory();
  const notifications = useNotifications();

  const entries = history.data?.pages.flatMap((page) => page.entries) ?? [];
  const emergencies = notifications.data?.emergencyAccesses ?? [];

  return (
    <div className="stack">
      <header>
        <h1>{t('access.title')}</h1>
        <p className="muted">{t('access.intro')}</p>
      </header>

      {emergencies.length > 0 ? (
        <section aria-labelledby="emergency-accesses" className="stack">
          <h2 id="emergency-accesses">{t('access.emergencyTitle')}</h2>
          <ul className="timeline">
            {emergencies.map((access) => (
              <EmergencyAccessCard key={access.id} access={access} />
            ))}
          </ul>
        </section>
      ) : null}

      {history.isPending ? <p aria-busy="true">{t('app.loading')}</p> : null}
      {history.isError ? (
        <div className="panel">
          <p className="alert" role="alert">
            {t('app.error')}
          </p>
          <button type="button" onClick={() => void history.refetch()}>
            {t('app.retry')}
          </button>
        </div>
      ) : null}
      {history.isSuccess && entries.length === 0 ? (
        <p className="panel muted">{t('access.empty')}</p>
      ) : null}

      {byDay(entries).map(([day, list]) => (
        <section key={day} aria-labelledby={`day-${day}`} className="stack">
          <h2 id={`day-${day}`}>{formatDate(day)}</h2>
          <ul className="timeline">
            {list.map((entry) => (
              <AccessEntry key={entry.id} entry={entry} />
            ))}
          </ul>
        </section>
      ))}

      {history.hasNextPage ? (
        <button
          type="button"
          onClick={() => void history.fetchNextPage()}
          disabled={history.isFetchingNextPage}
        >
          {history.isFetchingNextPage ? t('app.loading') : t('access.older')}
        </button>
      ) : null}
    </div>
  );
}

function AccessEntry({ entry }: { entry: AccessHistoryEntry }): JSX.Element {
  const { t } = useTranslation();

  const emergencyConsent = entry.consents.find((consent) => consent.captureMethod === 'break_glass');
  const reason = entry.emergencyReason ?? emergencyConsent?.emergencyReason ?? null;
  const emergency = reason !== null || emergencyConsent !== undefined;
  const shared = entry.consents.filter((consent) => consent.captureMethod !== 'break_glass');

  const who =
    entry.actor.kind === 'staff'
      ? [entry.actor.name ?? t('access.staff'), entry.actor.role ? t(`role.${entry.actor.role}`) : null]
          .filter(Boolean)
          .join(' · ')
      : entry.actor.kind === 'patient'
        ? t('access.otherPhone', { phone: entry.actor.label ?? '' })
        : entry.resources.includes('emergency_card')
          ? t('access.cardOpened')
          : t('access.system');

  const what = [
    ...new Set(
      entry.resources.map((resource) =>
        t(`resource.${resource}`, { defaultValue: t('resource.other') }),
      ),
    ),
  ].join(', ');

  const from = formatTime(entry.firstAt);
  const to = formatTime(entry.lastAt);

  return (
    <li className={`panel${emergency ? ' panel--alert' : ''}`}>
      <p className="timeline__meta">
        {emergency ? <span className="badge badge--danger">{t('access.emergency')}</span> : null}
        <time dateTime={entry.lastAt}>{from === to ? from : `${from}–${to}`}</time>
      </p>
      <strong>{who}</strong>
      {entry.hospital ? <span className="item__meta">{entry.hospital.name}</span> : null}
      <span className="item__detail">{t(`access.did_${verbFor(entry.actions)}`, { what })}</span>
      {reason ? <span className="item__meta">{t('access.reason', { reason })}</span> : null}
      {shared.length > 0 ? (
        <span className="item__meta">
          {t(shared.some((consent) => consent.grantedByYou) ? 'access.yourConsent' : 'access.deskConsent', {
            date: formatDate(shared[0]!.grantedAt),
          })}
        </span>
      ) : !emergency && entry.actor.kind === 'staff' ? (
        <span className="item__meta">{t('access.ownRecords')}</span>
      ) : null}
    </li>
  );
}

function EmergencyAccessCard({ access }: { access: PortalEmergencyAccess }): JSX.Element {
  const { t } = useTranslation();

  return (
    <li className="panel panel--alert">
      <p className="timeline__meta">
        <span className="badge badge--danger">{t('access.emergency')}</span>
        <time dateTime={access.grantedAt}>{formatDateTime(access.grantedAt)}</time>
      </p>
      <strong>{access.hospital.name}</strong>
      <span className="item__detail">{t('access.reason', { reason: access.reason })}</span>
      {access.clinicianName ? (
        <span className="item__meta">{t('access.takenBy', { name: access.clinicianName })}</span>
      ) : null}
      <span className="item__meta">
        {access.active
          ? t('access.activeUntil', { date: formatDateTime(access.expiresAt) })
          : t('access.ended', { date: formatDateTime(access.expiresAt) })}
      </span>
      <span className="item__meta">
        {access.review ? t(`access.review_${access.review.outcome}`) : t('access.reviewPending')}
      </span>
      {access.notifiedAt ? (
        <span className="item__meta">
          {t('access.toldBySms', { date: formatDateTime(access.notifiedAt) })}
        </span>
      ) : null}
    </li>
  );
}
