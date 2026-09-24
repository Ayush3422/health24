import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  hasPermission,
  SERVICE_REQUEST_CATEGORIES,
  type ServiceRequestCategory,
  type ServiceRequestStatus,
} from '@health24/shared';
import { ApiError } from '../api/client';
import { ORDER_CATEGORY_LABELS, ORDER_STATUS_LABELS, useOrderWorklist } from '../api/orders';
import { useAuth } from '../auth/AuthProvider';
import { OrderActions } from '../clinical/Orders';
import { formatDateTime } from '../clinical/format';

/** How long something has waited, said the way a person would say it. */
const waited = (hours: number): string => {
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`;

  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
};

/** Where the result of this kind of order is recorded. */
const ANSWER_LINK: Record<ServiceRequestCategory, { path: string; label: string }> = {
  laboratory: { path: 'reports', label: 'Type results' },
  imaging: { path: 'reports', label: 'Upload report' },
  procedure: { path: 'visits', label: 'Open the record' },
};

/**
 * The lab's and the radiology desk's list of what this hospital still owes
 * somebody: outstanding orders, urgent first and oldest next, with the step
 * each one is waiting for (sp6-plan.md, T4 and T6).
 */
export function OrderWorklistPage(): JSX.Element {
  const { staff } = useAuth();
  const [category, setCategory] = useState<ServiceRequestCategory | ''>('');
  const [status, setStatus] = useState<ServiceRequestStatus | ''>('');
  const [cancelling, setCancelling] = useState<string | null>(null);

  const worklist = useOrderWorklist({
    ...(category ? { category } : {}),
    ...(status ? { status } : {}),
  });

  const entries = worklist.data?.entries ?? [];
  const role = staff?.role;
  const canFulfil = Boolean(role && hasPermission(role, 'orders:fulfil'));
  const canOrder = Boolean(role && hasPermission(role, 'orders:place'));

  return (
    <div className="page">
      <div className="page-header">
        <h1>Order worklist</h1>
        <div className="row page-header__control">
          <div className="field">
            <label htmlFor="worklist-category">Kind</label>
            <select
              id="worklist-category"
              value={category}
              onChange={(event) => setCategory(event.target.value as ServiceRequestCategory | '')}
            >
              <option value="">Everything</option>
              {SERVICE_REQUEST_CATEGORIES.map((value) => (
                <option key={value} value={value}>
                  {ORDER_CATEGORY_LABELS[value]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="worklist-status">Step</label>
            <select
              id="worklist-status"
              value={status}
              onChange={(event) => setStatus(event.target.value as ServiceRequestStatus | '')}
            >
              <option value="">Still outstanding</option>
              <option value="ordered">Ordered</option>
              <option value="collected">Sample collected</option>
              <option value="in_progress">In progress</option>
              <option value="resulted">Resulted</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </div>
        </div>
      </div>

      {worklist.isError ? (
        <p className="alert alert--error">
          {worklist.error instanceof ApiError
            ? worklist.error.message
            : 'Could not load the worklist'}
        </p>
      ) : null}

      {worklist.isPending ? <p>Loading…</p> : null}

      {worklist.isSuccess && entries.length === 0 ? (
        <p className="muted">
          {status || category
            ? 'Nothing here matches those filters.'
            : 'Nothing is outstanding. Every order has its result.'}
        </p>
      ) : null}

      {entries.length > 0 ? (
        <ul className="entries">
          {entries.map((entry) => (
            <li key={entry.id} className="entry">
              <div className="entry__header">
                <strong>{entry.requestedDisplay}</strong>{' '}
                <span className="tag">{ORDER_CATEGORY_LABELS[entry.category]}</span>{' '}
                {entry.priority === 'urgent' ? (
                  <span className="tag tag--danger">Urgent</span>
                ) : null}{' '}
                <span className={`status status--${entry.status}`}>
                  {ORDER_STATUS_LABELS[entry.status]}
                </span>
              </div>

              <div className="small">
                <Link to={`/patients/${entry.patientId}`}>{entry.patient.name}</Link>
                {entry.patient.mrn ? <span className="code"> {entry.patient.mrn}</span> : null} ·
                ordered {formatDateTime(entry.orderedAt)} by {entry.orderedBy.name ?? 'a clinician'}{' '}
                · waiting {waited(entry.waitingHours)}
                {entry.reference ? ` · ${entry.reference}` : ''}
              </div>

              {entry.clinicalNote ? (
                <p className="small entry__note">{entry.clinicalNote}</p>
              ) : null}

              <div className="row small">
                <Link
                  to={`/patients/${entry.patientId}/${ANSWER_LINK[entry.category].path}?order=${entry.id}`}
                >
                  {ANSWER_LINK[entry.category].label}
                </Link>
                <Link to={`/encounters/${entry.encounterId}`}>Open the encounter</Link>
              </div>

              <OrderActions
                order={entry}
                editable={canOrder}
                canFulfil={canFulfil}
                cancelling={cancelling === entry.id}
                onCancelling={(value) => setCancelling(value ? entry.id : null)}
              />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
