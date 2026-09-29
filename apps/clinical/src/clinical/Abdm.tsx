import { useId, useState } from 'react';
import { hasPermission, type AbhaVerificationMethod, type CareContextState } from '@health24/shared';
import { ApiError } from '../api/client';
import {
  useAbdmConsents,
  useCareContexts,
  useConfirmAbhaVerification,
  useConfirmCareContextLink,
  useOfferCareContextLink,
  usePatientAbha,
  useStartAbhaVerification,
  useUnlinkCareContext,
} from '../api/abdm';
import { useAuth } from '../auth/AuthProvider';
import { formatDate } from './format';

/**
 * ABDM, as the desk sees it (sp8-plan.md, T31).
 *
 * Two things, and the screen keeps them apart because they are different
 * decisions. **Verifying an ABHA** records who somebody is. **Sharing a
 * visit** tells the national network that this hospital holds a record of it,
 * and every other hospital in the country can then ask the patient for it.
 *
 * Both end with the patient reading a code back, and the screen says so
 * before either is started — a member of staff who thinks they can do this
 * alone will get as far as a code they cannot supply.
 */

const errorText = (caught: unknown, fallback: string) =>
  caught instanceof ApiError ? caught.message : fallback;

const METHODS: Array<{ value: AbhaVerificationMethod; label: string }> = [
  { value: 'mobile_otp', label: 'Code to the mobile on their ABHA' },
  { value: 'aadhaar_otp', label: 'Code to the mobile on their Aadhaar' },
];

export function PatientAbdm({ patientId }: { patientId: string }): JSX.Element {
  const { staff } = useAuth();
  const canLink = staff ? hasPermission(staff.role, 'abdm:link') : false;
  const canVerify = staff ? hasPermission(staff.role, 'patient:abha_verify') : false;

  return (
    <div className="clinical-record">
      <AbhaIdentitySection patientId={patientId} canVerify={canVerify} />
      <CareContextsSection patientId={patientId} canLink={canLink} />
      <AbdmConsentsSection patientId={patientId} />
    </div>
  );
}

