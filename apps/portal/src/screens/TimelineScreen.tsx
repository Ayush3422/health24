import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { ClinicalDataCategory } from '@health24/shared';
import { useTimeline } from '../api/records';
import { formatDate } from '../format';

/** The pages built on the timeline, and the categories each shows. */
export const TIMELINE_PAGES = {
  timeline: null,
  medicines: ['medications'],
  problems: ['diagnoses'],
  allergies: ['allergies'],
} as const satisfies Record<string, readonly ClinicalDataCategory[] | null>;

export type TimelinePageName = keyof typeof TIMELINE_PAGES;

/**
 * The patient's record as one stream, newest first, from every hospital —
 * or one part of it: medicines, diagnoses, allergies. Entries are as the
 * doctors wrote them; nothing is rephrased (sp5-plan.md, DF5).
 */
export function TimelineScreen({ page }: { page: TimelinePageName }): JSX.Element {
  const { t } = useTranslation();
  const timeline = useTimeline(TIMELINE_PAGES[page]);
  const items = timeline.data?.pages.flatMap((result) => result.items) ?? [];

  return (
    <div className="stack">
      <header>
        <h1>{t(`${page}.title`)}</h1>
        <p className="muted">{t(`${page}.intro`)}</p>
      </header>

      {timeline.isPending ? <p aria-busy="true">{t('app.loading')}</p> : null}
      {timeline.isError ? (
        <div className="panel">
          <p className="alert" role="alert">
            {t('app.error')}
          </p>
          <button type="button" onClick={() => void timeline.refetch()}>
            {t('app.retry')}
          </button>
        </div>
      ) : null}
      {timeline.isSuccess && items.length === 0 ? (
        <p className="panel muted">{t(`${page}.empty`)}</p>
      ) : null}

      {items.length > 0 ? (
        <ol className="timeline">
          {items.map((item) => (
            <li key={`${item.kind}-${item.id}`} className="panel">
              <p className="timeline__meta">
                <span className="badge">{t(`kind.${item.kind}`)}</span>
                <time dateTime={item.at}>{formatDate(item.at)}</time>
              </p>
              <strong>{item.title}</strong>
              {item.detail ? <span className="item__detail">{item.detail}</span> : null}
              <span className="item__meta">
                {[item.clinician.name, t('home.at', { hospital: item.hospital.name })]
                  .filter(Boolean)
                  .join(' · ')}
                {item.corrected ? ` · ${t('timeline.corrected')}` : ''}
              </span>
              {item.kind === 'document' ? (
                <Link className="inline-link" to="/reports">
                  {t('timeline.openReports')}
                </Link>
              ) : null}
              {item.kind === 'result' ? (
                <Link className="inline-link" to="/results">
                  {t('timeline.openResults')}
                </Link>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}

      {timeline.hasNextPage ? (
        <button
          type="button"
          onClick={() => void timeline.fetchNextPage()}
          disabled={timeline.isFetchingNextPage}
        >
          {timeline.isFetchingNextPage ? t('app.loading') : t('timeline.older')}
        </button>
      ) : null}
    </div>
  );
}
