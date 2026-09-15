import { useRef, useState, type DragEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  DOCUMENT_MIME_TYPES,
  DOCUMENT_TYPES,
  MAX_DOCUMENT_FILE_BYTES,
  MAX_IMPORT_FILES_PER_UPLOAD,
  hasPermission,
  type DocumentMimeType,
  type DocumentType,
  type ImportBatchSummary,
  type ImportPageSummary,
} from '@health24/shared';
import { ApiError } from '../api/client';
import {
  addImportFiles,
  completeImportFiles,
  useClassifyPages,
  useExcludePages,
  useFinishImport,
  useImportBatch,
  useImportPageLink,
} from '../api/imports';
import { DOCUMENT_TYPE_LABELS, putFile } from '../api/records';
import { useAuth } from '../auth/AuthProvider';
import { IMPORT_STATUS, importProgressText } from '../clinical/Imports';
import {
  NO_ORDERING_DOCTOR,
  OrderingDoctorFields,
  orderingDoctorPayload,
  orderingDoctorReady,
  type OrderingDoctor,
} from '../clinical/OrderingDoctor';
import { formatDate, formatDateTime, istToday, optionalText } from '../clinical/format';

const errorText = (caught: unknown, fallback: string) =>
  caught instanceof ApiError || caught instanceof Error ? caught.message : fallback;

const pageLabel = (page: ImportPageSummary) => `File ${page.filePosition} · page ${page.pageNumber}`;

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

const EXCLUSION_REASONS = [
  'Blank page',
  'Another patient’s record',
  'Duplicate of another page',
  'Not a medical record',
];

/**
 * One legacy paper file import (SP4 Phase 6, Decision E1): upload the scanned
 * folder, read its pages, make documents from them or exclude them, and
 * finish once every page is sorted.
 */
export function ImportBatchPage(): JSX.Element {
  const { id: patientId = '', batchId = '' } = useParams();
  const { staff } = useAuth();

  if (!staff || !hasPermission(staff.role, 'documents:import')) {
    return (
      <p className="alert alert--error">
        Importing paper files is for records staff and clinicians.
      </p>
    );
  }

  return <ImportBatch patientId={patientId} batchId={batchId} />;
}

