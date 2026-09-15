import { useEffect, useRef, useState, type DragEvent } from 'react';
import {
  DOCUMENT_MIME_TYPES,
  DOCUMENT_TYPES,
  MAX_DOCUMENT_FILE_BYTES,
  MAX_FILES_PER_DOCUMENT,
  hasPermission,
  type DocumentMimeType,
  type DocumentSummary,
  type DocumentType,
} from '@health24/shared';
import { ApiError } from '../api/client';
import { useInvalidateClinical } from '../api/clinical';
import {
  DOCUMENT_TYPE_LABELS,
  completeDocument,
  fetchDownloadLink,
  putFile,
  useCorrectDocument,
  useCreateDocument,
  useDocumentFileLink,
  useMarkDocumentInError,
  usePatientDocuments,
  type DocumentFilters,
} from '../api/records';
import { useAuth } from '../auth/AuthProvider';
import { formatDate, istToday, optionalText } from './format';
import {
  NO_ORDERING_DOCTOR,
  OrderingDoctorFields,
  orderingDoctorPayload,
  orderingDoctorReady,
  type OrderingDoctor,
} from './OrderingDoctor';

const errorText = (caught: unknown, fallback: string) =>
  caught instanceof ApiError || caught instanceof Error ? caught.message : fallback;

const AVAILABILITY: Record<DocumentSummary['availability'], { label: string; className: string }> = {
  pending_scan: { label: 'Checking for viruses', className: 'status--in_progress' },
  available: { label: 'Ready', className: 'status--active' },
  quarantined: { label: 'Quarantined', className: 'status--deactivated' },
  abandoned: { label: 'Upload not finished', className: 'status--cancelled' },
};

const megabytes = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/**
 * A patient's documents: reports, scans and bills (SP4).
 *
 * The front desk uploads and sees what its hospital uploaded; opening a report
 * is for roles that read clinical records (Decision H1).
 */
export function PatientDocuments({ patientId }: { patientId: string }): JSX.Element | null {
  const { staff } = useAuth();
  if (!staff) return null;

  const canUpload = hasPermission(staff.role, 'documents:upload');
  const canRead = hasPermission(staff.role, 'clinical:read');
  if (!canUpload && !canRead) return null;

  return <DocumentsSection patientId={patientId} canUpload={canUpload} canRead={canRead} />;
}

function DocumentsSection({
  patientId,
  canUpload,
  canRead,
}: {
  patientId: string;
  canUpload: boolean;
  canRead: boolean;
}): JSX.Element {
  const [filters, setFilters] = useState<DocumentFilters>({
    types: [],
    from: '',
    to: '',
    scope: canRead ? 'all' : 'own',
  });
  const [uploading, setUploading] = useState(false);
  const [viewing, setViewing] = useState<DocumentSummary | null>(null);

  const documents = usePatientDocuments(patientId, filters);
  const rows = documents.data?.results ?? [];

  return (
    <section className="card">
      <div className="section-heading">
        <h2>Documents and reports</h2>
        {canUpload && !uploading ? (
          <button type="button" onClick={() => setUploading(true)}>
            Upload a report
          </button>
        ) : null}
      </div>

      {!canRead ? (
        <p className="muted small">
          You can upload this patient’s reports and see what your hospital has uploaded. Opening a
          report is for clinicians and records staff.
        </p>
      ) : null}

      {uploading ? (
        <UploadDocumentForm
          patientId={patientId}
          canChooseClinician={canRead}
          onDone={() => setUploading(false)}
        />
      ) : null}

      <div className="filters-row" role="group" aria-label="Filter documents">
        <div className="field">
          <label htmlFor="documents-type">Type</label>
          <select
            id="documents-type"
            value={filters.types[0] ?? ''}
            onChange={(event) =>
              setFilters((current) => ({
                ...current,
                types: event.target.value ? [event.target.value as DocumentType] : [],
              }))
            }
          >
            <option value="">All types</option>
            {DOCUMENT_TYPES.map((type) => (
              <option key={type} value={type}>
                {DOCUMENT_TYPE_LABELS[type]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="documents-from">Report date from</label>
          <input
            id="documents-from"
            type="date"
            value={filters.from}
            max={istToday()}
            onChange={(event) => setFilters((current) => ({ ...current, from: event.target.value }))}
          />
        </div>
        <div className="field">
          <label htmlFor="documents-to">to</label>
          <input
            id="documents-to"
            type="date"
            value={filters.to}
            max={istToday()}
            onChange={(event) => setFilters((current) => ({ ...current, to: event.target.value }))}
          />
        </div>
        {canRead ? (
          <div className="field">
            <label htmlFor="documents-scope">Hospitals</label>
            <select
              id="documents-scope"
              value={filters.scope}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  scope: event.target.value as 'all' | 'own',
                }))
              }
            >
              <option value="all">All shared with you</option>
              <option value="own">This hospital only</option>
            </select>
          </div>
        ) : null}
      </div>

      {documents.isPending ? <p className="muted">Loading…</p> : null}
      {documents.isError ? (
        <p className="alert alert--error">Could not load this patient’s documents.</p>
      ) : null}
      {documents.isSuccess && rows.length === 0 ? (
        <p className="muted">No documents{filters.types.length || filters.from || filters.to ? ' match these filters' : ' uploaded yet'}.</p>
      ) : null}

      {rows.length > 0 ? (
        <ul className="entries">
          {rows.map((document) => (
            <DocumentRow
              key={document.id}
              document={document}
              canRead={canRead}
              canChange={canUpload && document.hospital.isOwn}
              onOpen={() => setViewing(document)}
            />
          ))}
        </ul>
      ) : null}

      {canRead && documents.isSuccess && filters.scope === 'all' && !documents.data.sharedFromOtherHospitals ? (
        <p className="sharing-note small">
          Documents from other hospitals are not shared with your hospital. Only your hospital’s
          documents are shown.
        </p>
      ) : null}

      {viewing ? <DocumentViewer document={viewing} onClose={() => setViewing(null)} /> : null}
    </section>
  );
}

