import { useState } from 'react';
import { MAP_EQUIVALENCES, type MapElementStatus, type MapEquivalence } from '@health24/shared';
import { ApiError } from '../api/client';
import {
  EQUIVALENCE_LABELS,
  useCoverage,
  useMappingHistory,
  useProposeMapping,
  useReviewMapping,
  useReviewQueue,
  type MappingHistoryEntry,
  type ReviewQueueItem,
} from '../api/terminology';

const STATUS_TABS: Array<{ status: MapElementStatus; label: string }> = [
  { status: 'proposed', label: 'Awaiting review' },
  { status: 'approved', label: 'Approved' },
  { status: 'rejected', label: 'Rejected' },
  { status: 'retired', label: 'Retired' },
];

const PAGE_SIZE = 20;

const HISTORY_LABELS: Record<MappingHistoryEntry['action'], string> = {
  import: 'Imported',
  propose: 'Proposed',
  approve: 'Approved',
  reject: 'Rejected',
  retire: 'Retired',
};

const errorMessage = (error: unknown, fallback: string): string =>
  error instanceof ApiError ? error.message : fallback;

/** Strips the address from "Name <email>" for display. */
const actorName = (label: string): string => label.split(' <')[0] ?? label;

/**
 * The mapping curation console.
 *
 * Its rules are the server's, surfaced rather than re-implemented: a curator
 * sees they cannot review their own proposal before trying, and a correction
 * is framed as leaving the current mapping in force until someone else
 * approves it — because that is what happens.
 */
export function CurationPage(): JSX.Element {
  const [status, setStatus] = useState<MapElementStatus>('proposed');
  const [page, setPage] = useState(1);

  const queue = useReviewQueue(status, page);
  const coverage = useCoverage();

  const total = queue.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="page">
      <h1>Mapping review</h1>
      <p className="muted">
        A mapping reaches a patient’s diagnosis only once it is approved, and never on the say of
        the curator who proposed it.
      </p>

      {coverage.data && coverage.data.length > 0 ? (
        <div className="coverage">
          {coverage.data.map((entry) => (
            <section key={entry.conceptMap.id} className="coverage__card">
              <h2>{entry.conceptMap.name}</h2>
              <p className="muted small">
                version {entry.conceptMap.version} ·{' '}
                {entry.reviewPolicy === 'authoritative'
                  ? 'authoritative release'
                  : 'requires review'}
                {entry.experimental ? ' · demo' : ''}
              </p>
              <dl className="coverage__stats">
                <div>
                  <dt>Mapped</dt>
                  <dd>
                    {entry.mapped} of {entry.sourceConcepts}
                  </dd>
                </div>
                <div>
                  <dt>Reviewed, no correspondence</dt>
                  <dd>{entry.reviewedUnmatched}</dd>
                </div>
                <div>
                  <dt>Awaiting review</dt>
                  <dd>{entry.awaitingReview}</dd>
                </div>
                <div>
                  <dt>Never reviewed</dt>
                  <dd>{entry.unreviewed}</dd>
                </div>
              </dl>
            </section>
          ))}
        </div>
      ) : null}

      <div className="tabs" role="tablist" aria-label="Mapping status">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab.status}
            type="button"
            role="tab"
            aria-selected={status === tab.status}
            onClick={() => {
              setStatus(tab.status);
              setPage(1);
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {queue.isError ? (
        <p className="alert alert--error">{errorMessage(queue.error, 'Could not load mappings')}</p>
      ) : null}

      {queue.data && queue.data.results.length === 0 ? (
        <div className="empty">
          <p>Nothing here.</p>
        </div>
      ) : null}

      {queue.data?.results.map((item) => (
        <MappingCard key={item.id} item={item} />
      ))}

      {pages > 1 ? (
        <div className="pager">
          <button
            type="button"
            className="ghost"
            disabled={page <= 1}
            onClick={() => setPage((current) => current - 1)}
          >
            Previous
          </button>
          <span className="muted small">
            Page {page} of {pages} · {total} mappings
          </span>
          <button
            type="button"
            className="ghost"
            disabled={page >= pages}
            onClick={() => setPage((current) => current + 1)}
          >
            Next
          </button>
        </div>
      ) : null}
    </div>
  );
}

