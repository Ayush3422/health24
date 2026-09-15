import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../api/client';
import { fileUrl, useDocuments } from '../api/records';
import { formatBytes, formatDate } from '../format';

/**
 * The patient's reports and bills from every hospital, to view or download.
 * Each link is issued on demand and lasts about a minute (sp5-plan.md, DF7).
 */
export function ReportsScreen(): JSX.Element {
  const { t } = useTranslation();
  const documents = useDocuments();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rows = documents.data?.pages.flatMap((page) => page.results) ?? [];
  const total = documents.data?.pages[0]?.total ?? 0;

  const open = async (documentId: string, fileId: string, disposition: 'inline' | 'attachment') => {
    setError(null);
    setBusy(`${fileId}:${disposition}`);

    // A tab opened before the request: browsers block one opened after it.
    const tab = disposition === 'inline' ? window.open('', '_blank') : null;

    try {
      const { url } = await fileUrl(documentId, fileId, disposition);

      if (tab) {
        tab.opener = null;
        tab.location.href = url;
      } else {
        // A download leaves this page where it is.
        window.location.assign(url);
      }
    } catch (caught) {
      tab?.close();
      setError(caught instanceof ApiError ? caught.message : t('app.error'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="stack">
      <header>
        <h1>{t('reports.title')}</h1>
        <p className="muted">{t('reports.intro')}</p>
      </header>

      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}
      {documents.isPending ? <p aria-busy="true">{t('app.loading')}</p> : null}
      {documents.isError ? (
        <div className="panel">
          <p className="alert" role="alert">
            {t('app.error')}
          </p>
          <button type="button" onClick={() => void documents.refetch()}>
            {t('app.retry')}
          </button>
        </div>
      ) : null}
      {documents.isSuccess ? (
        rows.length === 0 ? (
          <p className="panel muted">{t('reports.empty')}</p>
        ) : (
          <p className="muted">{t('reports.count', { count: total })}</p>
        )
      ) : null}

      <ul className="timeline">
        {rows.map((document) => {
          const what = document.title ?? t(`docType.${document.docType}`);

          return (
            <li key={document.id} className="panel">
              <p className="timeline__meta">
                <span className="badge">{t(`docType.${document.docType}`)}</span>
                <time dateTime={document.reportDate}>{formatDate(document.reportDate)}</time>
              </p>
              <strong>{what}</strong>
              <span className="item__meta">
                {[
                  t('home.at', { hospital: document.hospital.name }),
                  document.performingFacility,
                  document.orderingClinician?.name
                    ? t('reports.orderedBy', { name: document.orderingClinician.name })
                    : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>

              {document.files.map((file) => (
                <div key={file.id} className="file-row">
                  <span className="file-row__name">
                    {t('reports.file', { number: file.position })} ·{' '}
                    {file.mimeType === 'application/pdf' ? 'PDF' : t('reports.image')} ·{' '}
                    {formatBytes(file.sizeBytes)}
                  </span>
                  <button
                    type="button"
                    aria-label={t('reports.viewLabel', { what, number: file.position })}
                    disabled={busy !== null}
                    onClick={() => void open(document.id, file.id, 'inline')}
                  >
                    {busy === `${file.id}:inline` ? t('reports.opening') : t('reports.view')}
                  </button>
                  <button
                    type="button"
                    aria-label={t('reports.downloadLabel', { what, number: file.position })}
                    disabled={busy !== null}
                    onClick={() => void open(document.id, file.id, 'attachment')}
                  >
                    {busy === `${file.id}:attachment` ? t('reports.opening') : t('reports.download')}
                  </button>
                </div>
              ))}
            </li>
          );
        })}
      </ul>

      {documents.hasNextPage ? (
        <button
          type="button"
          onClick={() => void documents.fetchNextPage()}
          disabled={documents.isFetchingNextPage}
        >
          {documents.isFetchingNextPage ? t('app.loading') : t('reports.more')}
        </button>
      ) : null}
    </div>
  );
}
