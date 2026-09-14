import { useState } from 'react';
import {
  CLINICAL_DATA_CATEGORIES,
  hasPermission,
  type ClinicalDataCategory,
  type ConsentSummary,
} from '@health24/shared';
import { ApiError } from '../api/client';
import {
  CATEGORY_LABELS,
  useBreakGlass,
  usePatientConsents,
  useRecordConsent,
  useRevokeConsent,
} from '../api/consent';
import { useAuth } from '../auth/AuthProvider';
import { formatDate, formatDateTime } from './format';

const VALIDITY_OPTIONS = [
  { days: 30, label: '1 month' },
  { days: 90, label: '3 months' },
  { days: 180, label: '6 months' },
  { days: 365, label: '1 year' },
];

const EMERGENCY_HOURS = [1, 2, 4, 8, 12, 24];

const STATUS_CLASS: Record<ConsentSummary['status'], string> = {
  active: 'status--active',
  expired: 'status--completed',
  revoked: 'status--stopped',
};

const errorText = (caught: unknown, fallback: string) =>
  caught instanceof ApiError ? caught.message : fallback;

/**
 * What this hospital may see of the patient's records at other hospitals, on
 * their registry page.
 *
 * Consent is asked of the patient in person, at this desk (Decision A1). The
 * front desk records it; a clinician may instead take emergency access, which
 * the hospital reviews afterwards.
 */
export function PatientSharing({ patientId }: { patientId: string }): JSX.Element | null {
  const { staff } = useAuth();

  if (!staff || !hasPermission(staff.role, 'consent:read')) return null;

  return (
    <SharingSection
      patientId={patientId}
      canRecord={hasPermission(staff.role, 'consent:record')}
      canBreakGlass={hasPermission(staff.role, 'consent:break_glass')}
    />
  );
}

