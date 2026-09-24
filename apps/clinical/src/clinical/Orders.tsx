import { useState } from 'react';
import {
  SERVICE_REQUEST_CATEGORIES,
  type EncounterSummary,
  type OrderSummary,
  type ServiceRequestCategory,
  type ServiceRequestPriority,
} from '@health24/shared';
import { hasPermission } from '@health24/shared';
import { ApiError } from '../api/client';
import {
  ORDER_CATEGORY_LABELS,
  ORDER_PRIORITY_LABELS,
  ORDER_STATUS_LABELS,
  useAdvanceOrder,
  useCancelOrder,
  usePatientOrders,
  usePlaceOrder,
} from '../api/orders';
import { useAuth } from '../auth/AuthProvider';
import { ClinicianPicker, useAttribution } from './attribution';
import { formatDateTime, optionalText } from './format';
import { Provenance } from './Provenance';

/**
 * Orders (sp6-plan.md, Phase 2): what this hospital asked for, and how far the
 * work has got.
 *
 * An order is never corrected. It moves forward as the work is done, or it is
 * cancelled with a reason and a new one placed — so the actions here are the
 * steps themselves, not an edit.
 */

/** What people order most often, offered as suggestions; the text stays free. */
const SUGGESTIONS: Record<ServiceRequestCategory, string[]> = {
  laboratory: [
    'Liver function panel',
    'Renal function panel',
    'Complete blood count',
    'Fasting blood sugar',
    'Lipid profile',
    'Thyroid profile',
    'Urine routine',
  ],
  imaging: ['Ultrasound abdomen', 'Chest X-ray', 'X-ray, other', 'CT scan', 'MRI', 'ECG'],
  procedure: ['Ksharasutra', 'Virechana', 'Basti', 'Physiotherapy session', 'Dressing'],
};

/**
 * Every order for one patient, outstanding first: what this hospital is still
 * waiting for, and what it has already had back. Orders stay with the hospital
 * that placed them, so this is never another hospital's list (SP6, DF5).
 */
export function PatientOrders({ patientId }: { patientId: string }): JSX.Element | null {
  const { staff } = useAuth();
  const orders = usePatientOrders(patientId);

  if (!staff || !hasPermission(staff.role, 'clinical:read')) return null;

  const all = orders.data?.orders ?? [];
  const waiting = all.filter(
    (order) => order.status !== 'resulted' && order.status !== 'cancelled',
  );
  const finished = all.filter(
    (order) => order.status === 'resulted' || order.status === 'cancelled',
  );

  const editable = hasPermission(staff.role, 'orders:place');
  const canFulfil = hasPermission(staff.role, 'orders:fulfil');

  return (
    <section className="card">
      <div className="section-heading">
        <h2>Orders</h2>
      </div>

      {orders.isError ? <p className="alert alert--error">Could not load orders.</p> : null}

      <h3 className="small">Waiting</h3>
      <OrderList
        orders={waiting}
        emptyText="Nothing is outstanding for this patient."
        editable={editable}
        canFulfil={canFulfil}
      />

      {finished.length > 0 ? (
        <>
          <h3 className="small">Finished</h3>
          <OrderList orders={finished} emptyText="" editable={false} canFulfil={false} />
        </>
      ) : null}
    </section>
  );
}

export function OrderList({
  orders,
  emptyText,
  editable,
  canFulfil,
}: {
  orders: OrderSummary[];
  emptyText: string;
  /** The caller may cancel an order: it is their hospital's, and still open. */
  editable: boolean;
  /** The caller may move an order along as the work is done. */
  canFulfil: boolean;
}): JSX.Element {
  if (orders.length === 0) return <p className="muted">{emptyText}</p>;

  return (
    <ul className="entries">
      {orders.map((order) => (
        <OrderItem key={order.id} order={order} editable={editable} canFulfil={canFulfil} />
      ))}
    </ul>
  );
}

function OrderItem({
  order,
  editable,
  canFulfil,
}: {
  order: OrderSummary;
  editable: boolean;
  canFulfil: boolean;
}): JSX.Element {
  const [cancelling, setCancelling] = useState(false);

  return (
    <li className="entry">
      <div className="entry__header">
        <strong>{order.requestedDisplay}</strong>{' '}
        <span className="tag">{ORDER_CATEGORY_LABELS[order.category]}</span>{' '}
        {order.priority === 'urgent' ? <span className="tag tag--danger">Urgent</span> : null}{' '}
        <span className={`status status--${order.status}`}>
          {ORDER_STATUS_LABELS[order.status]}
        </span>
      </div>

      <div className="small">
        Ordered {formatDateTime(order.orderedAt)} by {order.orderedBy.name ?? 'a clinician'}
        {order.reference ? ` · ${order.reference}` : ''}
        {order.resultCount > 0
          ? ` · ${order.resultCount} result${order.resultCount === 1 ? '' : 's'}`
          : ''}
      </div>

      {order.clinicalNote ? <p className="small entry__note">{order.clinicalNote}</p> : null}

      {order.status === 'cancelled' ? (
        <p className="small muted">
          Cancelled {order.cancelledAt ? formatDateTime(order.cancelledAt) : ''}
          {order.cancelledReason ? `: ${order.cancelledReason}` : ''}
        </p>
      ) : null}

      <div className="small muted">
        <Provenance hospital={order.hospital} clinician={order.orderedBy} entry={order.entry} />
      </div>

      <OrderActions
        order={order}
        editable={editable}
        canFulfil={canFulfil}
        cancelling={cancelling}
        onCancelling={setCancelling}
      />
    </li>
  );
}

