import { useState } from 'react';
import { ERASURE_OUTCOMES, hasPermission, type ErasureOutcome, type ErasureQueueItem } from '@health24/shared';
import { ApiError } from '../api/client';
import { useDecideErasure, useErasureQueue } from '../api/privacy';
import { useAuth } from '../auth/AuthProvider';
import { formatDateTime } from '../clinical/format';

const OUTCOME_LABELS: Record<ErasureOutcome, string> = {
  erased: 'Erased what could be erased',
  partly_erased: 'Erased in part; some records kept',
  refused: 'Refused; nothing erased',
};

const errorText = (caught: unknown, fallback: string) =>
  caught instanceof ApiError ? caught.message : fallback;

/**
 * Erasure requests under the DPDP Act (SP5, Decision N1).
 *
 * The officer sees that a request exists and who made it, never the record it
 * is about. Deciding it ends the portal account, the emergency card, consents
 * in force and the contact details held for the patient; clinical records are
 * kept as law requires, and the note says so in words the patient reads.
 */
export function ErasureRequestsPage(): JSX.Element {
  const { staff } = useAuth();
  const queue = useErasureQueue();

  if (!staff || !hasPermission(staff.role, 'privacy:review')) {
    return <p className="muted">Erasure requests are decided by Health24’s data-protection officer.</p>;
  }

  const rows = queue.data ?? [];
  const waiting = rows.filter((row) => row.status === 'pending');
  const decided = rows.filter((row) => row.status === 'decided');

  return (
    <section className="card">
      <div className="section-heading">
        <h1>Erasure requests</h1>
      </div>
      <p className="small muted">
        Patients asking for their data to be erased. Clinical records are kept for as long as law
        requires; what is erased is the portal account, the emergency card, consents in force and
        the contact details held for reaching the patient.
      </p>

      {queue.isPending ? <p className="muted">Loading…</p> : null}
      {queue.isError ? <p className="alert alert--error">Could not load the queue.</p> : null}
      {queue.isSuccess && rows.length === 0 ? <p className="muted">No requests.</p> : null}

      {waiting.length > 0 ? (
        <ul className="entries">
          {waiting.map((row) => (
            <RequestEntry key={row.id} request={row} />
          ))}
        </ul>
      ) : null}

      {decided.length > 0 ? (
        <>
          <h2 className="small">Decided</h2>
          <ul className="entries">
            {decided.map((row) => (
              <RequestEntry key={row.id} request={row} />
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

function RequestEntry({ request }: { request: ErasureQueueItem }): JSX.Element {
  const decide = useDecideErasure();
  const [deciding, setDeciding] = useState(false);
  const [outcome, setOutcome] = useState<ErasureOutcome>('partly_erased');
  const [retentionNote, setRetentionNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    try {
      await decide.mutateAsync({ id: request.id, outcome, retentionNote: retentionNote.trim() });
      setDeciding(false);
    } catch (caught) {
      setError(errorText(caught, 'Could not record the decision'));
    }
  };

  return (
    <li className="entry">
      <div className="entry__header">
        <span>
          <strong>{request.requestedByPhone}</strong>{' '}
          <span className="small muted">request {request.id.slice(0, 8)}</span>
        </span>
        <span className="small muted">{formatDateTime(request.createdAt)}</span>
      </div>

      {request.reason ? <p className="small">The patient says: {request.reason}</p> : null}

      {request.status === 'decided' ? (
        <p className="small muted">
          {OUTCOME_LABELS[request.outcome ?? 'refused']} ·{' '}
          {request.decidedAt ? formatDateTime(request.decidedAt) : ''} by{' '}
          {request.decidedBy?.name ?? 'the officer'}
          {request.retentionNote ? ` · kept: ${request.retentionNote}` : ''}
          {request.erasedSummary ? ` · erased: ${request.erasedSummary}` : ''}
        </p>
      ) : null}

      {error ? <p className="alert alert--error">{error}</p> : null}

      {request.status === 'pending' ? (
        deciding ? (
          <div className="inline-form-block">
            <div className="field">
              <label htmlFor={`outcome-${request.id}`}>Decision</label>
              <select
                id={`outcome-${request.id}`}
                value={outcome}
                onChange={(event) => setOutcome(event.target.value as ErasureOutcome)}
              >
                {ERASURE_OUTCOMES.map((value) => (
                  <option key={value} value={value}>
                    {OUTCOME_LABELS[value]}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor={`retention-${request.id}`}>
                What is kept, and what law requires it? The patient reads this.
              </label>
              <input
                id={`retention-${request.id}`}
                value={retentionNote}
                onChange={(event) => setRetentionNote(event.target.value)}
                placeholder="e.g. clinical records are kept for 3 years under the Clinical Establishments Rules"
              />
            </div>
            <div className="row">
              <button
                type="button"
                disabled={retentionNote.trim().length < 10 || decide.isPending}
                onClick={() => void submit()}
              >
                {decide.isPending ? 'Recording…' : 'Record the decision'}
              </button>
              <button type="button" className="ghost" onClick={() => setDeciding(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button type="button" onClick={() => setDeciding(true)}>
            Decide…
          </button>
        )
      ) : null}
    </li>
  );
}
