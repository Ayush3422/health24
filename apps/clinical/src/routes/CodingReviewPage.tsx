import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Coding, CodingReviewItem } from '@health24/shared';
import { ApiError } from '../api/client';
import { CODE_SYSTEM_LABELS } from '../api/clinical';
import { useAcknowledgeCodingReview, useCodingReviews } from '../api/consent';
import { formatDate } from '../clinical/format';

const codingText = (coding: Coding) =>
  `${CODE_SYSTEM_LABELS[coding.system] ?? coding.system} ${coding.display} (${coding.code})`;

/**
 * Diagnoses at this hospital whose attached translation or advisory code rests
 * on a mapping that has since been retired or rejected.
 *
 * The diagnosis still shows what was attached when it was recorded. A
 * clinician decides: keep the code as recorded, saying why, or correct the
 * diagnosis from its visit, which codes it afresh.
 */
export function CodingReviewPage(): JSX.Element {
  const reviews = useCodingReviews();
  const rows = reviews.data ?? [];

  return (
    <div className="page">
      <h1>Coding review</h1>
      <p className="muted">
        Diagnoses whose codes rest on a mapping the terminology team has since withdrawn.
      </p>

      {reviews.isPending ? <p className="muted">Loading…</p> : null}
      {reviews.isError ? (
        <p className="alert alert--error">
          {reviews.error instanceof ApiError ? reviews.error.message : 'Could not load the queue'}
        </p>
      ) : null}

      {reviews.isSuccess && rows.length === 0 ? (
        <div className="empty">
          <p>No diagnoses need review.</p>
        </div>
      ) : null}

      <ul className="entries">
        {rows.map((item) => (
          <ReviewItem key={`${item.conditionId}-${item.flagged.conceptMapElementId}`} item={item} />
        ))}
      </ul>
    </div>
  );
}

function ReviewItem({ item }: { item: CodingReviewItem }): JSX.Element {
  const acknowledge = useAcknowledgeCodingReview();
  const [keeping, setKeeping] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const suggested = item.suggestion?.[item.flagged.role === 'advisory' ? 'advisory' : 'translated'];

  const submit = async () => {
    setError(null);

    try {
      await acknowledge.mutateAsync({
        conditionId: item.conditionId,
        body: { conceptMapElementId: item.flagged.conceptMapElementId!, note: note.trim() },
      });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not record the decision');
    }
  };

  return (
    <li className="entry">
      <div className="entry__header">
        <span>
          <Link to={`/patients/${item.patient.id}`}>{item.patient.name ?? 'Patient'}</Link>
          {item.patient.mrn ? <span className="code"> {item.patient.mrn}</span> : null}
        </span>
        <span className="small muted">diagnosed {formatDate(item.recordedAt)}</span>
      </div>

      <p>
        <strong>{codingText(item.primary)}</strong>
      </p>
      <p className="small">
        Attached {item.flagged.role} code: {codingText(item.flagged)}{' '}
        <em className="tag">mapping {item.flagged.mappingStatus}</em>
      </p>
      <p className="small muted">
        {suggested
          ? `Today this term maps to ${codingText(suggested)}.`
          : `Today this term has no approved ${item.flagged.role} code.`}
      </p>

      {error ? <p className="alert alert--error">{error}</p> : null}

      {keeping ? (
        <div className="inline-form">
          <div className="field">
            <label htmlFor={`keep-${item.conditionId}`}>Why does the code still stand?</label>
            <input
              id={`keep-${item.conditionId}`}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </div>
          <div className="row">
            <button
              type="button"
              onClick={() => void submit()}
              disabled={note.trim().length < 3 || acknowledge.isPending}
            >
              {acknowledge.isPending ? 'Saving…' : 'Keep as recorded'}
            </button>
            <button type="button" className="ghost" onClick={() => setKeeping(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="row">
          <button type="button" className="ghost" onClick={() => setKeeping(true)}>
            Keep as recorded
          </button>
          <Link to={`/encounters/${item.encounterId}`}>Correct the diagnosis</Link>
        </div>
      )}
    </li>
  );
}
