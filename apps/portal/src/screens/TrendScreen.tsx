import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../api/client';
import { useTrend } from '../api/records';
import { TrendChart } from '../components/TrendChart';

/** One test over time, at every hospital, in one unit. */
export function TrendScreen(): JSX.Element {
  const { t } = useTranslation();
  const { code = '' } = useParams();
  const trend = useTrend(code);

  return (
    <div className="stack">
      <Link className="inline-link" to="/results">
        <span aria-hidden="true">←&nbsp;</span>
        {t('trend.back')}
      </Link>

      {trend.isPending ? <p aria-busy="true">{t('app.loading')}</p> : null}
      {trend.isError ? (
        <p className="alert" role="alert">
          {trend.error instanceof ApiError && trend.error.status === 400
            ? t('trend.notFound')
            : t('app.error')}
        </p>
      ) : null}

      {trend.data ? (
        <section className="panel" aria-labelledby="trend-title">
          <h1 id="trend-title">{trend.data.analyte.label}</h1>
          {trend.data.points.length === 0 ? (
            <p className="muted">{t('results.empty')}</p>
          ) : (
            <TrendChart trend={trend.data} />
          )}
        </section>
      ) : null}
    </div>
  );
}
