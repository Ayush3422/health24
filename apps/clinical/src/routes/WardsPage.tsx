import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  hasPermission,
  WARD_KINDS,
  WARD_KIND_LABELS,
  type BedSummary,
  type WardKind,
  type WardSummary,
} from '@health24/shared';
import { ApiError } from '../api/client';
import { useAddBeds, useCreateWard, useSetBedStatus, useUpdateWard, useWards } from '../api/wards';
import { useAuth } from '../auth/AuthProvider';
import { formatDateTime } from '../clinical/format';

const errorText = (caught: unknown, fallback: string) =>
  caught instanceof ApiError ? caught.message : fallback;

/**
 * The bed board (sp6-plan.md, Phase 3): every ward, every bed, and who is in
 * it. The hospital administrator sets the wards up; everyone who admits reads
 * the same board, which is drawn from the stays themselves rather than from a
 * status somebody remembered to change.
 */
export function WardsPage(): JSX.Element {
  const { staff } = useAuth();
  const wards = useWards();
  const [adding, setAdding] = useState(false);

  const canManage = Boolean(staff && hasPermission(staff.role, 'wards:manage'));
  const list = wards.data?.wards ?? [];

  const beds = list.flatMap((ward) => ward.beds);
  const occupied = beds.filter((bed) => bed.occupant !== null).length;
  const blocked = beds.filter((bed) => bed.status === 'blocked').length;

  return (
    <div className="page">
      <div className="page-header">
        <h1>Wards and beds</h1>
        {canManage && !adding ? (
          <button type="button" onClick={() => setAdding(true)}>
            Add a ward
          </button>
        ) : null}
      </div>

      {wards.isError ? (
        <p className="alert alert--error">{errorText(wards.error, 'Could not load the wards')}</p>
      ) : null}
      {wards.isPending ? <p>Loading…</p> : null}

      {adding ? <WardForm onDone={() => setAdding(false)} /> : null}

      {list.length > 0 ? (
        <p className="muted small">
          {occupied} of {beds.length} beds occupied
          {blocked > 0 ? `, ${blocked} out of service` : ''}.
        </p>
      ) : null}

      {wards.isSuccess && list.length === 0 && !adding ? (
        <p className="muted">
          {canManage
            ? 'No wards yet. Add one, with its beds, to start admitting patients.'
            : 'This hospital has no wards set up yet.'}
        </p>
      ) : null}

      {list.map((ward) => (
        <WardCard key={ward.id} ward={ward} canManage={canManage} />
      ))}
    </div>
  );
}