function SharingSection({
  patientId,
  canRecord,
  canBreakGlass,
}: {
  patientId: string;
  canRecord: boolean;
  canBreakGlass: boolean;
}): JSX.Element {
  const consents = usePatientConsents(patientId);
  const [mode, setMode] = useState<'idle' | 'consent' | 'emergency'>('idle');

  const rows = consents.data ?? [];
  const current = rows.filter((consent) => consent.status === 'active');
  const past = rows.filter((consent) => consent.status !== 'active');

  return (
    <section className="card">
      <h2>Records from other hospitals</h2>
      <p className="muted small">
        Other hospitals&apos; records of this patient are shown here only while the patient&apos;s
        consent, recorded at this hospital, covers them.
      </p>

      {consents.isPending ? <p className="muted">Loading…</p> : null}
      {consents.isError ? (
        <p className="alert alert--error">Could not load this patient&apos;s consents.</p>
      ) : null}

      {consents.isSuccess && current.length === 0 ? (
        <p className="sharing-note small">
          Nothing is shared with your hospital at present. Only your hospital&apos;s own records are
          shown.
        </p>
      ) : null}

      {current.length > 0 ? (
        <ul className="consents">
          {current.map((consent) => (
            <ConsentItem key={consent.id} consent={consent} canRevoke={canRecord} />
          ))}
        </ul>
      ) : null}

      {mode === 'consent' ? (
        <RecordConsentForm patientId={patientId} onDone={() => setMode('idle')} />
      ) : null}
      {mode === 'emergency' ? (
        <BreakGlassForm patientId={patientId} onDone={() => setMode('idle')} />
      ) : null}

      {mode === 'idle' ? (
        <div className="row">
          {canRecord ? (
            <button type="button" onClick={() => setMode('consent')}>
              Record consent
            </button>
          ) : null}
          {canBreakGlass ? (
            <button type="button" className="ghost" onClick={() => setMode('emergency')}>
              Emergency access
            </button>
          ) : null}
        </div>
      ) : null}

      {past.length > 0 ? (
        <details className="consent-history">
          <summary>Earlier consents ({past.length})</summary>
          <ul className="consents">
            {past.map((consent) => (
              <ConsentItem key={consent.id} consent={consent} canRevoke={false} />
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

function ConsentItem({
  consent,
  canRevoke,
}: {
  consent: ConsentSummary;
  canRevoke: boolean;
}): JSX.Element {
  const revoke = useRevokeConsent();
  const [revoking, setRevoking] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const emergency = consent.captureMethod === 'break_glass';

  const submit = async () => {
    setError(null);

    try {
      await revoke.mutateAsync({ id: consent.id, reason: reason.trim() });
      setRevoking(false);
    } catch (caught) {
      setError(errorText(caught, 'Could not revoke the consent'));
    }
  };

  const classes = [
    'consent',
    emergency ? 'consent--emergency' : '',
    consent.status === 'active' ? '' : 'consent--inactive',
  ];

  return (
    <li className={classes.filter(Boolean).join(' ')}>
      <div className="consent__header">
        <span>
          {emergency ? <em className="tag tag--emergency">Emergency access</em> : null}
          <span className={`status ${STATUS_CLASS[consent.status]}`}>{consent.status}</span>
        </span>
        <span className="small muted">
          {consent.status === 'active'
            ? 'until'
            : consent.status === 'expired'
              ? 'expired'
              : 'was granted until'}{' '}
          {emergency ? formatDateTime(consent.expiresAt) : formatDate(consent.expiresAt)}
        </span>
      </div>

      {emergency ? (
        <p className="small">
          <strong>Reason:</strong> {consent.emergencyReason}
        </p>
      ) : (
        <div className="chips">
          {consent.dataCategories.map((category) => (
            <span key={category} className="chip">
              {CATEGORY_LABELS[category]}
            </span>
          ))}
        </div>
      )}

      <p className="small muted">
        {emergency
          ? `Taken by ${consent.recordedBy.name ?? 'a clinician'}`
          : consent.captureMethod === 'verbal_witnessed'
            ? `Given verbally, witnessed by ${consent.witnessName}; recorded by ${consent.recordedBy.name ?? 'staff'}`
            : `Signed consent form; recorded by ${consent.recordedBy.name ?? 'staff'}`}{' '}
        on {formatDate(consent.grantedAt)}
        {consent.dateRangeFrom || consent.dateRangeTo
          ? ` · covers records from ${consent.dateRangeFrom ?? 'the beginning'} to ${consent.dateRangeTo ?? 'today'}`
          : ''}
      </p>

      {consent.status === 'revoked' ? (
        <p className="small muted">
          Revoked {consent.revokedAt ? formatDate(consent.revokedAt) : ''}
          {consent.revokedBy?.name ? ` by ${consent.revokedBy.name}` : ''}:{' '}
          {consent.revocationReason}
        </p>
      ) : null}

      {emergency && consent.review ? (
        <p className="small muted">
          Reviewed as {consent.review.outcome} by {consent.review.reviewedBy.name ?? 'an admin'}:{' '}
          {consent.review.note}
        </p>
      ) : null}

      {canRevoke && consent.status === 'active' ? (
        revoking ? (
          <div className="inline-form">
            {error ? <p className="alert alert--error">{error}</p> : null}
            <div className="field">
              <label htmlFor={`revoke-${consent.id}`}>
                {emergency ? 'Why is emergency access being ended?' : 'Why is it being revoked?'}
              </label>
              <input
                id={`revoke-${consent.id}`}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder={emergency ? 'e.g. patient stable' : 'e.g. patient withdrew consent'}
              />
            </div>
            <div className="row">
              <button
                type="button"
                onClick={() => void submit()}
                disabled={reason.trim().length < 3 || revoke.isPending}
              >
                {revoke.isPending ? 'Revoking…' : emergency ? 'End access' : 'Revoke consent'}
              </button>
              <button type="button" className="ghost" onClick={() => setRevoking(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="ghost small" onClick={() => setRevoking(true)}>
            {emergency ? 'End emergency access' : 'Revoke'}
          </button>
        )
      ) : null}
    </li>
  );
}

function RecordConsentForm({
  patientId,
  onDone,
}: {
  patientId: string;
  onDone: () => void;
}): JSX.Element {
  const record = useRecordConsent(patientId);

  const [categories, setCategories] = useState<ClinicalDataCategory[]>([]);
  const [validForDays, setValidForDays] = useState(180);
  const [captureMethod, setCaptureMethod] = useState<'signed_form' | 'verbal_witnessed'>(
    'signed_form',
  );
  const [witnessName, setWitnessName] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (category: ClinicalDataCategory) =>
    setCategories((selected) =>
      selected.includes(category)
        ? selected.filter((value) => value !== category)
        : [...selected, category],
    );

  const needsWitness = captureMethod === 'verbal_witnessed';
  const ready =
    categories.length > 0 && agreed && (!needsWitness || witnessName.trim().length >= 2);

  const submit = async () => {
    setError(null);

    try {
      await record.mutateAsync({
        // In the order the patient reads them, not the order they were ticked.
        dataCategories: CLINICAL_DATA_CATEGORIES.filter((value) => categories.includes(value)),
        validForDays,
        captureMethod,
        witnessName: needsWitness ? witnessName.trim() : undefined,
      });
      onDone();
    } catch (caught) {
      setError(errorText(caught, 'Could not record the consent'));
    }
  };

  return (
    <div className="form consent-form">
      <h3>Record the patient&apos;s consent</h3>
      <p className="small muted">
        Ask the patient which of their records at other hospitals they agree to share with this
        hospital, and for how long.
      </p>
      {error ? <p className="alert alert--error">{error}</p> : null}

      <fieldset className="field">
        <legend>Records to share</legend>
        <div className="checkbox-grid">
          {CLINICAL_DATA_CATEGORIES.map((category) => (
            <label key={category} className="checkbox">
              <input
                type="checkbox"
                checked={categories.includes(category)}
                onChange={() => toggle(category)}
              />
              {CATEGORY_LABELS[category]}
            </label>
          ))}
        </div>
        <div className="row row--tight">
          <button
            type="button"
            className="ghost small"
            onClick={() => setCategories([...CLINICAL_DATA_CATEGORIES])}
          >
            Select all
          </button>
          <button type="button" className="ghost small" onClick={() => setCategories([])}>
            Clear
          </button>
        </div>
      </fieldset>

      <div className="form-grid">
        <div className="field">
          <label htmlFor="consent-validity">Valid for</label>
          <select
            id="consent-validity"
            value={validForDays}
            onChange={(event) => setValidForDays(Number(event.target.value))}
          >
            {VALIDITY_OPTIONS.map((option) => (
              <option key={option.days} value={option.days}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="consent-method">How consent was given</label>
          <select
            id="consent-method"
            value={captureMethod}
            onChange={(event) =>
              setCaptureMethod(event.target.value as 'signed_form' | 'verbal_witnessed')
            }
          >
            <option value="signed_form">Signed consent form</option>
            <option value="verbal_witnessed">Verbally, before a witness</option>
          </select>
        </div>
        {needsWitness ? (
          <div className="field">
            <label htmlFor="consent-witness">Witness name</label>
            <input
              id="consent-witness"
              value={witnessName}
              onChange={(event) => setWitnessName(event.target.value)}
            />
          </div>
        ) : null}
      </div>

      <label className="checkbox">
        <input
          type="checkbox"
          checked={agreed}
          onChange={(event) => setAgreed(event.target.checked)}
        />
        The patient agreed to this in person
      </label>

      <div className="row">
        <button type="button" onClick={() => void submit()} disabled={!ready || record.isPending}>
          {record.isPending ? 'Recording…' : 'Record consent'}
        </button>
        <button type="button" className="ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function BreakGlassForm({
  patientId,
  onDone,
}: {
  patientId: string;
  onDone: () => void;
}): JSX.Element {
  const breakGlass = useBreakGlass(patientId);

  const [reason, setReason] = useState('');
  const [hours, setHours] = useState(4);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);

    try {
      await breakGlass.mutateAsync({ reason: reason.trim(), hours });
      onDone();
    } catch (caught) {
      setError(errorText(caught, 'Could not open emergency access'));
    }
  };

  return (
    <div className="form consent-form">
      <h3>Emergency access</h3>
      <p className="alert alert--warning">
        For when the patient cannot consent and their history is needed now. It opens every record
        other hospitals hold for this patient to your hospital, for the hours you choose. Your
        reason is recorded, reviewed by your hospital, and will be shown to the patient.
      </p>
      {error ? <p className="alert alert--error">{error}</p> : null}

      <div className="field">
        <label htmlFor="break-glass-reason">Why is emergency access needed?</label>
        <textarea
          id="break-glass-reason"
          rows={3}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="e.g. brought in unconscious; allergy and medication history needed before surgery"
        />
      </div>

      <div className="field page-header__control">
        <label htmlFor="break-glass-hours">For</label>
        <select
          id="break-glass-hours"
          value={hours}
          onChange={(event) => setHours(Number(event.target.value))}
        >
          {EMERGENCY_HOURS.map((value) => (
            <option key={value} value={value}>
              {value === 1 ? '1 hour' : `${value} hours`}
            </option>
          ))}
        </select>
      </div>

      <div className="row">
        <button
          type="button"
          onClick={() => void submit()}
          disabled={reason.trim().length < 10 || breakGlass.isPending}
        >
          {breakGlass.isPending ? 'Opening…' : 'Open emergency access'}
        </button>
        <button type="button" className="ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}
