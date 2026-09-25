import { useState } from 'react';
import {
  CATALOGUE_CATEGORY_LABELS,
  formatPaise,
  hasPermission,
  type Charge,
  type ChargeSource,
  type UnchargedItem,
} from '@health24/shared';
import { ApiError } from '../api/client';
import { useCaptureCharge, useCatalogue, useEncounterCharges, useVoidCharge } from '../api/billing';
import { useAuth } from '../auth/AuthProvider';
import { formatDateTime } from './format';

const errorText = (caught: unknown, fallback: string) =>
  caught instanceof ApiError ? caught.message : fallback;

const SOURCE_LABELS: Record<ChargeSource, string> = {
  order: 'Order',
  procedure: 'Procedure',
  bed_day: 'Bed',
  manual: 'Added at the desk',
};

/**
 * The bill as it is put together (sp6-plan.md, T15).
 *
 * The record knows what was ordered, done and occupied; only the hospital
 * knows what those cost, so nothing is charged automatically. Each line is the
 * desk choosing an item from the price list, and the price is copied at that
 * moment — a change to the price list tomorrow leaves today's bill alone.
 */
export function ChargesPanel({
  encounterId,
  own,
}: {
  encounterId: string;
  own: boolean;
}): JSX.Element | null {
  const { staff } = useAuth();
  const charges = useEncounterCharges(
    encounterId,
    own && Boolean(staff && hasPermission(staff.role, 'charges:capture')),
  );

  if (!staff || !own || !hasPermission(staff.role, 'charges:capture')) return null;

  const data = charges.data;

  return (
    <section className="card">
      <div className="section-heading">
        <h2>Charges</h2>
        {data ? (
          <span className="small muted">
            {formatPaise(data.totalPaise)}
            {data.invoicedPaise > 0 ? ` · ${formatPaise(data.invoicedPaise)} invoiced` : ''}
          </span>
        ) : null}
      </div>

      {charges.isError ? <p className="alert alert--error">Could not load the charges.</p> : null}
      {charges.isPending ? <p>Loading…</p> : null}

      {data ? (
        <>
          {data.uncharged.length > 0 ? (
            <>
              <h3 className="small">Not charged yet</h3>
              <ul className="entries">
                {data.uncharged.map((item) => (
                  <Uncharged key={item.sourceId} encounterId={encounterId} item={item} />
                ))}
              </ul>
            </>
          ) : null}

          <h3 className="small">On this encounter</h3>
          {data.charges.length === 0 ? (
            <p className="muted">Nothing has been charged yet.</p>
          ) : (
            <ul className="entries">
              {data.charges.map((charge) => (
                <ChargeItem key={charge.id} charge={charge} />
              ))}
            </ul>
          )}

          <AddCharge encounterId={encounterId} />
        </>
      ) : null}
    </section>
  );
}

function Uncharged({
  encounterId,
  item,
}: {
  encounterId: string;
  item: UnchargedItem;
}): JSX.Element {
  const catalogue = useCatalogue({ category: item.suggestedCategory });
  const capture = useCaptureCharge();
  const [itemId, setItemId] = useState('');
  const [error, setError] = useState<string | null>(null);

  const options = (catalogue.data?.items ?? []).filter((row) => row.inForce);

  const charge = async () => {
    setError(null);
    try {
      await capture.mutateAsync({
        encounterId,
        itemId,
        quantity: item.quantity,
        source: item.source,
        sourceId: item.sourceId,
      });
    } catch (caught) {
      setError(errorText(caught, 'Could not charge for it'));
    }
  };

  return (
    <li className="entry">
      <div className="entry__header">
        <strong>{item.description}</strong>{' '}
        <span className="tag">{SOURCE_LABELS[item.source]}</span>
      </div>
      <div className="small">
        {formatDateTime(item.at)}
        {item.quantity > 1 ? ` · ${item.quantity} ${item.source === 'bed_day' ? 'days' : ''}` : ''}
      </div>

      {error ? <p className="small alert alert--error">{error}</p> : null}

      <div className="row row--tight">
        <select
          aria-label={`Price list item for ${item.description}`}
          value={itemId}
          onChange={(event) => setItemId(event.target.value)}
        >
          <option value="">
            {options.length === 0
              ? 'Nothing priced in that category'
              : 'Choose from the price list…'}
          </option>
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {`${option.name} · ${formatPaise(option.pricePaise)} per ${option.unit}`}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="small"
          onClick={() => void charge()}
          disabled={itemId === '' || capture.isPending}
        >
          Charge {item.quantity > 1 ? `× ${item.quantity}` : ''}
        </button>
      </div>
    </li>
  );
}