function ImportBatch({ patientId, batchId }: { patientId: string; batchId: string }): JSX.Element {
  const batch = useImportBatch(batchId);
  const [selected, setSelected] = useState<string[]>([]);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [action, setAction] = useState<'none' | 'classify' | 'exclude'>('none');

  if (batch.isPending) return <p className="muted">Loading…</p>;
  if (batch.isError) {
    return <p className="alert alert--error">{errorText(batch.error, 'Could not load this import')}</p>;
  }

  const data = batch.data;
  const open = data.status !== 'done';
  const preview = data.pages.find((page) => page.id === previewId) ?? null;

  const toggle = (pageId: string) =>
    setSelected((current) =>
      current.includes(pageId) ? current.filter((id) => id !== pageId) : [...current, pageId],
    );

  const clearSelection = () => {
    setSelected([]);
    setAction('none');
  };

  return (
    <div>
      <p>
        <Link to={`/patients/${patientId}`}>← Back to the patient</Link>
      </p>

      <section className="card">
        <div className="section-heading">
          <h1>Paper file import</h1>
          <span className={`status ${IMPORT_STATUS[data.status].className}`}>
            {IMPORT_STATUS[data.status].label}
          </span>
        </div>
        <p className="small muted">
          Started {formatDateTime(data.createdAt)} by {data.openedBy.name ?? 'staff'}
          {data.note ? ` · ${data.note}` : ''}
        </p>
        <p>{importProgressText(data.progress)}</p>

        {data.progress.filesQuarantined > 0 ? (
          <p className="alert alert--error small">
            A virus was found in{' '}
            {plural(data.progress.filesQuarantined, 'uploaded file', 'uploaded files')}. It is kept
            apart, and no pages were made from it. Scan that part of the folder again.
          </p>
        ) : null}

        {open ? (
          <FinishImport batch={data} />
        ) : (
          <p className="alert alert--success">
            Finished {data.closedAt ? formatDateTime(data.closedAt) : ''}. Its documents are in the
            patient’s record.
          </p>
        )}
      </section>

      {open ? <UploadFolder batchId={batchId} onUploaded={() => void batch.refetch()} /> : null}

      <div className="import-layout">
        <section className="card">
          <div className="section-heading">
            <h2>Pages</h2>
            {selected.length > 0 ? (
              <span className="small">
                {plural(selected.length, 'page', 'pages')} selected, in the order clicked
              </span>
            ) : null}
          </div>

          {data.pages.length === 0 ? (
            <p className="muted">
              {data.progress.filesInProgress > 0
                ? 'Pages appear here once each file has been checked for viruses and cut into pages.'
                : 'No pages yet. Upload the scanned folder above.'}
            </p>
          ) : (
            <ol className="page-grid">
              {data.pages.map((page) => {
                const order = selected.indexOf(page.id);
                const settled = page.state !== 'unassigned';

                return (
                  <li
                    key={page.id}
                    className={[
                      'page-card',
                      order >= 0 ? 'page-card--selected' : '',
                      settled ? 'page-card--settled' : '',
                      previewId === page.id ? 'page-card--previewing' : '',
                    ].join(' ')}
                  >
                    <label className="page-card__select">
                      {open ? (
                        <input
                          type="checkbox"
                          aria-label={`Select ${pageLabel(page)}`}
                          checked={order >= 0}
                          disabled={settled}
                          onChange={() => toggle(page.id)}
                        />
                      ) : null}
                      <span>{pageLabel(page)}</span>
                      {order >= 0 ? (
                        <span className="page-card__order" title="Its place in the document">
                          {order + 1}
                        </span>
                      ) : null}
                    </label>
                    <PageState page={page} batch={data} />
                    <button
                      type="button"
                      className="ghost small"
                      aria-pressed={previewId === page.id}
                      onClick={() => setPreviewId(page.id)}
                    >
                      View
                    </button>
                  </li>
                );
              })}
            </ol>
          )}

          {open && selected.length > 0 ? (
            <div className="action-bar">
              {action === 'none' ? (
                <>
                  <button type="button" onClick={() => setAction('classify')}>
                    Make a document from {plural(selected.length, 'page', 'pages')}
                  </button>
                  <button type="button" className="ghost" onClick={() => setAction('exclude')}>
                    Exclude {plural(selected.length, 'page', 'pages')}…
                  </button>
                  <button type="button" className="link" onClick={clearSelection}>
                    Clear selection
                  </button>
                </>
              ) : null}
              {action === 'classify' ? (
                <ClassifyForm
                  batchId={batchId}
                  pageIds={selected}
                  onDone={clearSelection}
                  onCancel={() => setAction('none')}
                />
              ) : null}
              {action === 'exclude' ? (
                <ExcludeForm
                  batchId={batchId}
                  pageIds={selected}
                  onDone={clearSelection}
                  onCancel={() => setAction('none')}
                />
              ) : null}
            </div>
          ) : null}
        </section>

        <aside className="card import-preview" aria-label="Page preview">
          <h2>Preview</h2>
          {preview ? (
            <PagePreview batchId={batchId} page={preview} />
          ) : (
            <p className="muted">Choose View on a page to read it here.</p>
          )}
        </aside>
      </div>

      {data.documents.length > 0 ? (
        <section className="card">
          <h2>Documents made from this folder</h2>
          <ul className="entries">
            {data.documents.map((document) => (
              <li key={document.id} className="entry">
                <strong>{DOCUMENT_TYPE_LABELS[document.docType]}</strong>
                {document.title ? ` · ${document.title}` : ''}{' '}
                <span className="small muted">
                  report date {formatDate(document.reportDate)} ·{' '}
                  {plural(document.pageCount, 'page', 'pages')}
                  {document.versionStatus === 'entered_in_error' ? ' · entered in error' : ''}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function PageState({
  page,
  batch,
}: {
  page: ImportPageSummary;
  batch: ImportBatchSummary;
}): JSX.Element {
  if (page.state === 'classified') {
    const document = batch.documents.find((candidate) => candidate.id === page.documentId);
    return (
      <span className="tag">
        In {document ? DOCUMENT_TYPE_LABELS[document.docType].toLowerCase() : 'a document'}
      </span>
    );
  }

  if (page.state === 'excluded') {
    return <span className="tag tag--excluded">Excluded: {page.excludedReason}</span>;
  }

  return <span className="small muted">Not sorted</span>;
}

function PagePreview({ batchId, page }: { batchId: string; page: ImportPageSummary }): JSX.Element {
  const link = useImportPageLink(batchId, page.id);

  return (
    <>
      <p className="small">
        <strong>{pageLabel(page)}</strong>
        {page.state === 'excluded' ? ` · excluded: ${page.excludedReason}` : ''}
      </p>
      {link.isPending ? <p className="muted">Opening…</p> : null}
      {link.isError ? (
        <p className="alert alert--error">{errorText(link.error, 'Could not open this page')}</p>
      ) : null}
      {link.isSuccess ? (
        page.mimeType === 'application/pdf' ? (
          <iframe className="import-preview__frame" title={pageLabel(page)} src={link.data.url} />
        ) : (
          <img className="import-preview__image" src={link.data.url} alt={pageLabel(page)} />
        )
      ) : null}
      <p className="small muted">
        Opened through a link that expires in a minute. Every page opened is recorded.
      </p>
    </>
  );
}

function FinishImport({ batch }: { batch: ImportBatchSummary }): JSX.Element {
  const finish = useFinishImport(batch.id);
  const [error, setError] = useState<string | null>(null);

  const hint =
    batch.progress.files === 0
      ? 'Upload the folder first.'
      : batch.progress.filesInProgress > 0
      ? 'Wait until every file has been checked and cut into pages.'
      : batch.progress.unassigned > 0
        ? 'Every page must be in a document or excluded.'
        : null;

  const submit = async () => {
    setError(null);
    try {
      await finish.mutateAsync();
    } catch (caught) {
      setError(errorText(caught, 'Could not finish the import'));
    }
  };

  return (
    <>
      {error ? <p className="alert alert--error">{error}</p> : null}
      <div className="row">
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!batch.canFinish || finish.isPending}
        >
          {finish.isPending ? 'Finishing…' : 'Finish import'}
        </button>
        {!batch.canFinish && hint ? <span className="small muted">{hint}</span> : null}
      </div>
    </>
  );
}

function UploadFolder({
  batchId,
  onUploaded,
}: {
  batchId: string;
  onUploaded: () => void;
}): JSX.Element {
  const chooser = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; current: number } | null>(
    null,
  );
  const [problems, setProblems] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const upload = async (list: FileList | null) => {
    if (!list || progress) return;

    const refused: string[] = [];
    const accepted: File[] = [];

    for (const file of Array.from(list)) {
      if (!(DOCUMENT_MIME_TYPES as readonly string[]).includes(file.type)) {
        refused.push(`${file.name}: only PDF, JPEG and PNG files can be uploaded`);
      } else if (file.size > MAX_DOCUMENT_FILE_BYTES) {
        refused.push(`${file.name}: over the 25 MB limit`);
      } else if (file.size === 0) {
        refused.push(`${file.name}: the file is empty`);
      } else {
        accepted.push(file);
      }
    }

    setProblems(refused);
    setError(null);
    if (accepted.length === 0) return;

    // A scanner names pages in sequence, so name order is the folder's order.
    // Names are used only here, for ordering; they are never sent.
    const ordered = [...accepted].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true }),
    );

    try {
      for (let start = 0; start < ordered.length; start += MAX_IMPORT_FILES_PER_UPLOAD) {
        const chunk = ordered.slice(start, start + MAX_IMPORT_FILES_PER_UPLOAD);
        const added = await addImportFiles(
          batchId,
          chunk.map((file) => ({ mimeType: file.type as DocumentMimeType, sizeBytes: file.size })),
        );

        for (const [index, item] of added.uploads.entries()) {
          setProgress({ done: start + index, total: ordered.length, current: 0 });
          await putFile(item, chunk[index]!, (fraction) =>
            setProgress((current) => (current ? { ...current, current: fraction } : current)),
          );
        }

        await completeImportFiles(batchId);
      }
    } catch (caught) {
      setError(errorText(caught, 'Could not upload the folder'));
    } finally {
      setProgress(null);
      onUploaded();
    }
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    void upload(event.dataTransfer.files);
  };

  return (
    <section className="card">
      <h2>Upload the scanned folder</h2>
      <p className="small muted">
        Add the folder’s scans — PDFs or photographs, up to 25 MB each — in as many goes as needed.
        Files are put in order of their names. Each is checked for viruses and cut into pages.
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
        {progress ? (
          <>
            <p>
              Uploading file {progress.done + 1} of {progress.total}
            </p>
            <progress
              value={(progress.done + progress.current) / progress.total}
              max={1}
              aria-label="Folder upload progress"
            />
          </>
        ) : (
          <>
            <p>Drop the folder’s scans here</p>
            <button type="button" className="ghost" onClick={() => chooser.current?.click()}>
              Choose files
            </button>
          </>
        )}
        <input
          ref={chooser}
          type="file"
          multiple
          accept={DOCUMENT_MIME_TYPES.join(',')}
          hidden
          onChange={(event) => {
            void upload(event.target.files);
            event.target.value = '';
          }}
        />
      </div>
    </section>
  );
}

function ClassifyForm({
  batchId,
  pageIds,
  onDone,
  onCancel,
}: {
  batchId: string;
  pageIds: string[];
  onDone: () => void;
  onCancel: () => void;
}): JSX.Element {
  const classify = useClassifyPages(batchId);
  const [docType, setDocType] = useState<DocumentType>('lab_report');
  const [reportDate, setReportDate] = useState('');
  const [title, setTitle] = useState('');
  const [facility, setFacility] = useState('');
  const [ordering, setOrdering] = useState<OrderingDoctor>(NO_ORDERING_DOCTOR);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);

    try {
      await classify.mutateAsync({
        pageIds,
        docType,
        reportDate,
        title: optionalText(title),
        performingFacility: optionalText(facility),
        ...orderingDoctorPayload(ordering),
      });
      onDone();
    } catch (caught) {
      setError(errorText(caught, 'Could not make the document'));
    }
  };

  return (
    <div className="form">
      <h3>Make a document from {plural(pageIds.length, 'page', 'pages')}</h3>
      <p className="small muted">
        The pages go into the document in the order you selected them. Use the date printed on the
        report itself.
      </p>
      {error ? <p className="alert alert--error">{error}</p> : null}

      <div className="form-grid">
        <div className="field">
          <label htmlFor="classify-type">Type</label>
          <select
            id="classify-type"
            value={docType}
            onChange={(event) => setDocType(event.target.value as DocumentType)}
          >
            {DOCUMENT_TYPES.map((type) => (
              <option key={type} value={type}>
                {DOCUMENT_TYPE_LABELS[type]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="classify-date">Date on the report</label>
          <input
            id="classify-date"
            type="date"
            value={reportDate}
            max={istToday()}
            onChange={(event) => setReportDate(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="classify-title">Title (optional)</label>
          <input
            id="classify-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="e.g. Discharge summary, cholecystectomy"
          />
        </div>
        <div className="field">
          <label htmlFor="classify-facility">Hospital or laboratory (optional)</label>
          <input
            id="classify-facility"
            value={facility}
            onChange={(event) => setFacility(event.target.value)}
          />
        </div>
        <OrderingDoctorFields
          idPrefix="classify"
          value={ordering}
          onChange={setOrdering}
          canChooseClinician
        />
      </div>

      <div className="row">
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!reportDate || !orderingDoctorReady(ordering) || classify.isPending}
        >
          {classify.isPending ? 'Saving…' : 'Save document'}
        </button>
        <button type="button" className="ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function ExcludeForm({
  batchId,
  pageIds,
  onDone,
  onCancel,
}: {
  batchId: string;
  pageIds: string[];
  onDone: () => void;
  onCancel: () => void;
}): JSX.Element {
  const exclude = useExcludePages(batchId);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);

    try {
      await exclude.mutateAsync({ pageIds, reason: reason.trim() });
      onDone();
    } catch (caught) {
      setError(errorText(caught, 'Could not exclude the pages'));
    }
  };

  return (
    <div className="form">
      <h3>Exclude {plural(pageIds.length, 'page', 'pages')}</h3>
      {error ? <p className="alert alert--error">{error}</p> : null}
      <div className="field">
        <label htmlFor="exclude-reason">
          Why are these pages not part of this patient’s record? They are kept, not deleted.
        </label>
        <input
          id="exclude-reason"
          list="exclude-reasons"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
        <datalist id="exclude-reasons">
          {EXCLUSION_REASONS.map((option) => (
            <option key={option} value={option} />
          ))}
        </datalist>
      </div>
      <div className="row">
        <button
          type="button"
          className="danger"
          onClick={() => void submit()}
          disabled={reason.trim().length < 3 || exclude.isPending}
        >
          {exclude.isPending ? 'Saving…' : 'Exclude'}
        </button>
        <button type="button" className="ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