function MappingCard({ item }: { item: ReviewQueueItem }): JSX.Element {
  const review = useReviewMapping();
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [correcting, setCorrecting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const history = useMappingHistory(item.id, showHistory);

  const decide = async (decision: 'approve' | 'reject') => {
    setError(null);

    try {
      await review.mutateAsync({ id: item.id, decision, comment: comment.trim() });
    } catch (caught) {
      setError(errorMessage(caught, 'Could not record the decision'));
    }
  };

  const commentReady = comment.trim().length >= 3;

  return (
    <article className="mapping">
      <div className="mapping__meta">
        {item.map.name} · {item.provenance === 'imported' ? 'imported' : 'curator proposal'}
        {item.proposedBy ? ` by ${actorName(item.proposedBy)}` : ''}
        {item.supersedesElementId ? ' · correction of an approved mapping' : ''}
        {item.experimental ? ' · demo' : ''}
      </div>

      <div className="mapping__pair">
        <div>
          <strong>{item.source.display ?? item.source.code}</strong>{' '}
          <span className="code">{item.source.code}</span>
        </div>
        <div className="mapping__arrow" aria-hidden="true">
          →
        </div>
        <div>
          {item.target ? (
            <>
              <strong>{item.target.display ?? item.target.code}</strong>{' '}
              <span className="code">{item.target.code}</span>
            </>
          ) : (
            <em className="muted">No correspondence</em>
          )}
        </div>
      </div>

      <div className="small">
        {/* An unmatched mapping already reads "No correspondence" as its
            target; repeating it as a badge only adds noise. */}
        {item.target ? (
          <span className={`equivalence equivalence--${item.equivalence}`}>
            {EQUIVALENCE_LABELS[item.equivalence]}
          </span>
        ) : null}
        {item.confidence !== null ? (
          <span className="muted"> · confidence {Math.round(item.confidence * 100)}%</span>
        ) : null}
      </div>

      {item.comment ? <p className="small">{item.comment}</p> : null}

      {item.status === 'proposed' && item.canReview ? (
        <div className="mapping__decision">
          <label htmlFor={`comment-${item.id}`}>Reason for your decision</label>
          <input
            id={`comment-${item.id}`}
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            placeholder="Required. Recorded in the mapping’s history."
          />
          {error ? <p className="field__error">{error}</p> : null}
          <div className="row">
            <button
              type="button"
              onClick={() => void decide('approve')}
              disabled={!commentReady || review.isPending}
            >
              Approve
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => void decide('reject')}
              disabled={!commentReady || review.isPending}
            >
              Reject
            </button>
          </div>
        </div>
      ) : null}

      {item.status === 'proposed' && !item.canReview ? (
        <p className="mapping__decision muted small">
          You proposed this mapping. Another curator must review it.
        </p>
      ) : null}

      {item.status === 'approved' ? (
        correcting ? (
          <CorrectionForm
            item={item}
            onCancel={() => setCorrecting(false)}
            onProposed={() => {
              setCorrecting(false);
              setNotice(
                'Correction proposed. This mapping stays in force until another curator approves the correction.',
              );
            }}
          />
        ) : (
          <div className="mapping__decision">
            <button
              type="button"
              className="ghost"
              onClick={() => {
                setCorrecting(true);
                setNotice(null);
              }}
            >
              Propose a correction
            </button>
            {notice ? <p className="alert alert--success small">{notice}</p> : null}
          </div>
        )
      ) : null}

      <button
        type="button"
        className="link"
        aria-expanded={showHistory}
        onClick={() => setShowHistory((visible) => !visible)}
      >
        {showHistory ? 'Hide history' : 'Show history'}
      </button>

      {showHistory ? (
        history.isPending ? (
          <p className="muted small">Loading history…</p>
        ) : history.isError ? (
          <p className="field__error">{errorMessage(history.error, 'Could not load history')}</p>
        ) : (
          <ol className="history">
            {history.data.map((entry, index) => (
              <li key={`${entry.at}-${index}`}>
                <strong>{HISTORY_LABELS[entry.action]}</strong> by {actorName(entry.actorLabel)} ·{' '}
                <time dateTime={entry.at}>{new Date(entry.at).toLocaleString()}</time>
                {entry.comment ? <div className="muted">{entry.comment}</div> : null}
              </li>
            ))}
          </ol>
        )
      ) : null}
    </article>
  );
}

function CorrectionForm({
  item,
  onCancel,
  onProposed,
}: {
  item: ReviewQueueItem;
  onCancel: () => void;
  onProposed: () => void;
}): JSX.Element {
  const propose = useProposeMapping();
  const [equivalence, setEquivalence] = useState<MapEquivalence>(item.equivalence);
  const [targetCode, setTargetCode] = useState(item.target?.code ?? '');
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);

  const unmatched = equivalence === 'unmatched';
  const canSubmit =
    comment.trim().length >= 3 && (unmatched || targetCode.trim().length > 0) && !propose.isPending;

  const submit = async () => {
    setError(null);

    try {
      await propose.mutateAsync({
        conceptMapId: item.map.id,
        sourceCode: item.source.code,
        targetCode: unmatched ? null : targetCode.trim(),
        equivalence,
        comment: comment.trim(),
        supersedesElementId: item.id,
      });
      onProposed();
    } catch (caught) {
      setError(errorMessage(caught, 'Could not propose the correction'));
    }
  };

  return (
    <div className="mapping__decision form">
      <div className="field-row">
        <div className="field">
          <label htmlFor={`equivalence-${item.id}`}>Equivalence</label>
          <select
            id={`equivalence-${item.id}`}
            value={equivalence}
            onChange={(event) => setEquivalence(event.target.value as MapEquivalence)}
          >
            {MAP_EQUIVALENCES.map((value) => (
              <option key={value} value={value}>
                {EQUIVALENCE_LABELS[value]}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor={`target-${item.id}`}>Target code</label>
          <input
            id={`target-${item.id}`}
            value={unmatched ? '' : targetCode}
            disabled={unmatched}
            onChange={(event) => setTargetCode(event.target.value)}
            placeholder={unmatched ? 'None' : 'A code in the target system'}
          />
        </div>
      </div>

      <div className="field">
        <label htmlFor={`correction-${item.id}`}>Why is this correction needed?</label>
        <input
          id={`correction-${item.id}`}
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          placeholder="Required. Shown to the curator who reviews it."
        />
      </div>

      {error ? <p className="field__error">{error}</p> : null}

      <div className="row">
        <button type="button" onClick={() => void submit()} disabled={!canSubmit}>
          Propose correction
        </button>
        <button type="button" className="ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
