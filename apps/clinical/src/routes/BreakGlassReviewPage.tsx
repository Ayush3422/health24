import { useState } from 'react';
import type { BreakGlassReviewItem } from '@health24/shared';
import { ApiError } from '../api/client';
import { useBreakGlassReviews, useReviewBreakGlass } from '../api/consent';
import { formatDateTime } from '../clinical/format';

/**
 * Emergency accesses taken at this hospital, awaiting review.
 *
 * Reviewing is oversight, not clinical reading: the queue names the patient by
 * MRN and shows the reason and the clinician, never the record itself.
 */
export function BreakGlassReviewPage(): JSX.Element {
  const reviews = useBreakGlassReviews();
  const rows = reviews.data ?? [];

  return (
    <div className="page">
      <h1>Emergency access review</h1>
      <p className="muted">
        Each time a clinician opened a patient&apos;s records without consent. Decide whether it was
        justified; the decision is recorded with your name.
      </p>

      {reviews.isPending ? <p className="muted">Loading…</p> : null}
      {reviews.isError ? (
        <p className="alert alert--error">
          {reviews.error instanceof ApiError ? reviews.error.message : 'Could not load the queue'}
        </p>
      ) : null}

      {reviews.isSuccess && rows.length === 0 ? (
        <div className="empty">
          <p>Nothing to review.</p>
        </div>
      ) : null}

      <ul className="consents">
        {rows.map((item) => (
          <ReviewItem key={item.id} item={item} />
        ))}
      </ul>
    </div>
  );
}

function ReviewItem({ item }: { item: BreakGlassReviewItem }): JSX.Element {
  const review = useReviewBreakGlass();
  const [outcome, setOutcome] = useState<'justified' | 'unjustified' | ''>('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!outcome) return;
    setError(null);

    try {
      await review.mutateAsync({ id: item.id, body: { outcome, note: note.trim() } });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not record the review');
    }
  };

  return (
    <li className="consent consent--emergency">
      <div className="consent__header">
        <span>
          <span className="code">{item.mrn ?? 'MRN unavailable'}</span>{' '}
          <span className={`status status--${item.status === 'active' ? 'active' : 'completed'}`}>
            {item.status === 'active' ? 'still open' : item.status}
          </span>
        </span>
        <span className="small muted">
          {formatDateTime(item.grantedAt)} – {formatDateTime(item.expiresAt)}
        </span>
      </div>

      <p>
        <strong>{item.clinician.name ?? 'A clinician'}:</strong> {item.reason}
      </p>
      <p className="small muted">
        {item.patientNotified
          ? 'The patient has been told.'
          : 'The patient will be told once the patient portal is available.'}
      </p>

      {error ? <p className="alert alert--error">{error}</p> : null}

      <div className="form-grid form-grid--two">
        <fieldset className="field">
          <legend>Outcome</legend>
          <label className="checkbox">
            <input
              type="radio"
              name={`outcome-${item.id}`}
              checked={outcome === 'justified'}
              onChange={() => setOutcome('justified')}
            />
            Justified
          </label>
          <label className="checkbox">
            <input
              type="radio"
              name={`outcome-${item.id}`}
              checked={outcome === 'unjustified'}
              onChange={() => setOutcome('unjustified')}
            />
            Not justified
          </label>
        </fieldset>
        <div className="field">
          <label htmlFor={`review-note-${item.id}`}>Note</label>
          <input
            id={`review-note-${item.id}`}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="e.g. confirmed with the emergency department register"
          />
        </div>
      </div>

      <div className="row">
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!outcome || note.trim().length < 3 || review.isPending}
        >
          {review.isPending ? 'Saving…' : 'Record review'}
        </button>
      </div>
    </li>
  );
}