function WardCard({ ward, canManage }: { ward: WardSummary; canManage: boolean }): JSX.Element {
  const update = useUpdateWard();
  const addBeds = useAddBeds();
  const [labels, setLabels] = useState('');
  const [error, setError] = useState<string | null>(null);

  const close = async (status: 'active' | 'closed') => {
    setError(null);
    try {
      await update.mutateAsync({ id: ward.id, body: { status } });
    } catch (caught) {
      setError(errorText(caught, 'Could not change the ward'));
    }
  };

  const add = async () => {
    setError(null);
    const wanted = labels
      .split(/[\n,]/)
      .map((label) => label.trim())
      .filter(Boolean);

    if (wanted.length === 0) return;

    try {
      await addBeds.mutateAsync({ id: ward.id, body: { labels: wanted } });
      setLabels('');
    } catch (caught) {
      setError(errorText(caught, 'Could not add the beds'));
    }
  };

  return (
    <section className="card">
      <div className="section-heading">
        <h2>
          {ward.name} <span className="tag">{WARD_KIND_LABELS[ward.kind]}</span>{' '}
          {ward.status === 'closed' ? <span className="tag tag--danger">Closed</span> : null}
        </h2>
        <span className="small muted">
          {ward.occupied} occupied · {ward.free} free
        </span>
      </div>

      {error ? <p className="alert alert--error">{error}</p> : null}

      {ward.beds.length === 0 ? (
        <p className="muted">This ward has no beds yet.</p>
      ) : (
        <ul className="bed-board">
          {ward.beds.map((bed) => (
            <BedTile key={bed.id} bed={bed} canManage={canManage} />
          ))}
        </ul>
      )}

      {canManage ? (
        <div className="inline-form">
          <label htmlFor={`beds-${ward.id}`}>
            Add beds (one label per line, or comma separated)
          </label>
          <input
            id={`beds-${ward.id}`}
            value={labels}
            onChange={(event) => setLabels(event.target.value)}
            placeholder="G4, G5"
          />
          <div className="row">
            <button type="button" onClick={() => void add()} disabled={addBeds.isPending}>
              Add beds
            </button>
            {ward.status === 'active' ? (
              <button
                type="button"
                className="ghost"
                onClick={() => void close('closed')}
                disabled={update.isPending}
              >
                Close the ward
              </button>
            ) : (
              <button
                type="button"
                className="ghost"
                onClick={() => void close('active')}
                disabled={update.isPending}
              >
                Reopen the ward
              </button>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function BedTile({ bed, canManage }: { bed: BedSummary; canManage: boolean }): JSX.Element {
  const setStatus = useSetBedStatus();
  const [error, setError] = useState<string | null>(null);

  const change = async (status: 'available' | 'blocked') => {
    setError(null);
    try {
      await setStatus.mutateAsync({
        id: bed.id,
        body: status === 'blocked' ? { status, reason: 'Out of service' } : { status },
      });
    } catch (caught) {
      setError(errorText(caught, 'Could not change the bed'));
    }
  };

  const state = bed.occupant ? 'occupied' : bed.status === 'blocked' ? 'blocked' : 'free';

  return (
    <li className={`bed bed--${state}`}>
      <strong>{bed.label}</strong>
      {bed.occupant ? (
        <>
          <Link to={`/patients/${bed.occupant.patientId}`}>{bed.occupant.name}</Link>
          <span className="small muted">since {formatDateTime(bed.occupant.since)}</span>
        </>
      ) : (
        <span className="small muted">
          {bed.status === 'blocked' ? (bed.blockedReason ?? 'Out of service') : 'Free'}
        </span>
      )}

      {error ? <span className="small alert alert--error">{error}</span> : null}

      {canManage && !bed.occupant ? (
        <button
          type="button"
          className="ghost small"
          onClick={() => void change(bed.status === 'blocked' ? 'available' : 'blocked')}
          disabled={setStatus.isPending}
        >
          {bed.status === 'blocked' ? 'Back in service' : 'Take out of service'}
        </button>
      ) : null}
    </li>
  );
}

function WardForm({ onDone }: { onDone: () => void }): JSX.Element {
  const create = useCreateWard();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<WardKind>('general');
  const [beds, setBeds] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    try {
      await create.mutateAsync({
        name: name.trim(),
        kind,
        beds: beds
          .split(/[\n,]/)
          .map((label) => label.trim())
          .filter(Boolean),
      });
      onDone();
    } catch (caught) {
      setError(errorText(caught, 'Could not create the ward'));
    }
  };

  return (
    <div className="form card">
      <h3>Add a ward</h3>
      {error ? <p className="alert alert--error">{error}</p> : null}

      <div className="form-grid">
        <div className="field">
          <label htmlFor="ward-name">Name</label>
          <input
            id="ward-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. General ward"
          />
        </div>
        <div className="field">
          <label htmlFor="ward-kind">Kind</label>
          <select
            id="ward-kind"
            value={kind}
            onChange={(event) => setKind(event.target.value as WardKind)}
          >
            {WARD_KINDS.map((value) => (
              <option key={value} value={value}>
                {WARD_KIND_LABELS[value]}
              </option>
            ))}
          </select>
        </div>
        <div className="field field--wide">
          <label htmlFor="ward-beds">Beds (one label per line, or comma separated)</label>
          <input
            id="ward-beds"
            value={beds}
            onChange={(event) => setBeds(event.target.value)}
            placeholder="G1, G2, G3"
          />
        </div>
      </div>

      <div className="row">
        <button
          type="button"
          onClick={() => void submit()}
          disabled={name.trim().length === 0 || create.isPending}
        >
          {create.isPending ? 'Adding…' : 'Add the ward'}
        </button>
        <button type="button" className="ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}
