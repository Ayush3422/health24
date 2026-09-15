import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { OtpVerified, PortalPatientOption, PortalSessionIssued } from '@health24/shared';
import { api, ApiError } from '../api/client';
import { displayPhone } from '../format';
import { useSession } from '../session/SessionProvider';

type Step =
  | { name: 'phone' }
  | { name: 'code'; phone: string }
  | { name: 'choose'; selectionToken: string; patients: PortalPatientOption[] };

const RESEND_AFTER_SECONDS = 30;

const errorText = (caught: unknown, fallback: string) =>
  caught instanceof ApiError ? caught.message : fallback;

/**
 * Sign-in: a mobile number, a one-time code, then — when the phone opens more
 * than one record — whose record to open (sp5-plan.md, Decision J1).
 */
export function SignInScreen(): JSX.Element {
  const { t } = useTranslation();
  const [step, setStep] = useState<Step>({ name: 'phone' });

  return (
    <main className="signin" id="content">
      <header className="signin__brand">
        <p className="brand">{t('app.name')}</p>
        <p className="muted">{t('app.tagline')}</p>
      </header>

      {step.name === 'phone' ? (
        <PhoneStep onSent={(phone) => setStep({ name: 'code', phone })} />
      ) : null}
      {step.name === 'code' ? (
        <CodeStep
          phone={step.phone}
          onChangeNumber={() => setStep({ name: 'phone' })}
          onVerified={(verified) =>
            setStep({
              name: 'choose',
              selectionToken: verified.selectionToken,
              patients: verified.patients,
            })
          }
        />
      ) : null}
      {step.name === 'choose' ? (
        <ChooseStep selectionToken={step.selectionToken} patients={step.patients} />
      ) : null}
    </main>
  );
}

function PhoneStep({ onSent }: { onSent: (phone: string) => void }): JSX.Element {
  const { t } = useTranslation();
  const [phone, setPhone] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);

    try {
      await api('/portal/auth/otp', { method: 'POST', body: { phone } });
      onSent(phone);
    } catch (caught) {
      setError(errorText(caught, t('app.error')));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="panel" onSubmit={(event) => void submit(event)} noValidate>
      <h1>{t('signIn.title')}</h1>
      <p>{t('signIn.intro')}</p>
      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}
      <div className="field">
        <label htmlFor="phone">{t('signIn.phoneLabel')}</label>
        <input
          id="phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          aria-describedby="phone-hint"
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
          required
        />
        <p id="phone-hint" className="hint">
          {t('signIn.phoneHint')}
        </p>
      </div>
      <button type="submit" className="primary" disabled={busy || phone.trim().length < 10}>
        {busy ? t('signIn.sending') : t('signIn.sendCode')}
      </button>
      <p className="hint">{t('signIn.noAccess')}</p>
    </form>
  );
}

function CodeStep({
  phone,
  onChangeNumber,
  onVerified,
}: {
  phone: string;
  onChangeNumber: () => void;
  onVerified: (verified: OtpVerified) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const { begin } = useSession();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [wait, setWait] = useState(RESEND_AFTER_SECONDS);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => input.current?.focus(), []);

  useEffect(() => {
    if (wait <= 0) return;
    const timer = setTimeout(() => setWait((seconds) => seconds - 1), 1000);
    return () => clearTimeout(timer);
  }, [wait]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);

    try {
      const verified = await api<OtpVerified>('/portal/auth/verify', {
        method: 'POST',
        body: { phone, code },
      });

      const [only] = verified.patients;
      if (verified.patients.length === 1 && only) {
        await begin(
          await api<PortalSessionIssued>('/portal/auth/session', {
            method: 'POST',
            body: { selectionToken: verified.selectionToken, patientId: only.id },
          }),
        );
      } else {
        onVerified(verified);
      }
    } catch (caught) {
      setError(errorText(caught, t('app.error')));
      setCode('');
      input.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    setError(null);
    try {
      await api('/portal/auth/otp', { method: 'POST', body: { phone } });
      setWait(RESEND_AFTER_SECONDS);
    } catch (caught) {
      setError(errorText(caught, t('app.error')));
    }
  };

  return (
    <form className="panel" onSubmit={(event) => void submit(event)} noValidate>
      <h1>{t('signIn.codeTitle')}</h1>
      <p>{t('signIn.codeSent', { phone: displayPhone(phone) })}</p>
      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}
      <div className="field">
        <label htmlFor="code">{t('signIn.codeLabel')}</label>
        <input
          ref={input}
          id="code"
          className="code-input"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          value={code}
          onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
          required
        />
      </div>
      <button type="submit" className="primary" disabled={busy || code.length !== 6}>
        {busy ? t('signIn.verifying') : t('signIn.verify')}
      </button>
      <div className="row">
        <button type="button" className="link" onClick={onChangeNumber}>
          {t('signIn.changeNumber')}
        </button>
        <button type="button" className="link" onClick={() => void resend()} disabled={wait > 0}>
          {wait > 0 ? t('signIn.resendIn', { count: wait }) : t('signIn.resend')}
        </button>
      </div>
    </form>
  );
}

function ChooseStep({
  selectionToken,
  patients,
}: {
  selectionToken: string;
  patients: PortalPatientOption[];
}): JSX.Element {
  const { t } = useTranslation();
  const { begin } = useSession();
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const open = async (patientId: string) => {
    setError(null);
    setOpening(patientId);

    try {
      await begin(
        await api<PortalSessionIssued>('/portal/auth/session', {
          method: 'POST',
          body: { selectionToken, patientId },
        }),
      );
    } catch (caught) {
      setError(errorText(caught, t('app.error')));
      setOpening(null);
    }
  };

  return (
    <section className="panel" aria-labelledby="choose-title">
      <h1 id="choose-title">{t('signIn.chooseTitle')}</h1>
      <p>{t('signIn.chooseIntro')}</p>
      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}
      <ul className="choices">
        {patients.map((patient) => (
          <li key={patient.id}>
            <button
              type="button"
              className="choice"
              onClick={() => void open(patient.id)}
              disabled={opening !== null}
            >
              <span className="choice__name">{patient.name}</span>
              <span className="muted">
                {opening === patient.id
                  ? t('signIn.opening')
                  : t(`signIn.relationship_${patient.relationship}`)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
