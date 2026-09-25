import { useState } from 'react';
import {
  CATALOGUE_CATEGORIES,
  CATALOGUE_CATEGORY_LABELS,
  formatPaise,
  hasPermission,
  paiseFromRupees,
  type CatalogueCategory,
  type CatalogueItem,
} from '@health24/shared';
import { ApiError } from '../api/client';
import { useAddCatalogueItem, useCatalogue, useRepriceItem, useRetireItem } from '../api/billing';
import { useAuth } from '../auth/AuthProvider';
import { useDebouncedValue } from '../clinical/useDebouncedValue';
import { formatDate } from '../clinical/format';

const errorText = (caught: unknown, fallback: string) =>
  caught instanceof ApiError ? caught.message : fallback;

/**
 * What the hospital charges for, and what it costs (sp6-plan.md, T14).
 *
 * A price is never overwritten: repricing closes the row in force and opens
 * another, so an invoice raised last month still reads against the price that
 * stood then. This page shows what is in force; the history is a click away.
 */
export function CataloguePage(): JSX.Element {
  const { staff } = useAuth();
  const [category, setCategory] = useState<CatalogueCategory | ''>('');
  const [term, setTerm] = useState('');
  const [history, setHistory] = useState(false);
  const [adding, setAdding] = useState(false);

  const q = useDebouncedValue(term, 300);
  const catalogue = useCatalogue({
    ...(category ? { category } : {}),
    ...(q.trim() ? { q: q.trim() } : {}),
    history,
  });

  const canManage = Boolean(staff && hasPermission(staff.role, 'catalogue:manage'));
  const items = catalogue.data?.items ?? [];

  return (
    <div className="page">
      <div className="page-header">
        <h1>Price list</h1>
        {canManage && !adding ? (
          <button type="button" onClick={() => setAdding(true)}>
            Add an item
          </button>
        ) : null}
      </div>

      {adding ? <ItemForm onDone={() => setAdding(false)} /> : null}

      <div className="form card">
        <div className="form-grid">
          <div className="field">
            <label htmlFor="catalogue-search">Search</label>
            <input
              id="catalogue-search"
              value={term}
              onChange={(event) => setTerm(event.target.value)}
              placeholder="Name or code"
            />
          </div>
          <div className="field">
            <label htmlFor="catalogue-category">Category</label>
            <select
              id="catalogue-category"
              value={category}
              onChange={(event) => setCategory(event.target.value as CatalogueCategory | '')}
            >
              <option value="">Everything</option>
              {CATALOGUE_CATEGORIES.map((value) => (
                <option key={value} value={value}>
                  {CATALOGUE_CATEGORY_LABELS[value]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="choice-row" htmlFor="catalogue-history">
              <input
                id="catalogue-history"
                type="checkbox"
                checked={history}
                onChange={(event) => setHistory(event.target.checked)}
              />
              Show past prices and retired items
            </label>
          </div>
        </div>
      </div>

      {catalogue.isError ? (
        <p className="alert alert--error">
          {errorText(catalogue.error, 'Could not load the price list')}
        </p>
      ) : null}
      {catalogue.isPending ? <p>Loading…</p> : null}

      {catalogue.isSuccess && items.length === 0 ? (
        <p className="muted">
          {canManage
            ? 'Nothing in the price list yet. Add what the hospital charges for.'
            : 'The price list is empty.'}
        </p>
      ) : null}

      {items.length > 0 ? (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Code</th>
                <th scope="col">Item</th>
                <th scope="col">Category</th>
                <th scope="col">Price</th>
                <th scope="col">In force</th>
                {canManage ? <th scope="col">Change</th> : null}
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <ItemRow key={item.id} item={item} canManage={canManage} />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

function ItemRow({ item, canManage }: { item: CatalogueItem; canManage: boolean }): JSX.Element {
  const reprice = useRepriceItem();
  const retire = useRetireItem();
  const [price, setPrice] = useState('');
  const [error, setError] = useState<string | null>(null);

  const change = async () => {
    setError(null);
    const paise = paiseFromRupees(price);

    if (paise === null) {
      setError('Type the price in rupees, like 1250 or 1250.50');
      return;
    }

    try {
      await reprice.mutateAsync({ id: item.id, body: { pricePaise: paise } });
      setPrice('');
    } catch (caught) {
      setError(errorText(caught, 'Could not change the price'));
    }
  };

  const stop = async () => {
    setError(null);
    try {
      await retire.mutateAsync({ id: item.id, body: {} });
    } catch (caught) {
      setError(errorText(caught, 'Could not retire the item'));
    }
  };

  return (
    <tr>
      <td>
        <span className="code">{item.code}</span>
      </td>
      <td>
        {item.name}
        <span className="small muted"> per {item.unit}</span>
      </td>
      <td>{CATALOGUE_CATEGORY_LABELS[item.category]}</td>
      <td>{formatPaise(item.pricePaise)}</td>
      <td className="small">
        {formatDate(item.activeFrom)} – {item.activeTo ? formatDate(item.activeTo) : 'now'}
        {item.inForce ? <span className="tag">In force</span> : null}
      </td>
      {canManage ? (
        <td>
          {item.activeTo ? (
            <span className="small muted">Closed</span>
          ) : (
            <>
              {error ? <p className="small alert alert--error">{error}</p> : null}
              <div className="row row--tight">
                <input
                  aria-label={`New price for ${item.name}`}
                  value={price}
                  onChange={(event) => setPrice(event.target.value)}
                  placeholder="New price ₹"
                />
                <button
                  type="button"
                  className="small"
                  onClick={() => void change()}
                  disabled={reprice.isPending || price.trim() === ''}
                >
                  Reprice
                </button>
                <button
                  type="button"
                  className="ghost small"
                  onClick={() => void stop()}
                  disabled={retire.isPending}
                >
                  Retire
                </button>
              </div>
              <p className="small muted">A new price starts tomorrow, and this one closes today.</p>
            </>
          )}
        </td>
      ) : null}
    </tr>
  );
}

function ItemForm({ onDone }: { onDone: () => void }): JSX.Element {
  const add = useAddCatalogueItem();

  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [category, setCategory] = useState<CatalogueCategory>('consultation');
  const [unit, setUnit] = useState('each');
  const [price, setPrice] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    const paise = paiseFromRupees(price);

    if (paise === null) {
      setError('Type the price in rupees, like 300 or 300.50');
      return;
    }

    try {
      await add.mutateAsync({
        code: code.trim(),
        name: name.trim(),
        category,
        unit: unit.trim() || 'each',
        pricePaise: paise,
      });
      onDone();
    } catch (caught) {
      setError(errorText(caught, 'Could not add the item'));
    }
  };

  return (
    <div className="form card">
      <h3>Add an item</h3>
      {error ? <p className="alert alert--error">{error}</p> : null}

      <div className="form-grid">
        <div className="field">
          <label htmlFor="item-code">Code</label>
          <input
            id="item-code"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder="e.g. OPD-GEN"
          />
        </div>
        <div className="field field--wide">
          <label htmlFor="item-name">Item</label>
          <input
            id="item-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. General consultation"
          />
        </div>
        <div className="field">
          <label htmlFor="item-category">Category</label>
          <select
            id="item-category"
            value={category}
            onChange={(event) => setCategory(event.target.value as CatalogueCategory)}
          >
            {CATALOGUE_CATEGORIES.map((value) => (
              <option key={value} value={value}>
                {CATALOGUE_CATEGORY_LABELS[value]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="item-unit">One of it is</label>
          <input
            id="item-unit"
            value={unit}
            onChange={(event) => setUnit(event.target.value)}
            placeholder="visit, test, day"
          />
        </div>
        <div className="field">
          <label htmlFor="item-price">Price (₹)</label>
          <input
            id="item-price"
            value={price}
            onChange={(event) => setPrice(event.target.value)}
            placeholder="300"
            inputMode="decimal"
          />
        </div>
      </div>

      <div className="row">
        <button
          type="button"
          onClick={() => void submit()}
          disabled={add.isPending || code.trim() === '' || name.trim().length < 2}
        >
          {add.isPending ? 'Adding…' : 'Add it'}
        </button>
        <button type="button" className="ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}
