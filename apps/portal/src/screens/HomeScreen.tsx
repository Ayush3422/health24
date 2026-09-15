import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { PortalSummary } from '@health24/shared';
import { api } from '../api/client';
import { formatDate, formatNumber } from '../format';

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

/**
 * The patient's own record at a glance, from every hospital, in plain words —
 * never rephrased or explained (sp5-plan.md, DF5).
 */
export function HomeScreen(): JSX.Element {
  const { t } = useTranslation();
  const summary = useQuery({
    queryKey: ['portal', 'summary'],
    queryFn: () => api<PortalSummary>('/portal/summary'),
  });

  if (summary.isPending) {
    return <p aria-busy="true">{t('app.loading')}</p>;
  }

  if (summary.isError) {
    return (
      <div className="panel">
        <p className="alert" role="alert">
          {t('app.error')}
        </p>
        <button type="button" onClick={() => void summary.refetch()}>
          {t('app.retry')}
        </button>
      </div>
    );
  }

  const data = summary.data;

  return (
    <div className="stack">
      <section aria-labelledby="greeting">
        <h1 id="greeting">{t('home.greeting', { name: firstName(data.patient.name) })}</h1>
        {data.patient.ageYears !== null ? (
          <p className="muted">{t('home.age', { count: data.patient.ageYears })}</p>
        ) : null}
      </section>

      <section
        className={`panel${data.allergies.length > 0 ? ' panel--alert' : ''}`}
        aria-labelledby="allergies"
      >
        <h2 id="allergies">{t('home.allergies')}</h2>
        {data.allergies.length === 0 ? (
          <p className="muted">{t('home.noAllergies')}</p>
        ) : (
          <ul className="items">
            {data.allergies.map((allergy) => (
              <li key={allergy.id}>
                <strong>{allergy.substance}</strong>
                {allergy.highRisk ? <span className="badge badge--danger">{t('home.highRisk')}</span> : null}
                {allergy.reaction ? <span className="item__detail">{allergy.reaction}</span> : null}
                <span className="item__meta">{t('home.at', { hospital: allergy.hospitalName })}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel" aria-labelledby="problems">
        <h2 id="problems">{t('home.problems')}</h2>
        {data.problems.length === 0 ? (
          <p className="muted">{t('home.noProblems')}</p>
        ) : (
          <ul className="items">
            {data.problems.map((problem) => (
              <li key={problem.id}>
                <strong>{problem.name}</strong>
                <span className="item__meta">
                  {t('home.since', { date: formatDate(problem.since) })} ·{' '}
                  {t('home.at', { hospital: problem.hospitalName })}
                  {problem.code ? ` · ${t('home.code', { code: problem.code })}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel" aria-labelledby="medicines">
        <h2 id="medicines">{t('home.medicines')}</h2>
        {data.medicines.length === 0 ? (
          <p className="muted">{t('home.noMedicines')}</p>
        ) : (
          <ul className="items">
            {data.medicines.map((medicine) => (
              <li key={medicine.id}>
                <strong>{medicine.name}</strong>
                {medicine.howToTake ? <span className="item__detail">{medicine.howToTake}</span> : null}
                <span className="item__meta">
                  {medicine.startDate
                    ? `${t('home.started', { date: formatDate(medicine.startDate) })} · `
                    : ''}
                  {t('home.at', { hospital: medicine.hospitalName })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel" aria-labelledby="results">
        <h2 id="results">{t('home.results')}</h2>
        {data.abnormalResults.length === 0 ? (
          <p className="muted">{t('home.noResults')}</p>
        ) : (
          <ul className="items">
            {data.abnormalResults.map((result) => (
              <li key={result.id}>
                <strong>
                  {result.label}: {formatNumber(result.value)} {result.unit}
                </strong>
                <span className="item__detail">
                  {/* Direction as a glyph and in words, never by colour alone. */}
                  <span aria-hidden="true">
                    {result.direction === 'higher' ? '▲ ' : result.direction === 'lower' ? '▼ ' : '! '}
                  </span>
                  {t(`home.direction_${result.direction}`)}
                </span>
                <span className="item__meta">
                  {formatDate(result.collectedAt)} · {t('home.at', { hospital: result.hospitalName })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel" aria-labelledby="last-visit">
        <h2 id="last-visit">{t('home.lastVisit')}</h2>
        {data.lastVisit ? (
          <p>
            <strong>{t(`visit.${data.lastVisit.kind}`)}</strong> · {formatDate(data.lastVisit.date)} ·{' '}
            {t('home.at', { hospital: data.lastVisit.hospitalName })}
          </p>
        ) : (
          <p className="muted">{t('home.noVisits')}</p>
        )}
      </section>

      <section className="panel" aria-labelledby="hospitals">
        <h2 id="hospitals">{t('home.hospitals')}</h2>
        <ul className="items">
          {data.hospitals.map((hospital) => (
            <li key={hospital.id}>
              <strong>{hospital.name}</strong>
              <span className="item__meta">{t('home.mrn', { mrn: hospital.mrn })}</span>
            </li>
          ))}
        </ul>
      </section>

      <p className="hint">{t('home.notAdvice')}</p>
    </div>
  );
}
