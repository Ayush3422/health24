import { QRCodeSVG } from 'qrcode.react';
import { useTranslation } from 'react-i18next';
import type { EmergencyFacts } from '@health24/shared';

/** On a wallet card there is room for a few of each; the code opens the rest. */
const ON_CARD = { allergies: 3, medicines: 3, conditions: 2 } as const;

/**
 * The wallet card: credit-card sized when printed (85.6 × 54 mm), with the
 * facts the patient chose and a QR code to the same facts kept current.
 * Text scales with the card, so it prints the same as it shows.
 */
export function EmergencyCardView({
  facts,
  url,
  printedOn,
}: {
  facts: EmergencyFacts;
  url: string;
  printedOn: string;
}): JSX.Element {
  const { t } = useTranslation();

  const more = (total: number, shown: number) =>
    total > shown ? ` ${t('emergencyCard.more', { count: total - shown })}` : '';

  return (
    <article className="ecard" aria-label={t('emergencyCard.cardLabel')}>
      <header className="ecard__band">{t('emergencyCard.cardTitle')}</header>
      <div className="ecard__body">
        <div className="ecard__facts">
          <p className="ecard__name">
            {facts.name}
            {facts.ageYears !== null ? `, ${t('home.age', { count: facts.ageYears })}` : ''}
          </p>

          {facts.allergies ? (
            <p className="ecard__alert">
              <b>{t('emergencyField.allergies')}:</b>{' '}
              {facts.allergies.length === 0
                ? t('emergencyCard.noneRecorded')
                : facts.allergies
                    .slice(0, ON_CARD.allergies)
                    .map((allergy) =>
                      allergy.highRisk
                        ? `${allergy.substance} (${t('emergencyCard.highRisk')})`
                        : allergy.substance,
                    )
                    .join(', ') + more(facts.allergies.length, ON_CARD.allergies)}
            </p>
          ) : null}

          {'bloodGroup' in facts ? (
            <p>
              <b>{t('emergencyField.blood_group')}:</b>{' '}
              {facts.bloodGroup ?? t('emergencyCard.notRecorded')}
            </p>
          ) : null}

          {facts.conditions ? (
            <p>
              <b>{t('emergencyField.conditions')}:</b>{' '}
              {facts.conditions.length === 0
                ? t('emergencyCard.noneRecorded')
                : facts.conditions
                    .slice(0, ON_CARD.conditions)
                    .map((condition) => condition.name)
                    .join(', ') + more(facts.conditions.length, ON_CARD.conditions)}
            </p>
          ) : null}

          {facts.medicines ? (
            <p>
              <b>{t('emergencyField.medicines')}:</b>{' '}
              {facts.medicines.length === 0
                ? t('emergencyCard.noneRecorded')
                : facts.medicines
                    .slice(0, ON_CARD.medicines)
                    .map((medicine) => medicine.name)
                    .join(', ') + more(facts.medicines.length, ON_CARD.medicines)}
            </p>
          ) : null}

          {'emergencyContact' in facts ? (
            <p>
              <b>{t('emergencyField.emergency_contact')}:</b>{' '}
              {facts.emergencyContact
                ? `${facts.emergencyContact.name}, ${facts.emergencyContact.phone}`
                : t('emergencyCard.notRecorded')}
            </p>
          ) : null}
        </div>

        <div className="ecard__qr">
          <QRCodeSVG value={url} size={512} level="M" aria-hidden="true" />
          <span>{t('emergencyCard.scan')}</span>
        </div>
      </div>
      <footer className="ecard__foot">{t('emergencyCard.printedOn', { date: printedOn })}</footer>
    </article>
  );
}
