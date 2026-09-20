import { useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { CORRECTION_FIELDS, type CorrectionField } from '@health24/shared';
import { ApiError } from '../api/client';
import { useCorrections, useRequestCorrection } from '../api/corrections';
import { formatDate } from '../format';

/**
 * Asking a hospital to correct what it holds about the patient (sp5-plan.md,
 * Decision N1). The patient says what it should be; the hospital's records
 * staff make the change, or say why they have not.
 */
export function CorrectionRequests(): JSX.Element {
  const { t } = useTranslation();
  const corrections = useCorrections();
  const request = useRequestCorrection();
  const id = useId();

  const [asking, setAsking] = useState(false);
  const [hospitalId, setHospitalId] = useState('');
  const [field, setField] = useState<CorrectionField>('name');
  const [value, setValue] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const data = corrections.data;
  const hospitals = data?.hospitals ?? [];
  const requests = data?.requests ?? [];

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    try {
      await request.mutateAsync({
        hospitalId: hospitalId || (hospitals[0]?.id ?? ''),
        field,
        requestedValue: value.trim(),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      setNotice(t('corrections.sent'));
      setAsking(false);
      setValue('');
      setNote('');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('app.error'));
    }
  };

  return (
    <section className="panel stack" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>{t('corrections.title')}</h2>
      <p>{t('corrections.intro')}</p>

      <p role="status" className={notice ? 'notice' : 'visually-hidden'}>
        {notice}
      </p>
      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}

      {corrections.isPending ? <p aria-busy="true">{t('app.loading')}</p> : null}
      {corrections.isError ? (
        <p className="alert" role="alert">
          {t('app.error')}
        </p>
      ) : null}

      {data && hospitals.length === 0 ? <p className="muted">{t('corrections.noHospital')}</p> : null}

      {data && hospitals.length > 0 ? (
        asking ? (
          <form onSubmit={(event) => void submit(event)} className="stack">
            <div className="field">
              <label htmlFor={`${id}-hospital`}>{t('corrections.whichHospital')}</label>
              <select
                id={`${id}-hospital`}
                value={hospitalId || hospitals[0]!.id}
                onChange={(event) => setHospitalId(event.target.value)}
              >
                {hospitals.map((hospital) => (
                  <option key={hospital.id} value={hospital.id}>
                    {hospital.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label htmlFor={`${id}-field`}>{t('corrections.whichDetail')}</label>
              <select
                id={`${id}-field`}
                value={field}
                onChange={(event) => setField(event.target.value as CorrectionField)}
              >
                {CORRECTION_FIELDS.map((name) => (
                  <option key={name} value={name}>
                    {t(`correctionField.${name}`)}
                  </option>
                ))}
              </select>
              <p className="hint">
                {t('corrections.currently', {
                  value: data.current[field] ?? t('corrections.blank'),
                })}
              </p>
            </div>

            <div className="field">
              <label htmlFor={`${id}-value`}>{t('corrections.shouldBe')}</label>
              <input
                id={`${id}-value`}
                value={value}
                onChange={(event) => setValue(event.target.value)}
                required
              />
            </div>

            <div className="field">
              <label htmlFor={`${id}-note`}>{t('corrections.note')}</label>
              <textarea
                id={`${id}-note`}
                rows={2}
                maxLength={500}
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
            </div>

            <div className="row">
              <button type="button" onClick={() => setAsking(false)}>
                {t('corrections.cancel')}
              </button>
              <button type="submit" className="primary" disabled={request.isPending || value.trim() === ''}>
                {request.isPending ? t('corrections.sending') : t('corrections.send')}
              </button>
            </div>
          </form>
        ) : (
          <button type="button" onClick={() => setAsking(true)}>
            {t('corrections.ask')}
          </button>
        )
      ) : null}

      {requests.length > 0 ? (
        <ul className="items">
          {requests.map((row) => (
            <li key={row.id}>
              <strong>{t(`correctionField.${row.field}`)}</strong>{' '}
              <span className="badge">{t(`corrections.status_${row.status}`)}</span>
              <span className="item__detail">
                {t('corrections.change', {
                  from: row.currentValue ?? t('corrections.blank'),
                  to: row.requestedValue,
                })}
              </span>
              <span className="item__meta">
                {t('corrections.sentOn', {
                  hospital: row.hospital.name,
                  date: formatDate(row.createdAt),
                })}
              </span>
              {row.resolutionNote ? (
                <span className="item__meta">
                  {t('corrections.answer', { note: row.resolutionNote })}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