function AbhaIdentitySection({
  patientId,
  canVerify,
}: {
  patientId: string;
  canVerify: boolean;
}): JSX.Element {
  const identity = usePatientAbha(patientId);
  const start = useStartAbhaVerification(patientId);
  const confirm = useConfirmAbhaVerification(patientId);
  const id = useId();

  const [method, setMethod] = useState<AbhaVerificationMethod>('mobile_otp');
  const [address, setAddress] = useState('');
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState<{ transactionId: string; sentTo: string | null } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (identity.isPending) return <section className="panel">Loading…</section>;
  if (identity.isError) return <section className="panel">ABHA is not available here.</section>;

  const record = identity.data;

  const startVerification = async () => {
    setError(null);
    try {
      const issued = await start.mutateAsync({ abhaAddress: address.trim(), method });
      setChallenge({ transactionId: issued.transactionId, sentTo: issued.sentTo });
    } catch (caught) {
      setError(errorText(caught, 'The registry could not be reached.'));
    }
  };

  const confirmVerification = async () => {
    setError(null);
    try {
      await confirm.mutateAsync({ transactionId: challenge!.transactionId, code: code.trim() });
      setChallenge(null);
      setCode('');
      setAddress('');
      setDone(true);
    } catch (caught) {
      setError(errorText(caught, 'That code was not accepted.'));
    }
  };

  return (
    <section className="panel">
      <h2>ABHA</h2>

      <dl className="details">
        <div>
          <dt>ABHA address</dt>
          <dd>{record.abhaAddress ?? '—'}</dd>
        </div>
        <div>
          <dt>ABHA number</dt>
          <dd>{record.abhaNumber ?? '—'}</dd>
        </div>
        <div>
          <dt>Confirmed</dt>
          <dd>
            {record.verified ? (
              <span className="status status--active">
                Verified with the patient
                {record.numberVerifiedAt || record.addressVerifiedAt
                  ? ` on ${formatDate(record.numberVerifiedAt ?? record.addressVerifiedAt!)}`
                  : ''}
              </span>
            ) : record.abhaAddress || record.abhaNumber ? (
              // The distinction the whole of SP8 Phase 1 is about.
              <span className="status status--cancelled">Typed at the desk, not confirmed</span>
            ) : (
              'No ABHA on this record'
            )}
          </dd>
        </div>
      </dl>

      {done ? <p className="alert alert--success">The ABHA is confirmed.</p> : null}

      {record.verified ? (
        <p className="muted">
          A confirmed ABHA cannot be edited. If the patient has a different one, verify that one
          instead.
        </p>
      ) : canVerify ? (
        <div className="stack">
          <p className="muted">
            The registry sends the patient a code. They have to be here to read it back.
          </p>

          {error ? (
            <p className="alert alert--error" role="alert">
              {error}
            </p>
          ) : null}

          {challenge ? (
            <div className="field">
              <label htmlFor={`${id}-code`}>
                Code the patient received{challenge.sentTo ? ` (sent to ${challenge.sentTo})` : ''}
              </label>
              <input
                id={`${id}-code`}
                inputMode="numeric"
                maxLength={8}
                value={code}
                onChange={(event) => setCode(event.target.value)}
              />
              <button type="button" onClick={() => void confirmVerification()} disabled={confirm.isPending}>
                Confirm ABHA
              </button>
            </div>
          ) : (
            <div className="field">
              <label htmlFor={`${id}-address`}>ABHA address</label>
              <input
                id={`${id}-address`}
                placeholder="name@abdm"
                value={address}
                onChange={(event) => setAddress(event.target.value)}
              />
              <label htmlFor={`${id}-method`}>Send the code to</label>
              <select
                id={`${id}-method`}
                value={method}
                onChange={(event) => setMethod(event.target.value as AbhaVerificationMethod)}
              >
                {METHODS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => void startVerification()}
                disabled={start.isPending || address.trim().length === 0}
              >
                Send the patient a code
              </button>
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}

function CareContextsSection({
  patientId,
  canLink,
}: {
  patientId: string;
  canLink: boolean;
}): JSX.Element {
  const visits = useCareContexts(patientId);
  const offer = useOfferCareContextLink(patientId);
  const confirm = useConfirmCareContextLink(patientId);
  const unlink = useUnlinkCareContext(patientId);
  const id = useId();

  const [chosen, setChosen] = useState<string[]>([]);
  const [code, setCode] = useState('');
  const [linkRequestId, setLinkRequestId] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (visits.isPending) return <section className="panel">Loading…</section>;
  if (visits.isError) return <section className="panel">Visits are not available here.</section>;

  const rows = visits.data;
  const shareable = rows.filter((visit) => visit.status !== 'linked');

  const toggle = (encounterId: string) =>
    setChosen((current) =>
      current.includes(encounterId)
        ? current.filter((candidate) => candidate !== encounterId)
        : [...current, encounterId],
    );

  const startLink = async () => {
    setError(null);
    try {
      const issued = await offer.mutateAsync(chosen);
      setLinkRequestId(issued.linkRequestId);
      setSentTo(issued.sentTo);
    } catch (caught) {
      setError(errorText(caught, 'The visits could not be offered.'));
    }
  };

  const finishLink = async () => {
    setError(null);
    try {
      await confirm.mutateAsync({ linkRequestId: linkRequestId!, code: code.trim() });
      setLinkRequestId(null);
      setChosen([]);
      setCode('');
    } catch (caught) {
      setError(errorText(caught, 'That code was not accepted.'));
    }
  };

  return (
    <section className="panel">
      <h2>Visits shared with ABDM</h2>
      <p className="muted">
        A shared visit can be found by any hospital in the country — they still need the
        patient&apos;s consent to read it. Nothing is shared until the patient answers a code.
      </p>

      {error ? (
        <p className="alert alert--error" role="alert">
          {error}
        </p>
      ) : null}

      {rows.length === 0 ? <p className="muted">No visits at this hospital yet.</p> : null}

      <ul className="list">
        {rows.map((visit) => (
          <VisitRow
            key={visit.encounterId}
            visit={visit}
            canLink={canLink}
            chosen={chosen.includes(visit.encounterId)}
            onToggle={() => toggle(visit.encounterId)}
            onUnlink={(reason) =>
              unlink.mutateAsync({ careContextId: visit.careContextId!, reason })
            }
          />
        ))}
      </ul>

      {canLink && shareable.length > 0 ? (
        linkRequestId ? (
          <div className="field">
            <label htmlFor={`${id}-link-code`}>
              Code the patient received{sentTo ? ` (sent to ${sentTo})` : ''}
            </label>
            <input
              id={`${id}-link-code`}
              inputMode="numeric"
              maxLength={8}
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
            <button type="button" onClick={() => void finishLink()} disabled={confirm.isPending}>
              Share these visits
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => void startLink()}
            disabled={offer.isPending || chosen.length === 0}
          >
            Ask the patient to share {chosen.length === 0 ? 'the selected visits' : `${String(chosen.length)} visit(s)`}
          </button>
        )
      ) : null}
    </section>
  );
}

/**
 * Who has been given this patient's records from here.
 *
 * Kept apart from the consent tab, which lists what this hospital may read of
 * somebody else's record. This is the other direction, and a list holding
 * both would say the opposite of the truth about half its rows.
 */
function AbdmConsentsSection({ patientId }: { patientId: string }): JSX.Element | null {
  const consents = useAbdmConsents(patientId);

  if (consents.isPending || consents.isError) return null;

  return (
    <section className="panel">
      <h2>Given to the national network</h2>

      {consents.data.length === 0 ? (
        <p className="muted">
          Nobody has been given this patient&apos;s records through ABDM.
        </p>
      ) : (
        <ul className="list">
          {consents.data.map((consent) => (
            <li key={consent.id} className="item">
              <div className="item__main">
                {consent.dataCategories.join(', ')}
                {consent.dateRangeFrom || consent.dateRangeTo
                  ? ` · ${consent.dateRangeFrom ?? 'the beginning'} to ${consent.dateRangeTo ?? 'today'}`
                  : ''}
              </div>
              <span
                className={`status ${consent.status === 'active' ? 'status--active' : 'status--cancelled'}`}
              >
                {consent.status === 'active'
                  ? `Until ${formatDate(consent.expiresAt)}`
                  : consent.status === 'revoked'
                    ? 'Ended'
                    : 'Expired'}
              </span>
            </li>
          ))}
        </ul>
      )}

      <p className="muted">
        The patient gives and ends these in their own ABHA app. Nothing here can grant one, and
        ending one here would not end it there.
      </p>
    </section>
  );
}

function VisitRow({
  visit,
  canLink,
  chosen,
  onToggle,
  onUnlink,
}: {
  visit: CareContextState;
  canLink: boolean;
  chosen: boolean;
  onToggle: () => void;
  onUnlink: (reason: string) => Promise<unknown>;
}): JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');

  const linked = visit.status === 'linked';

  return (
    <li className="item">
      <div className="item__main">
        {canLink && !linked ? (
          <label>
            <input type="checkbox" checked={chosen} onChange={onToggle} /> {visit.display}
          </label>
        ) : (
          <span>{visit.display}</span>
        )}
      </div>

      <span className={`status ${linked ? 'status--active' : 'status--completed'}`}>
        {linked ? `Shared since ${formatDate(visit.linkedAt!)}` : 'Not shared'}
      </span>

      {linked && canLink ? (
        confirming ? (
          <div className="confirm">
            <p>Stop sharing this visit with ABDM?</p>
            <p className="muted">
              It stops being offered to other hospitals. A consent the patient already gave is
              ended in their ABHA app, not here.
            </p>
            <input
              aria-label="Why it is being unshared"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
            <button
              type="button"
              onClick={() => {
                void onUnlink(reason.trim() || 'The patient asked us to stop sharing it');
                setConfirming(false);
              }}
            >
              Stop sharing
            </button>
            <button type="button" className="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <button type="button" className="ghost" onClick={() => setConfirming(true)}>
            Stop sharing
          </button>
        )
      ) : null}
    </li>
  );
}