/** The steps themselves: the sample is taken, the work begins, or it is called off. */
export function OrderActions({
  order,
  editable,
  canFulfil,
  cancelling,
  onCancelling,
}: {
  order: OrderSummary;
  editable: boolean;
  canFulfil: boolean;
  cancelling: boolean;
  onCancelling: (value: boolean) => void;
}): JSX.Element | null {
  const advance = useAdvanceOrder();
  const cancel = useCancelOrder();
  const [reference, setReference] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const open = order.status === 'ordered' || order.status === 'collected';
  const running = open || order.status === 'in_progress';

  if (!running || (!editable && !canFulfil)) return null;

  const move = async (status: 'collected' | 'in_progress') => {
    setError(null);
    try {
      await advance.mutateAsync({
        id: order.id,
        body: { status, reference: optionalText(reference) },
      });
      setReference('');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not move the order along');
    }
  };

  const stop = async () => {
    setError(null);
    try {
      await cancel.mutateAsync({ id: order.id, body: { reason: reason.trim() } });
      onCancelling(false);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not cancel the order');
    }
  };

  const busy = advance.isPending || cancel.isPending;

  return (
    <div className="entry__actions">
      {error ? <p className="alert alert--error">{error}</p> : null}

      {cancelling ? (
        <div className="inline-form">
          <label htmlFor={`order-cancel-${order.id}`}>Why is it being cancelled?</label>
          <input
            id={`order-cancel-${order.id}`}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Required, e.g. ordered twice by mistake"
          />
          <div className="row">
            <button
              type="button"
              className="danger"
              onClick={() => void stop()}
              disabled={reason.trim().length < 3 || busy}
            >
              Cancel order
            </button>
            <button type="button" className="ghost" onClick={() => onCancelling(false)}>
              Keep it
            </button>
          </div>
        </div>
      ) : (
        <div className="row">
          {canFulfil && order.status === 'ordered' ? (
            <button type="button" onClick={() => void move('collected')} disabled={busy}>
              Sample collected
            </button>
          ) : null}
          {canFulfil && order.status !== 'in_progress' ? (
            <button
              type="button"
              className="ghost"
              onClick={() => void move('in_progress')}
              disabled={busy}
            >
              Start work
            </button>
          ) : null}
          {canFulfil && open ? (
            <input
              aria-label="Sample or study reference"
              value={reference}
              onChange={(event) => setReference(event.target.value)}
              placeholder="Sample no. (optional)"
            />
          ) : null}
          {editable ? (
            <button type="button" className="ghost" onClick={() => onCancelling(true)}>
              Cancel…
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** Ordering a test, an image or a procedure from an encounter. */
export function OrderForm({ encounter }: { encounter: EncounterSummary }): JSX.Element {
  const place = usePlaceOrder();
  const attribution = useAttribution(encounter.attending.id);

  const [category, setCategory] = useState<ServiceRequestCategory>('laboratory');
  const [what, setWhat] = useState('');
  const [priority, setPriority] = useState<ServiceRequestPriority>('routine');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const submit = async () => {
    setError(null);

    try {
      await place.mutateAsync({
        encounterId: encounter.id,
        category,
        requestedDisplay: what.trim(),
        priority,
        clinicalNote: optionalText(note),
        ...attribution.body,
      });

      setWhat('');
      setNote('');
      setPriority('routine');
      setSaved(true);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not place the order');
    }
  };

  return (
    <div className="form card">
      <h3>Order a test, an image or a procedure</h3>
      {saved ? <p className="alert alert--success">Order placed.</p> : null}
      {error ? <p className="alert alert--error">{error}</p> : null}

      <ClinicianPicker attribution={attribution} id="order-clinician" />

      <div className="form-grid">
        <div className="field">
          <label htmlFor="order-category">Kind</label>
          <select
            id="order-category"
            value={category}
            onChange={(event) => {
              setCategory(event.target.value as ServiceRequestCategory);
              setSaved(false);
            }}
          >
            {SERVICE_REQUEST_CATEGORIES.map((value) => (
              <option key={value} value={value}>
                {ORDER_CATEGORY_LABELS[value]}
              </option>
            ))}
          </select>
        </div>

        <div className="field field--wide">
          <label htmlFor="order-what">What is being ordered?</label>
          <input
            id="order-what"
            list={`order-suggestions-${category}`}
            value={what}
            onChange={(event) => {
              setWhat(event.target.value);
              setSaved(false);
            }}
            placeholder="e.g. Liver function panel"
          />
          <datalist id={`order-suggestions-${category}`}>
            {SUGGESTIONS[category].map((suggestion) => (
              <option key={suggestion} value={suggestion} />
            ))}
          </datalist>
        </div>

        <div className="field">
          <label htmlFor="order-priority">Priority</label>
          <select
            id="order-priority"
            value={priority}
            onChange={(event) => setPriority(event.target.value as ServiceRequestPriority)}
          >
            {(['routine', 'urgent'] as const).map((value) => (
              <option key={value} value={value}>
                {ORDER_PRIORITY_LABELS[value]}
              </option>
            ))}
          </select>
        </div>

        <div className="field field--wide">
          <label htmlFor="order-note">For the lab or the radiologist (optional)</label>
          <input
            id="order-note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Why it is being asked for"
          />
        </div>
      </div>

      <div className="row">
        <button
          type="button"
          onClick={() => void submit()}
          disabled={what.trim().length < 2 || place.isPending || !attribution.ready}
        >
          {place.isPending ? 'Placing…' : 'Place order'}
        </button>
      </div>
    </div>
  );
}