function DocumentRow({
  document,
  canRead,
  canChange,
  onOpen,
}: {
  document: DocumentSummary;
  canRead: boolean;
  canChange: boolean;
  onOpen: () => void;
}): JSX.Element {
  const [mode, setMode] = useState<'idle' | 'correct' | 'withdraw'>('idle');
  const status = AVAILABILITY[document.availability];
  const pages = document.files.reduce((sum, file) => sum + (file.pageCount ?? 0), 0);
  const fileCount = document.files.length;

  return (
    <li className="entry">
      <div className="entry__header">
        <span>
          <strong>{DOCUMENT_TYPE_LABELS[document.docType]}</strong>
          {document.title ? ` · ${document.title}` : ''}{' '}
          <span className={`status ${status.className}`}>{status.label}</span>
        </span>
        <span className="small muted">report date {formatDate(document.reportDate)}</span>
      </div>

      <p className="small muted">
        {document.hospital.isOwn ? (
          'This hospital'
        ) : (
          <em className="tag tag--shared">{document.hospital.name}</em>
        )}
        {document.performingFacility ? ` · ${document.performingFacility}` : ''}
        {document.orderingClinician
          ? ` · ordered by ${document.orderingClinician.name ?? 'a clinician'}${document.orderingClinician.external ? ' (not on staff)' : ''}`
          : ''}
        {` · ${fileCount === 1 ? '1 file' : `${fileCount} files`}`}
        {pages > 0 ? `, ${pages === 1 ? '1 page' : `${pages} pages`}` : ''}
        {` · uploaded by ${document.recordedBy.name ?? 'staff'}`}
      </p>

      {document.availability === 'quarantined' ? (
        <p className="alert alert--error small">
          A virus was found in this upload. It is kept apart and will not be opened.
        </p>
      ) : null}

      {mode === 'idle' ? (
        <div className="row row--tight">
          {canRead && document.availability === 'available' ? (
            <button type="button" onClick={onOpen}>
              Open
            </button>
          ) : null}
          {canChange && document.availability === 'available' ? (
            <button type="button" className="ghost" onClick={() => setMode('correct')}>
              Correct details
            </button>
          ) : null}
          {canChange ? (
            <button type="button" className="ghost" onClick={() => setMode('withdraw')}>
              Entered in error…
            </button>
          ) : null}
        </div>
      ) : null}

      {mode === 'correct' ? (
        <CorrectDocumentForm document={document} onDone={() => setMode('idle')} />
      ) : null}
      {mode === 'withdraw' ? (
        <WithdrawDocumentForm document={document} onDone={() => setMode('idle')} />
      ) : null}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Uploading
// ---------------------------------------------------------------------------

type Selected = { key: string; file: File; progress: number };

function UploadDocumentForm({
  patientId,
  canChooseClinician,
  onDone,
}: {
  patientId: string;
  canChooseClinician: boolean;
  onDone: () => void;
}): JSX.Element {
  const create = useCreateDocument();
  const invalidate = useInvalidateClinical();
  const chooser = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);

  const [files, setFiles] = useState<Selected[]>([]);
  const [dragging, setDragging] = useState(false);
  const [docType, setDocType] = useState<DocumentType>('lab_report');
  const [reportDate, setReportDate] = useState(istToday());
  const [title, setTitle] = useState('');
  const [facility, setFacility] = useState('');
  const [ordering, setOrdering] = useState<OrderingDoctor>(NO_ORDERING_DOCTOR);
  const [phase, setPhase] = useState<'editing' | 'uploading' | 'confirming'>('editing');
  const [problems, setProblems] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const add = (list: FileList | null) => {
    if (!list) return;
    const refused: string[] = [];
    const accepted: Selected[] = [];

    for (const file of Array.from(list)) {
      if (!(DOCUMENT_MIME_TYPES as readonly string[]).includes(file.type)) {
        refused.push(`${file.name}: only PDF, JPEG and PNG files can be uploaded`);
      } else if (file.size > MAX_DOCUMENT_FILE_BYTES) {
        refused.push(`${file.name}: ${megabytes(file.size)} is over the 25 MB limit`);
      } else if (file.size === 0) {
        refused.push(`${file.name}: the file is empty`);
      } else {
        accepted.push({ key: `${file.name}-${file.size}-${Math.random()}`, file, progress: 0 });
      }
    }

    setFiles((current) => {
      const next = [...current, ...accepted];
      if (next.length > MAX_FILES_PER_DOCUMENT) {
        refused.push(`A document has at most ${MAX_FILES_PER_DOCUMENT} files`);
        return next.slice(0, MAX_FILES_PER_DOCUMENT);
      }
      return next;
    });
    setProblems(refused);
  };

  const move = (index: number, by: -1 | 1) =>
    setFiles((current) => {
      const next = [...current];
      const [item] = next.splice(index, 1);
      if (item) next.splice(index + by, 0, item);
      return next;
    });

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    add(event.dataTransfer.files);
  };

  const ready =
    files.length > 0 &&
    Boolean(reportDate) &&
    orderingDoctorReady(ordering);

  const submit = async () => {
    setError(null);
    setPhase('uploading');

    try {
      const created = await create.mutateAsync({
        patientId,
        docType,
        reportDate,
        title: optionalText(title),
        performingFacility: optionalText(facility),
        ...orderingDoctorPayload(ordering),
        files: files.map((item) => ({
          mimeType: item.file.type as DocumentMimeType,
          sizeBytes: item.file.size,
        })),
      });

      for (const [index, upload] of created.uploads.entries()) {
        const item = files[index];
        if (!item) continue;

        await putFile(upload, item.file, (fraction) =>
          setFiles((current) =>
            current.map((entry, position) =>
              position === index ? { ...entry, progress: fraction } : entry,
            ),
          ),
        );
      }

      setPhase('confirming');
      await completeDocument(created.document.id);
      await invalidate();
      onDone();
    } catch (caught) {
      setError(errorText(caught, 'Could not upload the report'));
      setPhase('editing');
    }
  };

  const busy = phase !== 'editing';

  return (
    <div className="form inline-form-block">
      <h3>Upload a report</h3>
      <p className="small muted">
        All the files chosen here become one document, in this order — for example the pages of
        one report. Each is checked for viruses before it can be opened.
      </p>
      {error ? <p className="alert alert--error">{error}</p> : null}
      {problems.length > 0 ? (
        <ul className="alert alert--warning small">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      ) : null}

      <div
        className={`drop-zone${dragging ? ' drop-zone--active' : ''}`}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <p>Drop PDF, JPEG or PNG files here, up to 25 MB each</p>
        <div className="row row--tight drop-zone__actions">
          <button type="button" className="ghost" onClick={() => chooser.current?.click()} disabled={busy}>
            Choose files
          </button>
          <button type="button" className="ghost" onClick={() => camera.current?.click()} disabled={busy}>
            Take a photo
          </button>
        </div>
        <input
          ref={chooser}
          type="file"
          multiple
          accept={DOCUMENT_MIME_TYPES.join(',')}
          hidden
          onChange={(event) => {
            add(event.target.files);
            event.target.value = '';
          }}
        />
        <input
          ref={camera}
          type="file"
          accept="image/jpeg,image/png"
          capture="environment"
          hidden
          onChange={(event) => {
            add(event.target.files);
            event.target.value = '';
          }}
        />
      </div>

      {files.length > 0 ? (
        <ol className="upload-files">
          {files.map((item, index) => (
            <li key={item.key}>
              <span className="upload-files__name">{item.file.name}</span>
              <span className="small muted">{megabytes(item.file.size)}</span>
              {busy ? (
                <progress value={item.progress} max={1} aria-label={`Uploading ${item.file.name}`} />
              ) : (
                <span className="row row--tight">
                  <button type="button" className="ghost small" disabled={index === 0} onClick={() => move(index, -1)} aria-label={`Move ${item.file.name} up`}>
                    ↑
                  </button>
                  <button type="button" className="ghost small" disabled={index === files.length - 1} onClick={() => move(index, 1)} aria-label={`Move ${item.file.name} down`}>
                    ↓
                  </button>
                  <button type="button" className="ghost small" onClick={() => setFiles((current) => current.filter((entry) => entry.key !== item.key))}>
                    Remove
                  </button>
                </span>
              )}
            </li>
          ))}
        </ol>
      ) : null}

      <div className="form-grid">
        <div className="field">
          <label htmlFor="upload-type">Type</label>
          <select id="upload-type" value={docType} onChange={(event) => setDocType(event.target.value as DocumentType)}>
            {DOCUMENT_TYPES.map((type) => (
              <option key={type} value={type}>
                {DOCUMENT_TYPE_LABELS[type]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="upload-date">Date on the report</label>
          <input id="upload-date" type="date" value={reportDate} max={istToday()} onChange={(event) => setReportDate(event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="upload-title">Title (optional)</label>
          <input id="upload-title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="e.g. Ultrasound abdomen" />
        </div>
        <div className="field">
          <label htmlFor="upload-facility">Laboratory or facility (optional)</label>
          <input id="upload-facility" value={facility} onChange={(event) => setFacility(event.target.value)} />
        </div>
        <OrderingDoctorFields
          idPrefix="upload"
          value={ordering}
          onChange={setOrdering}
          canChooseClinician={canChooseClinician}
        />
      </div>

      <div className="row">
        <button type="button" onClick={() => void submit()} disabled={!ready || busy}>
          {phase === 'uploading'
            ? 'Uploading…'
            : phase === 'confirming'
              ? 'Finishing…'
              : `Upload ${files.length === 1 ? '1 file' : `${files.length} files`}`}
        </button>
        <button type="button" className="ghost" onClick={onDone} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Corrections
// ---------------------------------------------------------------------------

function CorrectDocumentForm({
  document,
  onDone,
}: {
  document: DocumentSummary;
  onDone: () => void;
}): JSX.Element {
  const correct = useCorrectDocument();
  const [docType, setDocType] = useState<DocumentType>(document.docType);
  const [reportDate, setReportDate] = useState(document.reportDate);
  const [title, setTitle] = useState(document.title ?? '');
  const [facility, setFacility] = useState(document.performingFacility ?? '');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);

    try {
      const ordering = document.orderingClinician;
      await correct.mutateAsync({
        id: document.id,
        body: {
          docType,
          reportDate,
          title: optionalText(title),
          performingFacility: optionalText(facility),
          orderingClinicianId: ordering && !ordering.external ? (ordering.id ?? undefined) : undefined,
          orderingClinicianName: ordering?.external ? (ordering.name ?? undefined) : undefined,
          reason: reason.trim(),
        },
      });
      onDone();
    } catch (caught) {
      setError(errorText(caught, 'Could not correct the document'));
    }
  };

  return (
    <div className="inline-form-block">
      {error ? <p className="alert alert--error">{error}</p> : null}
      <div className="form-grid">
        <div className="field">
          <label htmlFor={`correct-type-${document.id}`}>Type</label>
          <select id={`correct-type-${document.id}`} value={docType} onChange={(event) => setDocType(event.target.value as DocumentType)}>
            {DOCUMENT_TYPES.map((type) => (
              <option key={type} value={type}>
                {DOCUMENT_TYPE_LABELS[type]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`correct-date-${document.id}`}>Date on the report</label>
          <input id={`correct-date-${document.id}`} type="date" value={reportDate} max={istToday()} onChange={(event) => setReportDate(event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={`correct-title-${document.id}`}>Title</label>
          <input id={`correct-title-${document.id}`} value={title} onChange={(event) => setTitle(event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={`correct-facility-${document.id}`}>Laboratory or facility</label>
          <input id={`correct-facility-${document.id}`} value={facility} onChange={(event) => setFacility(event.target.value)} />
        </div>
        <div className="field field--wide">
          <label htmlFor={`correct-reason-${document.id}`}>Why are the details being corrected?</label>
          <input id={`correct-reason-${document.id}`} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="e.g. report date typed wrongly" />
        </div>
      </div>
      <div className="row">
        <button type="button" onClick={() => void submit()} disabled={reason.trim().length < 3 || correct.isPending}>
          {correct.isPending ? 'Saving…' : 'Save correction'}
        </button>
        <button type="button" className="ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function WithdrawDocumentForm({
  document,
  onDone,
}: {
  document: DocumentSummary;
  onDone: () => void;
}): JSX.Element {
  const withdraw = useMarkDocumentInError();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    try {
      await withdraw.mutateAsync({ id: document.id, reason: reason.trim() });
      onDone();
    } catch (caught) {
      setError(errorText(caught, 'Could not withdraw the document'));
    }
  };

  return (
    <div className="inline-form-block">
      {error ? <p className="alert alert--error">{error}</p> : null}
      <div className="field">
        <label htmlFor={`withdraw-${document.id}`}>
          Why is this document entered in error? It will be kept, but no longer listed or opened.
        </label>
        <input id={`withdraw-${document.id}`} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="e.g. belongs to another patient" />
      </div>
      <div className="row">
        <button type="button" className="danger" onClick={() => void submit()} disabled={reason.trim().length < 3 || withdraw.isPending}>
          {withdraw.isPending ? 'Saving…' : 'Mark entered in error'}
        </button>
        <button type="button" className="ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Viewer
// ---------------------------------------------------------------------------

const ZOOM_STEPS = [1, 1.5, 2, 3];

function DocumentViewer({
  document,
  onClose,
}: {
  document: DocumentSummary;
  onClose: () => void;
}): JSX.Element {
  const [index, setIndex] = useState(0);
  const [zoom, setZoom] = useState(0);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const file = document.files[index];
  const link = useDocumentFileLink(document.id, file?.id);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const download = async () => {
    if (!file) return;
    setDownloadError(null);

    try {
      const { url } = await fetchDownloadLink(document.id, file.id);
      const anchor = window.document.createElement('a');
      anchor.href = url;
      anchor.rel = 'noopener';
      anchor.click();
    } catch (caught) {
      setDownloadError(errorText(caught, 'Could not download the file'));
    }
  };

  const isPdf = file?.mimeType === 'application/pdf';

  return (
    <div className="viewer" role="dialog" aria-modal="true" aria-label={`${DOCUMENT_TYPE_LABELS[document.docType]} from ${formatDate(document.reportDate)}`}>
      <div className="viewer__bar">
        <div>
          <strong>{DOCUMENT_TYPE_LABELS[document.docType]}</strong>
          {document.title ? ` · ${document.title}` : ''}
          <span className="small muted">
            {' '}
            · {formatDate(document.reportDate)} ·{' '}
            {document.hospital.isOwn ? 'this hospital' : document.hospital.name}
          </span>
        </div>

        <div className="viewer__controls">
          {document.files.length > 1
            ? document.files.map((candidate, position) => (
                <button
                  key={candidate.id}
                  type="button"
                  className="ghost small"
                  aria-pressed={position === index}
                  onClick={() => {
                    setIndex(position);
                    setZoom(0);
                  }}
                >
                  {`File ${position + 1}`}
                </button>
              ))
            : null}
          {!isPdf ? (
            <>
              <button type="button" className="ghost small" onClick={() => setZoom((step) => Math.max(0, step - 1))} disabled={zoom === 0} aria-label="Zoom out">
                −
              </button>
              <span className="small">{`${Math.round((ZOOM_STEPS[zoom] ?? 1) * 100)}%`}</span>
              <button type="button" className="ghost small" onClick={() => setZoom((step) => Math.min(ZOOM_STEPS.length - 1, step + 1))} disabled={zoom === ZOOM_STEPS.length - 1} aria-label="Zoom in">
                +
              </button>
            </>
          ) : null}
          <button type="button" className="ghost small" onClick={() => void download()}>
            Download
          </button>
          <button type="button" className="small" onClick={onClose}>
            Close
          </button>
        </div>
      </div>

      {downloadError ? <p className="alert alert--error">{downloadError}</p> : null}

      <div className="viewer__body">
        {link.isPending ? <p className="viewer__message">Opening…</p> : null}
        {link.isError ? (
          <p className="alert alert--error">{errorText(link.error, 'Could not open this file')}</p>
        ) : null}
        {link.isSuccess && file ? (
          isPdf ? (
            <iframe className="viewer__pdf" title={`File ${index + 1}`} src={link.data.url} />
          ) : (
            <div className="viewer__image">
              <img
                src={link.data.url}
                alt={`File ${index + 1} of ${DOCUMENT_TYPE_LABELS[document.docType].toLowerCase()}`}
                style={{ width: `${(ZOOM_STEPS[zoom] ?? 1) * 100}%` }}
              />
            </div>
          )
        ) : null}
      </div>

      <p className="viewer__note small">
        Opened through a link that expires in a minute. Every opening and download is recorded.
      </p>
    </div>
  );
}
