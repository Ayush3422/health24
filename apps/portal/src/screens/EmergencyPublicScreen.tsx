import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { EmergencyFacts } from '@health24/shared';
import { ApiError } from '../api/client';
import { useEmergencyPage } from '../api/emergency';

/**
 * What an emergency card's QR code opens, for whoever is treating the patient:
 * no sign-in, large type, allergies first, and only what the patient chose to
 * share (sp5-plan.md, Decision L1).
 */
export function EmergencyPublicScreen(): JSX.Element {
  const { t } = useTranslation();
  const { token = '' } = useParams();
  const page = useEmergencyPage(token);

  const failure =
    page.error instanceof ApiError && page.error.status === 404
      ? t('emergencyPage.notInUse')
      : page.error instanceof ApiError && page.error.status === 429
        ? t('emergencyPage.slowDown')
        : t('app.error');

  return (
    <main id="content" className="emergency-page">
      <header className="emergency-page__band">
        <p className="brand brand--light">{t('app.name')}</p>
        <h1>{t('emergencyPage.title')}</h1>
      </header>

      {page.isPending ? <p aria-busy="true">{t('app.loading')}</p> : null}
      {page.isError ? (
        <p className="alert" role="alert">
          {failure}
        </p>
      ) : null}
      {page.data ? <Facts facts={page.data.facts} /> : null}

      <p className="hint">{t('emergencyPage.note')}</p>
    </main>
  );
}

function Facts({ facts }: { facts: EmergencyFacts }): JSX.Element {
  const { t } = useTranslation();

  return (
    <div className="stack facts-big">
      <section className="panel" aria-labelledby="patient-name">
        <h2 id="patient-name">{facts.name}</h2>
        {facts.ageYears !== null ? <p className="muted">{t('home.age', { count: facts.ageYears })}</p> : null}
      </section>

      {facts.allergies ? (
        <section
          className={`panel${facts.allergies.length > 0 ? ' panel--alert' : ''}`}
          aria-labelledby="allergies"
        >
          <h2 id="allergies">{t('emergencyField.allergies')}</h2>
          {facts.allergies.length === 0 ? (
            <p>{t('emergencyCard.noneRecorded')}</p>
          ) : (
            <ul className="items">
              {facts.allergies.map((allergy) => (
                <li key={allergy.substance}>
                  <strong>{allergy.substance}</strong>
                  {allergy.highRisk ? (
                    <span className="badge badge--danger">{t('home.highRisk')}</span>
                  ) : null}
                  {allergy.reaction ? <span className="item__detail">{allergy.reaction}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {'bloodGroup' in facts ? (
        <section className="panel" aria-labelledby="blood-group">
          <h2 id="blood-group">{t('emergencyField.blood_group')}</h2>
          <p className="blood-group">{facts.bloodGroup ?? t('emergencyCard.notRecorded')}</p>
        </section>
      ) : null}

      {facts.conditions ? (
        <section className="panel" aria-labelledby="conditions">
          <h2 id="conditions">{t('emergencyField.conditions')}</h2>
          {facts.conditions.length === 0 ? (
            <p>{t('emergencyCard.noneRecorded')}</p>
          ) : (
            <ul className="items">
              {facts.conditions.map((condition) => (
                <li key={`${condition.name}-${condition.code ?? ''}`}>
                  <strong>{condition.name}</strong>
                  {condition.code ? (
                    <span className="item__meta">{t('home.code', { code: condition.code })}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {facts.medicines ? (
        <section className="panel" aria-labelledby="medicines">
          <h2 id="medicines">{t('emergencyField.medicines')}</h2>
          {facts.medicines.length === 0 ? (
            <p>{t('emergencyCard.noneRecorded')}</p>
          ) : (
            <ul className="items">
              {facts.medicines.map((medicine) => (
                <li key={medicine.name}>
                  <strong>{medicine.name}</strong>
                  {medicine.howToTake ? <span className="item__detail">{medicine.howToTake}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {'emergencyContact' in facts ? (
        <section className="panel" aria-labelledby="contact">
          <h2 id="contact">{t('emergencyField.emergency_contact')}</h2>
          {facts.emergencyContact ? (
            <p>
              <strong>{facts.emergencyContact.name}</strong>{' '}
              <a className="inline-link" href={`tel:${facts.emergencyContact.phone}`}>
                {t('emergencyPage.call', { phone: facts.emergencyContact.phone })}
              </a>
            </p>
          ) : (
            <p>{t('emergencyCard.notRecorded')}</p>
          )}
        </section>
      ) : null}
    </div>
  );
}
