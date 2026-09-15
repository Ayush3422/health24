import { useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { CLINICAL_DATA_CATEGORIES, type ClinicalDataCategory, type PortalConsent } from '@health24/shared';
import { ApiError } from '../api/client';
import { useGrantConsent, usePortalConsents, useRevokeConsent } from '../api/consents';
import { formatDate, formatDateTime, istToday } from '../format';

/** How long a consent lasts, in days: a year at most, then the patient chooses again. */
const DURATIONS = [30, 90, 180, 365] as const;

const errorText = (caught: unknown, fallback: string) =>
  caught instanceof ApiError ? caught.message : fallback;

/**
 * Sharing (SP5, Decision K1): which hospital may see the patient's record from
 * their other hospitals, what of it, and for how long — granted and revoked by
 * the patient, with every consent kept as history.
 */
export function ConsentsScreen(): JSX.Element {
  const { t } = useTranslation();
  const consents = usePortalConsents();
  const [notice, setNotice] = useState<string | null>(null);

  const all = consents.data?.consents ?? [];
  const active = all.filter((consent) => consent.status === 'active');
  const past = all.filter((consent) => consent.status !== 'active');

  return (
    <div className="stack">
      <header>
        <h1>{t('consents.title')}</h1>
        <p className="muted">{t('consents.intro')}</p>
      </header>

      <p role="status" className={notice ? 'notice' : 'visually-hidden'}>
        {notice}
      </p>

      {consents.isPending ? <p aria-busy="true">{t('app.loading')}</p> : null}
      {consents.isError ? (
        <div className="panel">
          <p className="alert" role="alert">
            {t('app.error')}
          </p>
          <button type="button" onClick={() => void consents.refetch()}>
            {t('app.retry')}
          </button>
        </div>
      ) : null}

      {consents.data ? (
        <GrantConsent
          hospitals={consents.data.hospitals}
          onGranted={(hospital) => setNotice(t('consents.granted', { hospital }))}
        />
      ) : null}

      {consents.isSuccess ? (
        <section aria-labelledby="active-consents" className="stack">
          <h2 id="active-consents">{t('consents.active')}</h2>
          {active.length === 0 ? (
            <p className="panel muted">{t('consents.noneActive')}</p>
          ) : (
            <ul className="timeline">
              {active.map((consent) => (
                <ConsentCard
                  key={consent.id}
                  consent={consent}
                  onRevoked={() => setNotice(t('consents.revoked', { hospital: consent.hospital.name }))}
                />
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {past.length > 0 ? (
        <section aria-labelledby="past-consents" className="stack">
          <h2 id="past-consents">{t('consents.history')}</h2>
          <ul className="timeline">
            {past.map((consent) => (
              <ConsentCard key={consent.id} consent={consent} onRevoked={() => undefined} />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function GrantConsent({
  hospitals,
  onGranted,
}: {
  hospitals: Array<{ id: string; name: string }>;
  onGranted: (hospital: string) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const grant = useGrantConsent();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [hospitalId, setHospitalId] = useState<string | null>(null);
  const [categories, setCategories] = useState<ClinicalDataCategory[]>([]);
  const [limitDates, setLimitDates] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [days, setDays] = useState<number>(180);
  const [error, setError] = useState<string | null>(null);

  // A hospital sees what the patient's other hospitals hold; with one, there is nothing yet.
  if (hospitals.length < 2) {
    return <p className="panel muted">{t('consents.oneHospital')}</p>;
  }

  if (!open) {
    return (
      <button type="button" className="primary" onClick={() => setOpen(true)}>
        {t('consents.start')}
      </button>
    );
  }

  const hospital = hospitals.find((candidate) => candidate.id === hospitalId);

  const toggle = (category: ClinicalDataCategory) =>
    setCategories((current) =>
      current.includes(category)
        ? current.filter((value) => value !== category)
        : CLINICAL_DATA_CATEGORIES.filter((value) => value === category || current.includes(value)),
    );

  const reset = () => {
    setOpen(false);
    setHospitalId(null);
    setCategories([]);
    setLimitDates(false);
    setFrom('');
    setTo('');
    setDays(180);
    setError(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    if (!hospital) return setError(t('consents.chooseHospital'));
    if (categories.length === 0) return setError(t('consents.chooseCategories'));

    try {
      await grant.mutateAsync({
        hospitalId: hospital.id,
        dataCategories: categories,
        validForDays: days,
        ...(limitDates && from ? { dateRangeFrom: from } : {}),
        ...(limitDates && to ? { dateRangeTo: to } : {}),
      });
      onGranted(hospital.name);
      reset();
    } catch (caught) {
      setError(errorText(caught, t('app.error')));
    }
  };

  const until = formatDate(new Date(Date.now() + days * 86_400_000).toISOString());

  return (
    <form className="panel" onSubmit={(event) => void submit(event)} aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>{t('consents.start')}</h2>
      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}

      <fieldset>
        <legend>{t('consents.whichHospital')}</legend>
        {hospitals.map((candidate) => (
          <label key={candidate.id} className="choice-row">
            <input
              type="radio"
              name={`${id}-hospital`}
              checked={hospitalId === candidate.id}
              onChange={() => setHospitalId(candidate.id)}
            />
            {candidate.name}
          </label>
        ))}
      </fieldset>

      <fieldset>
        <legend>{t('consents.whichRecords')}</legend>
        {CLINICAL_DATA_CATEGORIES.map((category) => (
          <label key={category} className="choice-row">
            <input
              type="checkbox"
              checked={categories.includes(category)}
              onChange={() => toggle(category)}
            />
            {t(`category.${category}`)}
          </label>
        ))}
      </fieldset>

      <fieldset>
        <legend>{t('consents.whichDates')}</legend>
        <label className="choice-row">
          <input
            type="radio"
            name={`${id}-dates`}
            checked={!limitDates}
            onChange={() => setLimitDates(false)}
          />
          {t('consents.allDates')}
        </label>
        <label className="choice-row">
          <input
            type="radio"
            name={`${id}-dates`}
            checked={limitDates}
            onChange={() => setLimitDates(true)}
          />
          {t('consents.someDates')}
        </label>
        {limitDates ? (
          <div className="date-pair">
            <div className="field">
              <label htmlFor={`${id}-from`}>{t('consents.from')}</label>
              <input id={`${id}-from`} type="date" max={istToday()} value={from} onChange={(event) => setFrom(event.target.value)} />
            </div>
            <div className="field">
              <label htmlFor={`${id}-to`}>{t('consents.to')}</label>
              <input id={`${id}-to`} type="date" max={istToday()} value={to} onChange={(event) => setTo(event.target.value)} />
            </div>
          </div>
        ) : null}
      </fieldset>

      <div className="field">
        <label htmlFor={`${id}-days`}>{t('consents.howLong')}</label>
        <select id={`${id}-days`} value={days} onChange={(event) => setDays(Number(event.target.value))}>
          {DURATIONS.map((value) => (
            <option key={value} value={value}>
              {t(`consents.duration_${value}`)}
            </option>
          ))}
        </select>
      </div>

      {hospital && categories.length > 0 ? (
        <p className="notice">
          {t('consents.preview', {
            hospital: hospital.name,
            records: categories.map((category) => t(`category.${category}`)).join(', '),
            date: until,
          })}
        </p>
      ) : null}

      <div className="row">
        <button type="button" onClick={reset}>
          {t('consents.cancel')}
        </button>
        <button type="submit" className="primary" disabled={grant.isPending}>
          {grant.isPending ? t('consents.sharing') : t('consents.share')}
        </button>
      </div>
    </form>
  );
}

function ConsentCard({
  consent,
  onRevoked,
}: {
  consent: PortalConsent;
  onRevoked: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const revoke = useRevokeConsent();
  const id = useId();
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const emergency = consent.captureMethod === 'break_glass';

  const grantedBy =
    consent.recordedBy.kind === 'patient'
      ? consent.recordedBy.you
        ? t('consents.grantedByYou', { date: formatDate(consent.grantedAt) })
        : t('consents.grantedInPortal', { date: formatDate(consent.grantedAt) })
      : emergency
        ? t('consents.takenBy', {
            name: consent.recordedBy.name ?? t('consents.someone'),
            date: formatDateTime(consent.grantedAt),
          })
        : t('consents.recordedAtDesk', {
            name: consent.recordedBy.name ?? t('consents.someone'),
            date: formatDate(consent.grantedAt),
          });

  const revokedBy =
    consent.revokedBy === null
      ? null
      : consent.revokedBy.kind === 'patient'
        ? consent.revokedBy.you
          ? t('consents.revokedByYou')
          : t('consents.revokedInPortal')
        : t('consents.revokedByStaff', { name: consent.revokedBy.name ?? t('consents.someone') });

  const confirm = async () => {
    setError(null);
    try {
      await revoke.mutateAsync({ id: consent.id, reason: reason.trim() || undefined });
      setConfirming(false);
      onRevoked();
    } catch (caught) {
      setError(errorText(caught, t('app.error')));
    }
  };

  return (
    <li className={`panel${emergency ? ' panel--alert' : ''}`}>
      <p className="timeline__meta">
        <span className="badge">{t(`consents.status_${consent.status}`)}</span>
        {emergency ? <span className="badge badge--danger">{t('consents.emergency')}</span> : null}
      </p>
      <strong>{consent.hospital.name}</strong>
      <span className="item__detail">
        {emergency
          ? t('consents.reason', { reason: consent.emergencyReason ?? '' })
          : consent.dataCategories.map((category) => t(`category.${category}`)).join(', ')}
      </span>
      {consent.dateRangeFrom || consent.dateRangeTo ? (
        <span className="item__meta">
          {t('consents.range', {
            from: consent.dateRangeFrom ? formatDate(consent.dateRangeFrom) : t('consents.beginning'),
            to: consent.dateRangeTo ? formatDate(consent.dateRangeTo) : t('consents.today'),
          })}
        </span>
      ) : null}
      <span className="item__meta">{grantedBy}</span>
      <span className="item__meta">
        {consent.status === 'active'
          ? t('consents.until', {
              date: emergency ? formatDateTime(consent.expiresAt) : formatDate(consent.expiresAt),
            })
          : consent.status === 'expired'
            ? t('consents.expiredOn', { date: formatDate(consent.expiresAt) })
            : t('consents.revokedOn', {
                date: consent.revokedAt ? formatDate(consent.revokedAt) : '',
              })}
      </span>
      {consent.status === 'revoked' && revokedBy ? (
        <span className="item__meta">
          {revokedBy}
          {consent.revocationReason ? `: ${consent.revocationReason}` : ''}
        </span>
      ) : null}
      {emergency && consent.status === 'active' ? (
        <span className="item__meta">{t('consents.emergencyNote')}</span>
      ) : null}

      {consent.status === 'active' && !emergency ? (
        confirming ? (
          <div className="confirm">
            <p>{t('consents.revokeConfirm', { hospital: consent.hospital.name })}</p>
            {error ? (
              <p className="alert" role="alert">
                {error}
              </p>
            ) : null}
            <div className="field">
              <label htmlFor={`${id}-reason`}>{t('consents.reasonLabel')}</label>
              <textarea
                id={`${id}-reason`}
                rows={2}
                maxLength={500}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </div>
            <div className="row">
              <button type="button" onClick={() => setConfirming(false)}>
                {t('consents.keep')}
              </button>
              <button
                type="button"
                className="danger"
                disabled={revoke.isPending}
                onClick={() => void confirm()}
              >
                {revoke.isPending ? t('consents.stopping') : t('consents.stopConfirm')}
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="secondary" onClick={() => setConfirming(true)}>
            {t('consents.stop')}
          </button>
        )
      ) : null}
    </li>
  );
}
