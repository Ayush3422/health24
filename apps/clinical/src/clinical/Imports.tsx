import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { hasPermission, type ImportBatchListItem, type ImportProgress } from '@health24/shared';
import { ApiError } from '../api/client';
import { useOpenImport, usePatientImports } from '../api/imports';
import { useAuth } from '../auth/AuthProvider';
import { formatDateTime } from './format';

export const IMPORT_STATUS: Record<ImportBatchListItem['status'], { label: string; className: string }> = {
  open: { label: 'Uploading', className: 'status--in_progress' },
  classifying: { label: 'Sorting pages', className: 'status--in_progress' },
  done: { label: 'Finished', className: 'status--completed' },
};

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export function importProgressText(progress: ImportProgress): string {
  if (progress.files === 0) return 'No files uploaded yet';

  const parts = [plural(progress.pages, 'page', 'pages')];
  if (progress.pages > 0) {
    parts.push(
      `${progress.classified} in documents`,
      `${progress.excluded} excluded`,
      `${progress.unassigned} left to sort`,
    );
  }
  if (progress.filesInProgress > 0) {
    parts.push(`${plural(progress.filesInProgress, 'file', 'files')} still being checked`);
  }
  if (progress.filesQuarantined > 0) {
    parts.push(`${progress.filesQuarantined} quarantined`);
  }

  return parts.join(' · ');
}

/**
 * A patient's legacy paper file imports (SP4 Phase 6, Decision E1). For
 * records staff and clinicians: sorting a folder means reading every page.
 */
export function PatientImports({ patientId }: { patientId: string }): JSX.Element | null {
  const { staff } = useAuth();
  if (!staff || !hasPermission(staff.role, 'documents:import')) return null;

  return <ImportsSection patientId={patientId} />;
}

function ImportsSection({ patientId }: { patientId: string }): JSX.Element {
  const imports = usePatientImports(patientId, true);
  const open = useOpenImport();
  const navigate = useNavigate();
  const [starting, setStarting] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setError(null);

    try {
      const batch = await open.mutateAsync({ patientId, note: note.trim() || undefined });
      navigate(`/patients/${patientId}/imports/${batch.id}`);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not start the import');
    }
  };

  const batches = imports.data?.batches ?? [];

  return (
    <section className="card">
      <div className="section-heading">
        <h2>Paper file imports</h2>
        {!starting ? (
          <button type="button" className="ghost" onClick={() => setStarting(true)}>
            Import a paper file
          </button>
        ) : null}
      </div>
      <p className="small muted">
        Scan the patient’s old folder, then sort its pages into documents. A page that does not
        belong is excluded with a reason and kept, never deleted.
      </p>

      {starting ? (
        <div className="inline-form-block">
          {error ? <p className="alert alert--error">{error}</p> : null}
          <div className="field">
            <label htmlFor="import-note">Which folder is this? (optional)</label>
            <input
              id="import-note"
              value={note}
              maxLength={500}
              onChange={(event) => setNote(event.target.value)}
              placeholder="e.g. OPD folder, 2014–2019"
            />
          </div>
          <div className="row">
            <button type="button" onClick={() => void start()} disabled={open.isPending}>
              {open.isPending ? 'Starting…' : 'Start import'}
            </button>
            <button type="button" className="ghost" onClick={() => setStarting(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {imports.isPending ? <p className="muted">Loading…</p> : null}
      {imports.isError ? <p className="alert alert--error">Could not load imports.</p> : null}

      {batches.length > 0 ? (
        <ul className="entries">
          {batches.map((batch) => (
            <li key={batch.id} className="entry">
              <div className="entry__header">
                <span>
                  <strong>Import of {formatDateTime(batch.createdAt)}</strong>{' '}
                  <span className={`status ${IMPORT_STATUS[batch.status].className}`}>
                    {IMPORT_STATUS[batch.status].label}
                  </span>
                </span>
                <Link to={`/patients/${patientId}/imports/${batch.id}`}>
                  {batch.status === 'done' ? 'View' : 'Continue'}
                </Link>
              </div>
              <p className="small muted">
                {batch.note ? `${batch.note} · ` : ''}
                {importProgressText(batch.progress)}
                {` · started by ${batch.openedBy.name ?? 'staff'}`}
              </p>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
