import { useState } from 'react';
import {
  hasPermission,
  WARD_KIND_LABELS,
  type Admission as AdmissionRecord,
} from '@health24/shared';
import { ApiError } from '../api/client';
import { useAdmission, useAdmit, useDischarge, useTransfer, useWards } from '../api/wards';
import { useAuth } from '../auth/AuthProvider';
import { formatDateTime } from './format';

const errorText = (caught: unknown, fallback: string) =>
  caught instanceof ApiError ? caught.message : fallback;

/**
 * Where the patient is, on the encounter that admitted them (sp6-plan.md,
 * Phase 3).
 *
 * The decision to admit is the encounter itself; this is the bed. A move ends
 * one stay and starts the next, and a discharge ends the stay and finishes the
 * encounter — both in one step, because they are one act.
 */
export function AdmissionPanel({
  encounterId,
  encounterClass,
  own,
}: {
  encounterId: string;
  encounterClass: string;
  /** Another hospital's encounter is read-only, and its beds are not ours. */
  own: boolean;
}): JSX.Element | null {
  const { staff } = useAuth();
  const admission = useAdmission(encounterId, own);

  if (!staff || !own) return null;
  if (encounterClass !== 'inpatient' && encounterClass !== 'emergency') return null;

  const canManage = hasPermission(staff.role, 'admission:manage');
  const record = admission.data;

  return (
    <section className="card">
      <div className="section-heading">
        <h2>Bed</h2>
        {record?.currentBed ? (
          <span className="small muted">
            {record.currentBed.wardName} · {record.currentBed.label} · {record.bedDays} bed-day
            {record.bedDays === 1 ? '' : 's'}
          </span>
        ) : null}
      </div>

      {admission.isError ? (
        <p className="alert alert--error">Could not load where the patient is.</p>
      ) : null}

      {record ? <StayHistory admission={record} /> : null}

      {canManage ? <BedActions encounterId={encounterId} admission={record ?? null} /> : null}
    </section>
  );
}

function StayHistory({ admission }: { admission: AdmissionRecord }): JSX.Element {
  if (admission.stays.length === 0) {
    return <p className="muted">This patient has not been given a bed yet.</p>;
  }

  return (
    <ul className="entries">
      {admission.stays.map((stay) => (
        <li key={stay.id} className="entry">
          <div className="entry__header">
            <strong>
              {stay.ward} · {stay.bed}
            </strong>{' '}
            <span className="tag">{WARD_KIND_LABELS[stay.wardKind]}</span>{' '}
            {stay.endedAt === null ? (
              <span className="status status--in_progress">Here now</span>
            ) : null}
          </div>
          <div className="small">
            {formatDateTime(stay.startedAt)} – {stay.endedAt ? formatDateTime(stay.endedAt) : 'now'}{' '}
            · {stay.bedDays} bed-day
            {stay.bedDays === 1 ? '' : 's'}
          </div>
          {stay.movedReason ? <p className="small entry__note">{stay.movedReason}</p> : null}
        </li>
      ))}
    </ul>
  );
}

function BedActions({
  encounterId,
  admission,
}: {
  encounterId: string;
  admission: AdmissionRecord | null;
}): JSX.Element {
  const wards = useWards();
  const admit = useAdmit();
  const transfer = useTransfer();
  const discharge = useDischarge();

  const [bedId, setBedId] = useState('');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [discharging, setDischarging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inBed = admission?.currentBed ?? null;
  const discharged = admission?.dischargedAt !== null && admission?.dischargedAt !== undefined;

  const free = (wards.data?.wards ?? [])
    .filter((ward) => ward.status === 'active')
    .flatMap((ward) =>
      ward.beds
        .filter((bed) => bed.occupant === null && bed.status === 'available')
        .map((bed) => ({ id: bed.id, label: `${ward.name} · ${bed.label}` })),
    );

  const busy = admit.isPending || transfer.isPending || discharge.isPending;

  const place = async () => {
    setError(null);
    try {
      if (inBed) {
        await transfer.mutateAsync({ encounterId, body: { bedId, reason: reason.trim() } });
        setReason('');
      } else {
        await admit.mutateAsync({ encounterId, bedId });
      }
      setBedId('');
    } catch (caught) {
      setError(errorText(caught, 'Could not give the patient that bed'));
    }
  };

  const send = async () => {
    setError(null);
    try {
      await discharge.mutateAsync({ encounterId, body: { note: note.trim() || undefined } });
      setDischarging(false);
      setNote('');
    } catch (caught) {
      setError(errorText(caught, 'Could not discharge the patient'));
    }
  };

  if (discharged) {
    return <p className="small muted">Discharged {formatDateTime(admission!.dischargedAt!)}.</p>;
  }

  return (
    <div className="inline-form">
      {error ? <p className="alert alert--error">{error}</p> : null}

      {discharging ? (
        <>
          <label htmlFor={`discharge-${encounterId}`}>How did the stay end? (optional)</label>
          <input
            id={`discharge-${encounterId}`}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="e.g. Discharged home, improving"
          />
          <div className="row">
            <button type="button" onClick={() => void send()} disabled={busy}>
              Discharge
            </button>
            <button type="button" className="ghost" onClick={() => setDischarging(false)}>
              Not yet
            </button>
          </div>
        </>
      ) : (
        <>
          <label htmlFor={`bed-${encounterId}`}>{inBed ? 'Move to' : 'Give a bed'}</label>
          <select
            id={`bed-${encounterId}`}
            value={bedId}
            onChange={(event) => setBedId(event.target.value)}
          >
            <option value="">{free.length === 0 ? 'No free beds' : 'Choose a free bed…'}</option>
            {free.map((bed) => (
              <option key={bed.id} value={bed.id}>
                {bed.label}
              </option>
            ))}
          </select>

          {inBed ? (
            <>
              <label htmlFor={`move-reason-${encounterId}`}>Why is the patient moving?</label>
              <input
                id={`move-reason-${encounterId}`}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Required, e.g. moved to the ICU"
              />
            </>
          ) : null}

          <div className="row">
            <button
              type="button"
              onClick={() => void place()}
              disabled={busy || bedId === '' || (inBed !== null && reason.trim().length < 3)}
            >
              {inBed ? 'Move the patient' : 'Admit to this bed'}
            </button>
            {inBed ? (
              <button type="button" className="ghost" onClick={() => setDischarging(true)}>
                Discharge…
              </button>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
