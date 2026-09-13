import { useState } from 'react';
import {
  hasPermission,
  type CorrectableKind,
  type EntryRef,
  type HospitalRef,
  type VersionHistoryEntry,
} from '@health24/shared';
import { ApiError } from '../api/client';
import { useEntryHistory, useMarkEnteredInError } from '../api/documentation';
import { useAuth } from '../auth/AuthProvider';
import { formatDateTime, humanise } from './format';

/**
 * Whether the signed-in user may correct an entry. Mirrors the server: the
 * recording hospital only; any clinician there; records staff only for what
 * they typed. The server decides regardless — this only avoids offering an
 * action it would refuse.
 */
export function useCanChange(hospital: HospitalRef, entry: EntryRef): boolean {
  const { staff } = useAuth();

  if (!staff || !hospital.isOwn) return false;
  if (hasPermission(staff.role, 'clinical:write')) return true;

  return hasPermission(staff.role, 'clinical:transcribe') && entry.enteredBy.id === staff.id;
}

/**
 * History, correct, and entered in error, under any correctable entry.
 *
 * Nothing is deleted from here. Entered in error takes a reason and keeps the
 * entry in its history; a correction opens the entry's own form pre-filled.
 */
export function EntryActions({
  kind,
  id,
  hospital,
  entry,
  supersedesId,
  editable,
  onCorrect,
  correctLabel = 'Correct',
}: {
  kind: CorrectableKind;
  id: string;
  hospital: HospitalRef;
  entry: EntryRef;
  supersedesId: string | null;
  editable: boolean;
  onCorrect?: () => void;
  correctLabel?: string;
}): JSX.Element {
  const canChange = useCanChange(hospital, entry) && editable;
  const mark = useMarkEnteredInError();

  const [showHistory, setShowHistory] = useState(false);
  const [marking, setMarking] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const history = useEntryHistory(kind, id, showHistory);

  const confirm = async () => {
    setError(null);

    try {
      await mark.mutateAsync({ kind, id, reason: reason.trim() });
      setMarking(false);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not mark the entry');
    }
  };

  return (
    <div className="entry-actions">
      <div className="row row--tight">
        {supersedesId ? <em className="tag">Corrected</em> : null}
        <button
          type="button"
          className="link"
          aria-expanded={showHistory}
          onClick={() => setShowHistory((visible) => !visible)}
        >
          {showHistory ? 'Hide history' : 'History'}
        </button>
        {canChange && onCorrect ? (
          <button type="button" className="link" onClick={onCorrect}>
            {correctLabel}
          </button>
        ) : null}
        {canChange ? (
          <button type="button" className="link link--danger" onClick={() => setMarking(true)}>
            Entered in error…
          </button>
        ) : null}
      </div>

      {marking ? (
        <div className="inline-form">
          {error ? <p className="field__error">{error}</p> : null}
          <label htmlFor={`in-error-${id}`}>Why was this entered in error?</label>
          <div className="row">
            <input
              id={`in-error-${id}`}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Required, e.g. recorded on the wrong patient"
            />
            <button
              type="button"
              className="danger"
              onClick={() => void confirm()}
              disabled={reason.trim().length < 3 || mark.isPending}
            >
              Mark entered in error
            </button>
            <button type="button" className="ghost" onClick={() => setMarking(false)}>
              Keep
            </button>
          </div>
          <p className="muted small">
            The entry is not deleted. It stays in its history, with your reason.
          </p>
        </div>
      ) : null}

      {showHistory ? (
        history.isPending ? (
          <p className="muted small">Loading history…</p>
        ) : history.isError ? (
          <p className="field__error">Could not load the history.</p>
        ) : (
          <VersionHistory entries={history.data} />
        )
      ) : null}
    </div>
  );
}

function VersionHistory({ entries }: { entries: VersionHistoryEntry[] }): JSX.Element {
  return (
    <ol className="history version-history">
      {entries.map((version) => (
        <li key={version.id}>
          <strong>Version {version.version}</strong> · {version.label}{' '}
          <em className={`tag version--${version.versionStatus}`}>
            {humanise(version.versionStatus)}
          </em>
          <div className="small muted">
            {formatDateTime(version.recordedAt)} · {version.recordedBy.name ?? 'A clinician'}
            {version.entry.source === 'transcribed'
              ? ` · typed by ${version.entry.enteredBy.name ?? 'records staff'}`
              : ''}
          </div>
          {version.statusChangedAt ? (
            <div className="small">
              {version.versionStatus === 'superseded' ? 'Corrected' : 'Marked entered in error'}
              {version.statusChangedBy?.name ? ` by ${version.statusChangedBy.name}` : ''} on{' '}
              {formatDateTime(version.statusChangedAt)}
              {version.statusReason ? `: ${version.statusReason}` : ''}
            </div>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
