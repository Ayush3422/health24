import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../api/client';
import { useSession } from '../session/SessionProvider';

/** Opens another record this phone may open: a family member, or a child. */
export function SwitchScreen(): JSX.Element {
  const { t } = useTranslation();
  const { me, switchTo } = useSession();
  const navigate = useNavigate();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const open = async (patientId: string) => {
    setError(null);
    setBusy(patientId);

    try {
      await switchTo(patientId);
      navigate('/');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('app.error'));
      setBusy(null);
    }
  };

  return (
    <section className="panel" aria-labelledby="switch-title">
      <h1 id="switch-title">{t('switch.title')}</h1>
      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}
      <ul className="choices">
        {(me?.patients ?? []).map((patient) => {
          const current = patient.id === me?.patient.id;

          return (
            <li key={patient.id}>
              <button
                type="button"
                className="choice"
                aria-current={current ? 'true' : undefined}
                disabled={current || busy !== null}
                onClick={() => void open(patient.id)}
              >
                <span className="choice__name">{patient.name}</span>
                <span className="muted">
                  {current
                    ? t('switch.current')
                    : busy === patient.id
                      ? t('signIn.opening')
                      : t(`signIn.relationship_${patient.relationship}`)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
