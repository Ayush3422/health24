import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useResults } from '../api/records';
import { Flag, useRangeLabel } from '../components/ResultText';
import { formatDate, formatNumber } from '../format';

/** Lab values typed from the patient's reports, each test leading to its trend. */
export function ResultsScreen(): JSX.Element {
  const { t } = useTranslation();
  const rangeLabel = useRangeLabel();
  const results = useResults();
  const sets = results.data?.sets ?? [];

  return (
    <div className="stack">
      <header>
        <h1>{t('results.title')}</h1>
        <p className="muted">{t('results.intro')}</p>
      </header>

      {results.isPending ? <p aria-busy="true">{t('app.loading')}</p> : null}
      {results.isError ? (
        <div className="panel">
          <p className="alert" role="alert">
            {t('app.error')}
          </p>
          <button type="button" onClick={() => void results.refetch()}>
            {t('app.retry')}
          </button>
        </div>
      ) : null}
      {results.isSuccess && sets.length === 0 ? (
        <p className="panel muted">{t('results.empty')}</p>
      ) : null}

      {sets.map((set) => (
        <section key={set.id} className="panel" aria-labelledby={`set-${set.id}`}>
          <h2 id={`set-${set.id}`}>{set.panelLabel}</h2>
          <p className="item__meta">
            {[
              formatDate(set.collectedAt),
              t('home.at', { hospital: set.hospital.name }),
              set.performingFacility,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
          <ul className="items">
            {set.results.map((result) => (
              <li key={result.observationId}>
                <Link
                  className="inline-link result__name"
                  to={`/results/${encodeURIComponent(result.code)}`}
                  aria-label={t('results.seeTrend', { test: result.label })}
                >
                  {result.label}
                </Link>
                <span className="item__detail">
                  <strong>
                    {formatNumber(result.value)} {result.unit}
                  </strong>{' '}
                  <Flag interpretation={result.interpretation} />
                </span>
                <span className="item__meta">
                  {rangeLabel(result.referenceLow, result.referenceHigh, result.unit) ??
                    result.referenceText ??
                    t('results.noRange')}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
