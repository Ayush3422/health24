import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ExportFormat } from '@health24/shared';
import { ApiError } from '../api/client';
import { exportDownload, useExports, useRequestExport } from '../api/exports';
import { CorrectionRequests } from '../components/CorrectionRequests';
import { ErasureRequest } from '../components/ErasureRequest';
import { formatDateTime } from '../format';

/**
 * The patient's rights over their data (sp5-plan.md, Decision N1). This phase
 * brings the copy of the record; corrections and erasure follow.
 */
export function MyDataScreen(): JSX.Element {
  const { t } = useTranslation();
  const exports = useExports();
  const request = useRequestExport();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rows = exports.data ?? [];
  const preparing = rows.some((row) => row.status === 'pending');

  const download = async (exportId: string, format: ExportFormat) => {
    setError(null);
    setBusy(`${exportId}:${format}`);

    try {
      const { url } = await exportDownload(exportId, format);
      // A download leaves this page where it is.
      window.location.assign(url);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('app.error'));
    } finally {
      setBusy(null);
    }
  };

  const ask = async () => {
    setError(null);
    try {
      await request.mutateAsync();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('app.error'));
    }
  };

  return (
    <div className="stack">
      <header>
        <h1>{t('myData.title')}</h1>
        <p className="muted">{t('myData.intro')}</p>
      </header>

      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}

      <section className="panel stack" aria-labelledby="export-title">
        <h2 id="export-title">{t('myData.exportTitle')}</h2>
        <p>{t('myData.exportIntro')}</p>
        <button type="button" className="primary" onClick={() => void ask()} disabled={request.isPending || preparing}>
          {request.isPending ? t('myData.asking') : t('myData.ask')}
        </button>
        {preparing ? <p className="notice">{t('myData.preparing')}</p> : null}
      </section>

      {exports.isPending ? <p aria-busy="true">{t('app.loading')}</p> : null}
      {exports.isError ? (
        <div className="panel">
          <p className="alert" role="alert">
            {t('app.error')}
          </p>
          <button type="button" onClick={() => void exports.refetch()}>
            {t('app.retry')}
          </button>
        </div>
      ) : null}

      {rows.length > 0 ? (
        <section aria-labelledby="copies-title" className="stack">
          <h2 id="copies-title">{t('myData.copies')}</h2>
          <ul className="timeline">
            {rows.map((row) => (
              <li key={row.id} className="panel">
                <p className="timeline__meta">
                  <span className="badge">{t(`myData.status_${row.status}`)}</span>
                  <time dateTime={row.requestedAt}>{formatDateTime(row.requestedAt)}</time>
                </p>
                {row.status === 'ready' ? (
                  <>
                    <span className="item__detail">
                      {t('myData.entries', { count: row.entryCount ?? 0 })}
                    </span>
                    {row.expiresAt ? (
                      <span className="item__meta">
                        {t('myData.until', { date: formatDateTime(row.expiresAt) })}
                      </span>
                    ) : null}
                    <div className="row">
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => void download(row.id, 'pdf')}
                      >
                        {busy === `${row.id}:pdf` ? t('myData.opening') : t('myData.downloadPdf')}
                      </button>
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => void download(row.id, 'fhir')}
                      >
                        {busy === `${row.id}:fhir` ? t('myData.opening') : t('myData.downloadFhir')}
                      </button>
                    </div>
                  </>
                ) : null}
                {row.status === 'pending' ? (
                  <span className="item__detail">{t('myData.preparing')}</span>
                ) : null}
                {row.status === 'failed' ? (
                  <span className="item__detail">{t('myData.failed')}</span>
                ) : null}
                {row.status === 'expired' ? (
                  <span className="item__detail">{t('myData.expired')}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <p className="hint">{t('myData.note')}</p>

      <CorrectionRequests />
      <ErasureRequest />
    </div>
  );
}
