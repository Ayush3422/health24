import { useState } from 'react';
import { hasPermission, type GuardianRelation, type PortalAccessSummary } from '@health24/shared';
import { ApiError } from '../api/client';
import {
  useActivatePortalAccess,
  useLinkGuardian,
  usePortalAccess,
  useRevokePortalAccess,
} from '../api/portal';
import { useAuth } from '../auth/AuthProvider';
import { formatDate, formatDateTime } from './format';

const RELATIONS: Array<{ value: GuardianRelation; label: string }> = [
  { value: 'mother', label: 'Mother' },
  { value: 'father', label: 'Father' },
  { value: 'legal_guardian', label: 'Legal guardian' },
];

const relationLabel = (relation: GuardianRelation) =>
  RELATIONS.find((option) => option.value === relation)?.label ?? relation;

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

  return (
    <PortalAccessSection
      patientId={patientId}
      defaultPhone={defaultPhone}
      canLinkGuardian={hasPermission(staff.role, 'portal:link_guardian')}
    />
  );
}

function PortalAccessSection({
  patientId,
  defaultPhone,
  canLinkGuardian,
}: {
  patientId: string;
  defaultPhone: string | null;
  canLinkGuardian: boolean;
}): JSX.Element {
  const access = usePortalAccess(patientId);
  const activate = useActivatePortalAccess(patientId);
  const [activating, setActivating] = useState(false);
  const [linking, setLinking] = useState(false);
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
        <span className="row">
          {!activating ? (
            <button type="button" className="ghost" onClick={() => setActivating(true)}>
              Activate portal access
            </button>
          ) : null}
          {canLinkGuardian && !linking ? (
            <button type="button" className="ghost" onClick={() => setLinking(true)}>
              Link a guardian
            </button>
          ) : null}
        </span>
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

      {linking ? <GuardianForm patientId={patientId} onDone={() => setLinking(false)} /> : null}

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
          {access.guardian ? <em className="tag">Guardian</em> : null}{' '}
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
        {access.guardian
          ? ` · ${access.guardian.name} (${relationLabel(access.guardian.relation)}), ${access.guardian.documentChecked} checked`
          : ''}
        {access.guardian && access.endsAt
          ? ` · ${access.status === 'active' ? 'until' : 'ended'} ${formatDate(access.endsAt)}, the child’s 18th birthday`
          : ''}
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

/**
 * A child's record linked to a guardian's phone (SP5, Decision M1). The desk
 * checks the relationship and a document in person; the link ends by itself on
 * the child's 18th birthday.
 */
function GuardianForm({ patientId, onDone }: { patientId: string; onDone: () => void }): JSX.Element {
  const link = useLinkGuardian(patientId);
  const [name, setName] = useState('');
  const [relation, setRelation] = useState<GuardianRelation>('mother');
  const [phone, setPhone] = useState('');
  const [checkedDocument, setCheckedDocument] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    try {
      await link.mutateAsync({
        phone: phone.trim(),
        guardianName: name.trim(),
        guardianRelation: relation,
        documentChecked: checkedDocument.trim(),
        relationshipConfirmed: true,
      });
      onDone();
    } catch (caught) {
      setError(errorText(caught, 'Could not link the guardian'));
    }
  };

  const ready =
    confirmed && name.trim().length >= 2 && checkedDocument.trim().length >= 3 && phone.trim().length >= 10;

  return (
    <div className="inline-form-block">
      <p className="small muted">
        For a child under 18 whose date of birth is recorded. The guardian signs in with their own
        phone and can see the child’s record and manage their consents, until the child’s 18th
        birthday.
      </p>
      {error ? <p className="alert alert--error">{error}</p> : null}
      <div className="field">
        <label htmlFor="guardian-name">Guardian’s name</label>
        <input
          id="guardian-name"
          autoComplete="off"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="guardian-relation">Relationship to the child</label>
        <select
          id="guardian-relation"
          value={relation}
          onChange={(event) => setRelation(event.target.value as GuardianRelation)}
        >
          {RELATIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="guardian-phone">Guardian’s mobile number</label>
        <input
          id="guardian-phone"
          inputMode="tel"
          autoComplete="off"
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
          placeholder="e.g. 98200 12345"
        />
      </div>
      <div className="field">
        <label htmlFor="guardian-document">Document checked</label>
        <input
          id="guardian-document"
          autoComplete="off"
          value={checkedDocument}
          onChange={(event) => setCheckedDocument(event.target.value)}
          placeholder="e.g. birth certificate"
        />
      </div>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
        />
        I have checked, in person, that this person is the child’s guardian, and seen the document
        named above
      </label>
      <div className="row">
        <button type="button" onClick={() => void submit()} disabled={!ready || link.isPending}>
          {link.isPending ? 'Linking…' : 'Link guardian'}
        </button>
        <button type="button" className="ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}
