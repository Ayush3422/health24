import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { PortalSessionSummary } from '@health24/shared';
import { api } from '../api/client';
import { describeDevice, formatDateTime } from '../format';

/** Every device signed in on this phone number, and a way to sign any of them out. */
export function DevicesScreen(): JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const sessions = useQuery({
    queryKey: ['portal', 'sessions'],
    queryFn: () => api<PortalSessionSummary[]>('/portal/auth/sessions'),
  });

  const end = useMutation({
    mutationFn: (id: string) => api(`/portal/auth/sessions/${id}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['portal', 'sessions'] }),
  });

  const rows = sessions.data ?? [];
  const others = rows.filter((session) => !session.current);

  return (
    <section className="panel" aria-labelledby="devices-title">
      <h1 id="devices-title">{t('devices.title')}</h1>
      <p>{t('devices.intro')}</p>

      {sessions.isPending ? <p aria-busy="true">{t('app.loading')}</p> : null}
      {sessions.isError || end.isError ? (
        <p className="alert" role="alert">
          {t('app.error')}
        </p>
      ) : null}

      <ul className="items">
        {rows.map((session) => (
          <li key={session.id}>
            <strong>{describeDevice(session.userAgent) ?? t('devices.unknownDevice')}</strong>
            {session.current ? <span className="badge">{t('devices.thisDevice')}</span> : null}
            <span className="item__meta">
              {session.patientName ? `${session.patientName} · ` : ''}
              {t('devices.lastUsed', { date: formatDateTime(session.lastUsedAt) })}
            </span>
            {!session.current ? (
              <button
                type="button"
                className="secondary"
                onClick={() => end.mutate(session.id)}
                disabled={end.isPending}
              >
                {t('devices.signOutDevice')}
              </button>
            ) : null}
          </li>
        ))}
      </ul>

      {sessions.isSuccess && others.length === 0 ? <p className="muted">{t('devices.none')}</p> : null}
    </section>
  );
}
