import { useState } from 'react';
import { hasPermission, type CorrectionQueueItem } from '@health24/shared';
import { ApiError } from '../api/client';
import { useApplyCorrection, useCorrectionQueue, useDeclineCorrection } from '../api/corrections';
import { useAuth } from '../auth/AuthProvider';
import { formatDate, formatDateTime } from '../clinical/format';

const FIELD_LABELS: Record<CorrectionQueueItem['field'], string> = {
  name: 'Name',
  date_of_birth: 'Date of birth',
  gender: 'Gender',
  phone: 'Mobile number',
  blood_group: 'Blood group',
  emergency_contact_name: 'Emergency contact’s name',
  emergency_contact_phone: 'Emergency contact’s number',
};

const STATUS: Record<CorrectionQueueItem['status'], { label: string; className: string }> = {
  pending: { label: 'Waiting', className: 'status--active' },
  applied: { label: 'Corrected', className: 'status--completed' },
  declined: { label: 'Declined', className: 'status--cancelled' },
};

const errorText = (caught: unknown, fallback: string) =>
  caught instanceof ApiError ? caught.message : fallback;

/**
 * Corrections patients have asked for in the portal (SP5, Decision N1).
 *
 * Applying one makes the ordinary demographic correction, with the patient's
 * request as its reason — so it lands in the patient's change history like any
 * other. Declining one says why, and the patient reads it in the portal.
 */
export function CorrectionRequestsPage(): JSX.Element {
  const { staff } = useAuth();
  const queue = useCorrectionQueue();

  if (!staff || !hasPermission(staff.role, 'patient:update')) {
    return <p className="muted">Correction requests are handled by the desk and records staff.</p>;
  }

  const rows = queue.data ?? [];
  const waiting = rows.filter((row) => row.status === 'pending');
  const resolved = rows.filter((row) => row.status !== 'pending');

  return (
    <section className="card">
      <div className="section-heading">
        <h1>Correction requests</h1>
      </div>
      <p className="small muted">
        What patients have asked this hospital to correct about them, from the Health24 portal.
      </p>

      {queue.isPending ? <p className="muted">Loading…</p> : null}
      {queue.isError ? <p className="alert alert--error">Could not load the queue.</p> : null}
      {queue.isSuccess && rows.length === 0 ? (
        <p className="muted">No patient has asked for a correction.</p>
      ) : null}

      {waiting.length > 0 ? (
        <ul className="entries">
          {waiting.map((row) => (
            <RequestEntry key={row.id} request={row} />
          ))}
        </ul>
      ) : null}

      {resolved.length > 0 ? (
        <>
          <h2 className="small">Recently answered</h2>
          <ul className="entries">
            {resolved.map((row) => (
              <RequestEntry key={row.id} request={row} />
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

function RequestEntry({ request }: { request: CorrectionQueueItem }): JSX.Element {
  const apply = useApplyCorrection();
  const decline = useDeclineCorrection();
  const [declining, setDeclining] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
      setDeclining(false);
    } catch (caught) {
      setError(errorText(caught, 'Could not answer the request'));
    }
  };

  return (
    <li className="entry">
      <div className="entry__header">
        <span>
          <strong>{request.patient.name}</strong>{' '}
          <span className="small muted">{request.patient.mrn ?? ''}</span>{' '}
          <span className={`status ${STATUS[request.status].className}`}>
            {STATUS[request.status].label}
          </span>
        </span>
        <span className="small muted">{formatDate(request.createdAt)}</span>
      </div>

      <p className="small">
        <strong>{FIELD_LABELS[request.field]}</strong>: “{request.currentValue ?? 'nothing recorded'}”
        should be “{request.requestedValue}”
      </p>
      {request.note ? <p className="small muted">The patient says: {request.note}</p> : null}
      {request.status !== 'pending' ? (
        <p className="small muted">
          {STATUS[request.status].label} {request.resolvedAt ? formatDateTime(request.resolvedAt) : ''}{' '}
          by {request.resolvedBy?.name ?? 'staff'}
          {request.resolutionNote ? `: ${request.resolutionNote}` : ''}
        </p>
      ) : null}

      {error ? <p className="alert alert--error">{error}</p> : null}

      {request.status === 'pending' ? (
        declining ? (
          <div className="inline-form-block">
            <div className="field">
              <label htmlFor={`decline-${request.id}`}>
                Why is it not being corrected? The patient reads this.
              </label>
              <input
                id={`decline-${request.id}`}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="e.g. please bring an identity document to the desk"
              />
            </div>
            <div className="row">
              <button
                type="button"
                className="danger"
                disabled={note.trim().length < 3 || decline.isPending}
                onClick={() => void run(() => decline.mutateAsync({ id: request.id, note: note.trim() }))}
              >
                {decline.isPending ? 'Declining…' : 'Decline'}
              </button>
              <button type="button" className="ghost" onClick={() => setDeclining(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="row">
            <button
              type="button"
              disabled={apply.isPending}
              onClick={() => void run(() => apply.mutateAsync({ id: request.id }))}
            >
              {apply.isPending ? 'Correcting…' : 'Make the correction'}
            </button>
            <button type="button" className="ghost" onClick={() => setDeclining(true)}>
              Decline…
            </button>
          </div>
        )
      ) : null}
    </li>
  );
}
