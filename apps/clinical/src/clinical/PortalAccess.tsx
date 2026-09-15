import { useState } from 'react';
import { hasPermission, type PortalAccessSummary } from '@health24/shared';
import { ApiError } from '../api/client';
import { usePortalAccess, useActivatePortalAccess, useRevokePortalAccess } from '../api/portal';
import { useAuth } from '../auth/AuthProvider';
import { formatDateTime } from './format';

const errorText = (caught: unknown, fallback: string) =>
  caught instanceof ApiError ? caught.message : fallback;

const STATUS: Record<PortalAccessSummary['status'], { label: string; className: string }> = {
  active: { label: 'Active', className: 'status--active' },
  ended: { label: 'Ended', className: 'status--completed' },
  revoked: { label: 'Revoked', className: 'status--cancelled' },
};

/**
 * The patient portal, turned on at the desk (SP5, Decision J1).
 *
 * A one-time code proves only that someone holds a phone. So portal access is
 * turned on by staff who can see the patient and have checked who they are —
 * and any hospital the patient is linked to can turn it off at once.
 */
export function PatientPortalAccess({
  patientId,
  defaultPhone,
}: {
  patientId: string;
  defaultPhone: string | null;
}): JSX.Element | null {
  const { staff } = useAuth();
  if (!staff || !hasPermission(staff.role, 'portal:activate')) return null;

  return <PortalAccessSection patientId={patientId} defaultPhone={defaultPhone} />;
}

function PortalAccessSection({
  patientId,
  defaultPhone,
}: {
  patientId: string;
  defaultPhone: string | null;
}): JSX.Element {
  const access = usePortalAccess(patientId);
  const activate = useActivatePortalAccess(patientId);
  const [activating, setActivating] = useState(false);
  const [phone, setPhone] = useState(defaultPhone ?? '');
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    try {
      await activate.mutateAsync(phone.trim());
      setActivating(false);
      setConfirmed(false);
    } catch (caught) {
      setError(errorText(caught, 'Could not activate portal access'));
    }
  };

  const rows = access.data ?? [];

  return (
    <section className="card">
      <div className="section-heading">
        <h2>Patient portal</h2>
        {!activating ? (
          <button type="button" className="ghost" onClick={() => setActivating(true)}>
            Activate portal access
          </button>
        ) : null}
      </div>
      <p className="small muted">
        The patient signs in on their phone with a one-time code sent to the number below. Turn
        the portal on only with the patient in front of you, after checking who they are — a
        family often shares one phone.
      </p>

      {activating ? (
        <div className="inline-form-block">
          {error ? <p className="alert alert--error">{error}</p> : null}
          <div className="field">
            <label htmlFor="portal-phone">Patient’s mobile number</label>
            <input
              id="portal-phone"
              inputMode="tel"
              autoComplete="off"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              placeholder="e.g. 98200 12345"
            />
          </div>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            I have checked, in person, that this is the patient, and that the number is theirs to
            use
          </label>
          <div className="row">
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!confirmed || phone.trim().length < 10 || activate.isPending}
            >
              {activate.isPending ? 'Activating…' : 'Activate'}
            </button>
            <button type="button" className="ghost" onClick={() => setActivating(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {access.isError ? (
        <p className="alert alert--error">Could not load portal access.</p>
      ) : null}
      {access.isSuccess && rows.length === 0 ? (
        <p className="muted">The portal is not activated for this patient.</p>
      ) : null}

      {rows.length > 0 ? (
        <ul className="entries">
          {rows.map((row) => (
            <AccessEntry key={row.id} patientId={patientId} access={row} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function AccessEntry({
  patientId,
  access,
}: {
  patientId: string;
  access: PortalAccessSummary;
}): JSX.Element {
  const revoke = useRevokePortalAccess(patientId);
  const [revoking, setRevoking] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    try {
      await revoke.mutateAsync({ id: access.id, reason: reason.trim() });
      setRevoking(false);
    } catch (caught) {
      setError(errorText(caught, 'Could not revoke portal access'));
    }
  };

  return (
    <li className="entry">
      <div className="entry__header">
        <span>
          <strong>{access.phone}</strong>{' '}
          <span className={`status ${STATUS[access.status].className}`}>
            {STATUS[access.status].label}
          </span>
        </span>
        {access.status === 'active' && !revoking ? (
          <button type="button" className="ghost small" onClick={() => setRevoking(true)}>
            Revoke…
          </button>
        ) : null}
      </div>
      <p className="small muted">
        Activated {formatDateTime(access.activatedAt)} by {access.activatedBy.name ?? 'staff'} at{' '}
        {access.activatedAtHospital.isOwn ? 'this hospital' : access.activatedAtHospital.name}
        {access.revokedAt
          ? ` · revoked ${formatDateTime(access.revokedAt)}: ${access.revokedReason}`
          : ''}
      </p>

      {revoking ? (
        <div className="inline-form-block">
          {error ? <p className="alert alert--error">{error}</p> : null}
          <div className="field">
            <label htmlFor={`portal-revoke-${access.id}`}>
              Why is portal access being revoked? The patient is signed out at once.
            </label>
            <input
              id={`portal-revoke-${access.id}`}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="e.g. patient reports a lost phone"
            />
          </div>
          <div className="row">
            <button
              type="button"
              className="danger"
              onClick={() => void submit()}
              disabled={reason.trim().length < 3 || revoke.isPending}
            >
              {revoke.isPending ? 'Revoking…' : 'Revoke access'}
            </button>
            <button type="button" className="ghost" onClick={() => setRevoking(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}
