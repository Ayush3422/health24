import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../api/client';
import { useErasureRequests, useRequestErasure } from '../api/erasure';
import { formatDate } from '../format';

/**
 * Asking for erasure under the DPDP Act (sp5-plan.md, Decision N1). The screen
 * says plainly what erasure can and cannot reach before the patient asks.
 */
export function ErasureRequest(): JSX.Element {
  const { t } = useTranslation();
  const requests = useErasureRequests();
  const ask = useRequestErasure();
  const id = useId();

  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const rows = requests.data ?? [];
  const pending = rows.some((row) => row.status === 'pending');

  const submit = async () => {
    setError(null);
    try {
      await ask.mutateAsync(reason.trim() ? { reason: reason.trim() } : {});
      setAsking(false);
      setReason('');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('app.error'));
    }
  };

  return (
    <section className="panel stack" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>{t('erasure.title')}</h2>
      <p>{t('erasure.intro')}</p>
      <p className="hint">{t('erasure.kept')}</p>

      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}

      {requests.isPending ? <p aria-busy="true">{t('app.loading')}</p> : null}

      {rows.length > 0 ? (
        <ul className="items">
          {rows.map((row) => (
            <li key={row.id}>
              <strong>{t(`erasure.status_${row.status}`)}</strong>
              <span className="item__meta">{t('erasure.asked', { date: formatDate(row.createdAt) })}</span>
              {row.outcome ? (
                <span className="item__detail">{t(`erasure.outcome_${row.outcome}`)}</span>
              ) : null}
              {row.retentionNote ? (
                <span className="item__meta">{t('erasure.keptNote', { note: row.retentionNote })}</span>
              ) : null}
              {row.erasedSummary ? (
                <span className="item__meta">{t('erasure.erasedNote', { note: row.erasedSummary })}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {!pending ? (
        asking ? (
          <div className="stack">
            <div className="field">
              <label htmlFor={`${id}-reason`}>{t('erasure.reason')}</label>
              <textarea
                id={`${id}-reason`}
                rows={3}
                maxLength={1000}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </div>
            <div className="row">
              <button type="button" onClick={() => setAsking(false)}>
                {t('erasure.cancel')}
              </button>
              <button type="button" className="danger" disabled={ask.isPending} onClick={() => void submit()}>
                {ask.isPending ? t('erasure.asking') : t('erasure.confirm')}
              </button>
            </div>
          </div>
        ) : (
          <button type="button" onClick={() => setAsking(true)}>
            {t('erasure.ask')}
          </button>
        )
      ) : (
        <p className="notice">{t('erasure.waiting')}</p>
      )}
    </section>
  );
}