function ChargeItem({ charge }: { charge: Charge }): JSX.Element {
  const voidCharge = useVoidCharge();
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const drop = async () => {
    setError(null);
    try {
      await voidCharge.mutateAsync({ id: charge.id, body: { reason: reason.trim() } });
      setVoiding(false);
    } catch (caught) {
      setError(errorText(caught, 'Could not void the charge'));
    }
  };

  return (
    <li className={`entry${charge.status === 'voided' ? ' entry--muted' : ''}`}>
      <div className="entry__header">
        <strong>{charge.name}</strong> <span className="code">{charge.code}</span>{' '}
        <span className="tag">{CATALOGUE_CATEGORY_LABELS[charge.category]}</span>{' '}
        {charge.status === 'voided' ? <span className="tag tag--danger">Voided</span> : null}
        {charge.status === 'invoiced' ? <span className="tag">Invoiced</span> : null}
      </div>
      <div className="small">
        {charge.quantity} × {formatPaise(charge.unitPricePaise)} ={' '}
        <strong>{formatPaise(charge.amountPaise)}</strong> · {SOURCE_LABELS[charge.source]} ·{' '}
        {formatDateTime(charge.capturedAt)} by {charge.capturedBy.name ?? 'the desk'}
      </div>
      {charge.note ? <p className="small entry__note">{charge.note}</p> : null}
      {charge.voidedReason ? <p className="small muted">Voided: {charge.voidedReason}</p> : null}

      {error ? <p className="small alert alert--error">{error}</p> : null}

      {charge.status === 'captured' ? (
        voiding ? (
          <div className="inline-form">
            <label htmlFor={`void-${charge.id}`}>Why is it being voided?</label>
            <input
              id={`void-${charge.id}`}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Required, e.g. charged to the wrong encounter"
            />
            <div className="row">
              <button
                type="button"
                className="danger small"
                onClick={() => void drop()}
                disabled={reason.trim().length < 3 || voidCharge.isPending}
              >
                Void it
              </button>
              <button type="button" className="ghost small" onClick={() => setVoiding(false)}>
                Keep it
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="ghost small" onClick={() => setVoiding(true)}>
            Void…
          </button>
        )
      ) : null}
    </li>
  );
}

function AddCharge({ encounterId }: { encounterId: string }): JSX.Element {
  const catalogue = useCatalogue();
  const capture = useCaptureCharge();

  const [itemId, setItemId] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const options = (catalogue.data?.items ?? []).filter((item) => item.inForce);

  const add = async () => {
    setError(null);
    try {
      await capture.mutateAsync({
        encounterId,
        itemId,
        quantity,
        source: 'manual',
        note: note.trim() || undefined,
      });
      setItemId('');
      setQuantity(1);
      setNote('');
    } catch (caught) {
      setError(errorText(caught, 'Could not add the charge'));
    }
  };

  return (
    <div className="form">
      <h3 className="small">Add a charge</h3>
      {error ? <p className="alert alert--error">{error}</p> : null}

      <div className="form-grid">
        <div className="field field--wide">
          <label htmlFor={`charge-item-${encounterId}`}>From the price list</label>
          <select
            id={`charge-item-${encounterId}`}
            value={itemId}
            onChange={(event) => setItemId(event.target.value)}
          >
            <option value="">
              {options.length === 0 ? 'The price list is empty' : 'Choose an item…'}
            </option>
            {options.map((item) => (
              <option key={item.id} value={item.id}>
                {`${item.name} · ${formatPaise(item.pricePaise)} per ${item.unit}`}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`charge-quantity-${encounterId}`}>How many</label>
          <input
            id={`charge-quantity-${encounterId}`}
            type="number"
            min={1}
            max={1000}
            value={quantity}
            onChange={(event) => setQuantity(Math.max(1, Number(event.target.value) || 1))}
          />
        </div>
        <div className="field field--wide">
          <label htmlFor={`charge-note-${encounterId}`}>Note (optional)</label>
          <input
            id={`charge-note-${encounterId}`}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </div>
      </div>

      <button
        type="button"
        onClick={() => void add()}
        disabled={itemId === '' || capture.isPending}
      >
        {capture.isPending ? 'Adding…' : 'Add the charge'}
      </button>
    </div>
  );
}
