import { useId, useRef, useState, type FormEvent } from 'react';
import { QRCodeCanvas } from 'qrcode.react';
import { useTranslation } from 'react-i18next';
import type { EmergencyCardField, EmergencyFacts } from '@health24/shared';
import { ApiError } from '../api/client';
import {
  cardUrl,
  useCreateCard,
  useEmergencyCard,
  useReplaceCard,
  useRevokeCard,
  useUpdateCard,
} from '../api/emergency';
import { EmergencyCardView } from '../components/EmergencyCardView';
import { CARD_FIELDS, drawLockScreen, lockScreenLines, pickFacts } from '../emergency';
import { formatDate, istToday } from '../format';

/** Everything, except an emergency contact nobody has registered. */
const defaultFields = (facts: EmergencyFacts): EmergencyCardField[] =>
  CARD_FIELDS.filter((field) => field !== 'emergency_contact' || facts.emergencyContact);

/**
 * The emergency card (sp5-plan.md, Decision L1): the patient chooses what it
 * shows, prints it for a wallet, saves an image for the phone's lock screen,
 * and replaces or turns it off.
 */
export function EmergencyCardScreen(): JSX.Element {
  const { t } = useTranslation();
  const state = useEmergencyCard();
  const create = useCreateCard();
  const update = useUpdateCard();
  const replace = useReplaceCard();
  const revoke = useRevokeCard();
  const qr = useRef<HTMLCanvasElement>(null);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState<'replace' | 'revoke' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (state.isPending) return <p aria-busy="true">{t('app.loading')}</p>;

  if (state.isError) {
    return (
      <div className="panel">
        <p className="alert" role="alert">
          {t('app.error')}
        </p>
        <button type="button" onClick={() => void state.refetch()}>
          {t('app.retry')}
        </button>
      </div>
    );
  }

  const { card, facts } = state.data;
  const printedOn = formatDate(istToday());
  const translate = (key: string, options?: Record<string, unknown>) => String(t(key, options));

  const run = async (action: () => Promise<unknown>, done: string) => {
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(done);
      setEditing(false);
      setConfirming(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('app.error'));
    }
  };

  const saveLockScreen = () => {
    if (!card || !qr.current) return;

    const shown = pickFacts(facts, card.fields);
    const canvas = document.createElement('canvas');

    drawLockScreen(
      canvas,
      {
        title: t('emergencyCard.cardTitle'),
        name:
          shown.ageYears !== null
            ? `${shown.name}, ${t('home.age', { count: shown.ageYears })}`
            : shown.name,
        lines: lockScreenLines(shown, translate),
        footer: t('emergencyCard.lockFooter'),
      },
      qr.current,
    );

    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'health24-emergency-card.png';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1_000);
    }, 'image/png');
  };

  return (
    <div className="stack">
      <header className="no-print">
        <h1>{t('emergencyCard.title')}</h1>
        <p className="muted">{t('emergencyCard.intro')}</p>
      </header>

      <p role="status" className={notice ? 'notice no-print' : 'visually-hidden'}>
        {notice}
      </p>
      {error ? (
        <p className="alert no-print" role="alert">
          {error}
        </p>
      ) : null}

      {!card ? (
        <CardSettings
          facts={facts}
          initial={defaultFields(facts)}
          submitLabel={t('emergencyCard.create')}
          busy={create.isPending}
          onSubmit={(fields) => run(() => create.mutateAsync(fields), t('emergencyCard.created'))}
        />
      ) : (
        <>
          <section aria-labelledby="your-card" className="stack">
            <h2 id="your-card" className="no-print">
              {t('emergencyCard.yourCard')}
            </h2>
            <EmergencyCardView
              facts={pickFacts(facts, card.fields)}
              url={cardUrl(card.token)}
              printedOn={printedOn}
            />
            <p className="hint no-print">{t('emergencyCard.howItWorks')}</p>
            <div className="row no-print">
              <button type="button" className="primary" onClick={() => window.print()}>
                {t('emergencyCard.print')}
              </button>
              <button type="button" onClick={saveLockScreen}>
                {t('emergencyCard.lockScreen')}
              </button>
            </div>
            {/* Drawn off-screen for the lock-screen image. */}
            <QRCodeCanvas
              ref={qr}
              value={cardUrl(card.token)}
              size={512}
              level="M"
              marginSize={2}
              style={{ display: 'none' }}
              aria-hidden="true"
            />
          </section>

          {editing ? (
            <CardSettings
              facts={facts}
              initial={card.fields}
              submitLabel={t('emergencyCard.save')}
              busy={update.isPending}
              onSubmit={(fields) => run(() => update.mutateAsync(fields), t('emergencyCard.saved'))}
              onCancel={() => setEditing(false)}
            />
          ) : null}

          <section className="panel stack no-print" aria-labelledby="manage-card">
            <h2 id="manage-card">{t('emergencyCard.manage')}</h2>

            {!editing ? (
              <button type="button" onClick={() => setEditing(true)}>
                {t('emergencyCard.change')}
              </button>
            ) : null}

            {confirming === 'replace' ? (
              <Confirm
                text={t('emergencyCard.replaceConfirm')}
                yes={t('emergencyCard.replaceYes')}
                busy={replace.isPending}
                onYes={() => void run(() => replace.mutateAsync(), t('emergencyCard.replaced'))}
                onNo={() => setConfirming(null)}
              />
            ) : (
              <button type="button" onClick={() => setConfirming('replace')}>
                {t('emergencyCard.replace')}
              </button>
            )}

            {confirming === 'revoke' ? (
              <Confirm
                text={t('emergencyCard.revokeConfirm')}
                yes={t('emergencyCard.revokeYes')}
                busy={revoke.isPending}
                danger
                onYes={() => void run(() => revoke.mutateAsync(), t('emergencyCard.revoked'))}
                onNo={() => setConfirming(null)}
              />
            ) : (
              <button type="button" onClick={() => setConfirming('revoke')}>
                {t('emergencyCard.revoke')}
              </button>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function CardSettings({
  facts,
  initial,
  submitLabel,
  busy,
  onSubmit,
  onCancel,
}: {
  facts: EmergencyFacts;
  initial: readonly EmergencyCardField[];
  submitLabel: string;
  busy: boolean;
  onSubmit: (fields: EmergencyCardField[]) => Promise<void>;
  onCancel?: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const id = useId();
  const [fields, setFields] = useState<EmergencyCardField[]>([...initial]);

  const toggle = (field: EmergencyCardField) =>
    setFields((current) =>
      current.includes(field)
        ? current.filter((value) => value !== field)
        : CARD_FIELDS.filter((value) => value === field || current.includes(value)),
    );

  const list = (items: string[] | undefined) =>
    items && items.length > 0 ? items.join(', ') : t('emergencyCard.noneRecorded');

  const preview: Record<EmergencyCardField, string> = {
    blood_group: facts.bloodGroup ?? t('emergencyCard.notRecorded'),
    allergies: list(facts.allergies?.map((allergy) => allergy.substance)),
    medicines: list(facts.medicines?.map((medicine) => medicine.name)),
    conditions: list(facts.conditions?.map((condition) => condition.name)),
    emergency_contact: facts.emergencyContact
      ? `${facts.emergencyContact.name} · ${facts.emergencyContact.phone}`
      : t('emergencyCard.noContact'),
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (fields.length > 0) void onSubmit(fields);
  };

  return (
    <form className="panel no-print" onSubmit={submit} aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>{t('emergencyCard.whatShows')}</h2>
      <p className="hint">{t('emergencyCard.alwaysShown')}</p>

      <fieldset>
        <legend className="visually-hidden">{t('emergencyCard.whatShows')}</legend>
        {CARD_FIELDS.map((field) => (
          <label key={field} className="choice-row choice-row--top">
            <input type="checkbox" checked={fields.includes(field)} onChange={() => toggle(field)} />
            <span>
              <span className="choice__name">{t(`emergencyField.${field}`)}</span>
              <span className="item__meta">{preview[field]}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {fields.length === 0 ? (
        <p className="alert" role="alert">
          {t('emergencyCard.chooseOne')}
        </p>
      ) : null}

      <div className="row">
        {onCancel ? (
          <button type="button" onClick={onCancel}>
            {t('emergencyCard.cancel')}
          </button>
        ) : null}
        <button type="submit" className="primary" disabled={busy || fields.length === 0}>
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

function Confirm({
  text,
  yes,
  busy,
  danger = false,
  onYes,
  onNo,
}: {
  text: string;
  yes: string;
  busy: boolean;
  danger?: boolean;
  onYes: () => void;
  onNo: () => void;
}): JSX.Element {
  const { t } = useTranslation();

  return (
    <div className="confirm">
      <p>{text}</p>
      <div className="row">
        <button type="button" onClick={onNo}>
          {t('emergencyCard.keep')}
        </button>
        <button type="button" className={danger ? 'danger' : 'primary'} disabled={busy} onClick={onYes}>
          {yes}
        </button>
      </div>
    </div>
  );
}
