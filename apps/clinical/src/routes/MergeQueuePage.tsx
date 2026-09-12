import { useState } from 'react';
import { ApiError } from '../api/client';
import { useMergeQueue, useResolveMerge, type MergeQueueEntry } from '../api/hooks';

/**
 * The duplicate review queue.
 *
 * Everything here is masked until a decision is made, because one side of a
 * pairing may be a patient this hospital has never treated. A records clerk
 * needs enough to recognise a duplicate, not a window into another hospital's
 * register.
 *
 * Merging is deliberately more work than rejecting. Rejecting says "two
 * different people" and is harmless if wrong — the pair simply resurfaces.
 * Merging fuses two histories, and if it is wrong a clinician may read one
 * person's record believing it is another's.
 */
export function MergeQueuePage(): JSX.Element {
  const queue = useMergeQueue(true);
  const resolve = useResolveMerge();

  const [active, setActive] = useState<string | null>(null);
  const [keepPatientId, setKeepPatientId] = useState<string>('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const act = async (entry: MergeQueueEntry, decision: 'merge' | 'reject') => {
    setError(null);

    try {
      await resolve.mutateAsync({
        id: entry.id,
        decision,
        reason: reason.trim(),
        ...(decision === 'merge' ? { keepPatientId } : {}),
      });

      setActive(null);
      setReason('');
      setKeepPatientId('');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not resolve this pairing');
    }
  };

  if (queue.isPending) return <div className="page">Loading…</div>;

  return (
    <div className="page">
      <h1>Possible duplicates</h1>
      <p className="muted">
        Records that may describe the same person. Nothing is merged automatically below a very high
        confidence, because merging the wrong two people gives one patient another&apos;s history.
      </p>

      {error ? <p className="alert alert--error">{error}</p> : null}

      {queue.data?.length === 0 ? (
        <div className="empty">
          <p>Nothing waiting for review.</p>
        </div>
      ) : null}

      <ul className="queue">
        {queue.data?.map((entry) => (
          <li key={entry.id} className="queue__item">
            <div className="queue__header">
              <strong>{Math.round(entry.score * 100)}% confidence</strong>
              <span className="muted small">
                matched on {entry.matchedOn.join(', ') || 'weak similarity'} · found{' '}
                {new Date(entry.detectedAt).toLocaleDateString()}
              </span>
            </div>

            <div className="queue__pair">
              {entry.patients.map((patient) => (
                <label key={patient.patientId} className="queue__candidate">
                  <input
                    type="radio"
                    name={`keep-${entry.id}`}
                    value={patient.patientId}
                    checked={active === entry.id && keepPatientId === patient.patientId}
                    onChange={() => {
                      setActive(entry.id);
                      setKeepPatientId(patient.patientId);
                    }}
                  />
                  <span>
                    <strong>{patient.maskedName}</strong>
                    <span className="muted small">
                      {patient.gender ?? 'unknown'}
                      {patient.yearOfBirth ? ` · born ${patient.yearOfBirth}` : ''}
                      {patient.maskedPhone ? ` · ${patient.maskedPhone}` : ''}
                    </span>
                  </span>
                </label>
              ))}
            </div>

            {active === entry.id ? (
              <div className="queue__decision">
                <label htmlFor={`reason-${entry.id}`}>Reason for this decision</label>
                <input
                  id={`reason-${entry.id}`}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="e.g. same person, registered twice in error"
                />

                <div className="row">
                  <button
                    type="button"
                    onClick={() => void act(entry, 'merge')}
                    disabled={!keepPatientId || reason.trim().length < 3 || resolve.isPending}
                  >
                    Merge into the selected record
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => void act(entry, 'reject')}
                    disabled={reason.trim().length < 3 || resolve.isPending}
                  >
                    Different people
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => {
                      setActive(null);
                      setKeepPatientId('');
                      setReason('');
                    }}
                  >
                    Cancel
                  </button>
                </div>

                <p className="muted small">
                  A merge can be undone, but a clinician may read the merged record in the meantime.
                  Choose the record to keep carefully.
                </p>
              </div>
            ) : (
              <button type="button" className="ghost" onClick={() => setActive(entry.id)}>
                Review this pair
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
