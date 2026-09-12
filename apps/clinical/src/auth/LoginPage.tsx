import { useState, type FormEvent } from 'react';
import type { AuthenticatedStaff } from '@health24/shared';
import { ApiError, postPublic } from '../api/client';
import { useAuth } from './AuthProvider';

type LoginResponse =
  | { status: 'mfa_required'; challengeToken: string }
  | {
      status: 'mfa_enrolment_required';
      challengeToken: string;
      otpauthUrl: string;
      secret: string;
    };

interface AuthenticatedResponse {
  accessToken: string;
  refreshToken: string;
  staff: AuthenticatedStaff;
  recoveryCodes?: string[];
}

type Step =
  | { name: 'credentials' }
  | { name: 'verify'; challengeToken: string }
  | { name: 'enrol'; challengeToken: string; otpauthUrl: string; secret: string }
  | { name: 'recovery-codes'; codes: string[]; session: AuthenticatedResponse };

/**
 * Sign-in.
 *
 * Three steps, because the API refuses to hand out a session for a password
 * alone. A clinician who has not yet enrolled a second factor is walked
 * through enrolment rather than being let in — a stolen password must not be
 * enough to open a patient record.
 */
export function LoginPage(): JSX.Element {
  const { completeSignIn } = useAuth();
  const [step, setStep] = useState<Step>({ name: 'credentials' });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submitCredentials = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);

    try {
      const result = await postPublic<LoginResponse>('/auth/login', { email, password });

      setStep(
        result.status === 'mfa_required'
          ? { name: 'verify', challengeToken: result.challengeToken }
          : {
              name: 'enrol',
              challengeToken: result.challengeToken,
              otpauthUrl: result.otpauthUrl,
              secret: result.secret,
            },
      );
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not sign in');
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async (event: FormEvent) => {
    event.preventDefault();
    if (step.name !== 'verify' && step.name !== 'enrol') return;

    setError(null);
    setBusy(true);

    try {
      const path = step.name === 'enrol' ? '/auth/mfa/enrol' : '/auth/mfa/verify';
      const session = await postPublic<AuthenticatedResponse>(path, {
        challengeToken: step.challengeToken,
        code: code.trim(),
      });

      // Recovery codes are shown exactly once. Signing the user straight in
      // would mean they scroll past the only copy they will ever get.
      if (session.recoveryCodes?.length) {
        setStep({ name: 'recovery-codes', codes: session.recoveryCodes, session });
        return;
      }

      completeSignIn(session);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not verify the code');
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <div className="login__panel">
        <div className="login__brand">
          <h1>Health24</h1>
          <p>Clinical records</p>
        </div>

        {error ? <p className="alert alert--error">{error}</p> : null}

        {step.name === 'credentials' ? (
          <form onSubmit={submitCredentials}>
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              autoFocus
            />

            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />

            <button type="submit" disabled={busy}>
              {busy ? 'Checking…' : 'Continue'}
            </button>
          </form>
        ) : null}

        {step.name === 'enrol' ? (
          <form onSubmit={submitCode}>
            <h2>Set up your authenticator</h2>
            <p className="muted">
              Scan this in an authenticator app, or enter the key by hand. You will need a code from
              it every time you sign in.
            </p>

            <div className="secret-box">
              <code>{step.secret}</code>
            </div>

            <p className="muted small">
              If your app supports links:{' '}
              <a href={step.otpauthUrl} rel="noreferrer">
                open setup link
              </a>
            </p>

            <label htmlFor="code">6-digit code</label>
            <input
              id="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              maxLength={6}
              required
              autoFocus
            />

            <button type="submit" disabled={busy}>
              {busy ? 'Verifying…' : 'Confirm and sign in'}
            </button>
          </form>
        ) : null}

        {step.name === 'verify' ? (
          <form onSubmit={submitCode}>
            <h2>Enter your code</h2>
            <p className="muted">From your authenticator app, or a recovery code.</p>

            <label htmlFor="code">Code</label>
            <input
              id="code"
              autoComplete="one-time-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              required
              autoFocus
            />

            <button type="submit" disabled={busy}>
              {busy ? 'Verifying…' : 'Sign in'}
            </button>
          </form>
        ) : null}

        {step.name === 'recovery-codes' ? (
          <div>
            <h2>Save your recovery codes</h2>
            <p className="alert alert--warning">
              These are shown once and never again. Each one works a single time, and they are the
              only way back in if you lose your phone.
            </p>

            <ul className="recovery-codes">
              {step.codes.map((recoveryCode) => (
                <li key={recoveryCode}>
                  <code>{recoveryCode}</code>
                </li>
              ))}
            </ul>

            <button type="button" onClick={() => completeSignIn(step.session)}>
              I have saved them — continue
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
