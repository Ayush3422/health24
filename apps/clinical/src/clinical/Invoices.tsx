import { useState } from 'react';
import {
  formatPaise,
  hasPermission,
  INSURANCE_SCHEME_LABELS,
  INSURANCE_SCHEMES,
  LEDGER_KIND_LABELS,
  paiseFromRupees,
  PAYMENT_METHOD_LABELS,
  PAYMENT_METHODS,
  type InsuranceScheme,
  type Invoice,
  type InvoiceListItem,
  type LedgerKind,
  type PaymentMethod,
} from '@health24/shared';
import { ApiError } from '../api/client';
import {
  useInvoice,
  useInvoices,
  useIssueInvoice,
  useRecordEntry,
  useRecordInsurance,
} from '../api/billing';
import { useAuth } from '../auth/AuthProvider';
import { formatDateTime } from './format';

const errorText = (caught: unknown, fallback: string) =>
  caught instanceof ApiError ? caught.message : fallback;

const STANDING_LABELS: Record<InvoiceListItem['standing'], string> = {
  unpaid: 'Unpaid',
  part_paid: 'Part paid',
  settled: 'Settled',
  overpaid: 'Overpaid',
};

/**
 * Invoices on an encounter (sp6-plan.md, Phase 7).
 *
 * An invoice is issued once and never edited. What happens afterwards is a
 * ledger — money paid, money returned, an amount written off — and every line
 * of it is added, never changed. What is still owed is arithmetic over that,
 * so the screen and the ledger cannot disagree.
 */
export function InvoicesPanel({
  encounterId,
  patientId,
  own,
}: {
  encounterId: string;
  patientId: string;
  own: boolean;
}): JSX.Element | null {
  const { staff } = useAuth();
  const invoices = useInvoices('all', patientId);
  const issue = useIssueInvoice();
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!staff || !own || !hasPermission(staff.role, 'invoices:read')) return null;

  const canIssue = hasPermission(staff.role, 'invoices:issue');
  const forEncounter = (invoices.data?.invoices ?? []).filter(
    (invoice) => invoice.encounterId === encounterId,
  );

  const raise = async () => {
    setError(null);
    try {
      const invoice = await issue.mutateAsync({ encounterId });
      setOpen(invoice.id);
    } catch (caught) {
      setError(errorText(caught, 'Could not issue the invoice'));
    }
  };

  return (
    <section className="card">
      <div className="section-heading">
        <h2>Invoices</h2>
        {canIssue ? (
          <button type="button" onClick={() => void raise()} disabled={issue.isPending}>
            {issue.isPending ? 'Issuing…' : 'Invoice what is captured'}
          </button>
        ) : null}
      </div>

      {error ? <p className="alert alert--error">{error}</p> : null}

      {forEncounter.length === 0 ? (
        <p className="muted">Nothing has been invoiced on this encounter yet.</p>
      ) : (
        <ul className="entries">
          {forEncounter.map((invoice) => (
            <li key={invoice.id} className="entry">
              <div className="entry__header">
                <strong>{invoice.number}</strong>{' '}
                <span className={`status status--${invoice.standing}`}>
                  {STANDING_LABELS[invoice.standing]}
                </span>
              </div>
              <div className="small">
                {formatPaise(invoice.totalPaise)} · {formatPaise(invoice.outstandingPaise)}{' '}
                outstanding · issued {formatDateTime(invoice.issuedAt)} by{' '}
                {invoice.issuedBy.name ?? 'the desk'}
              </div>

              <button
                type="button"
                className="ghost small"
                onClick={() => setOpen(open === invoice.id ? null : invoice.id)}
              >
                {open === invoice.id ? 'Hide' : 'Open'}
              </button>

              {open === invoice.id ? <InvoiceDetail invoiceId={invoice.id} /> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** One invoice: its lines, its ledger, and what may still be done to it. */
export function InvoiceDetail({ invoiceId }: { invoiceId: string }): JSX.Element {
  const { staff } = useAuth();
  const invoice = useInvoice(invoiceId);

  if (invoice.isPending) return <p>Loading…</p>;
  if (invoice.isError || !invoice.data) {
    return <p className="alert alert--error">Could not load the invoice.</p>;
  }

  const canIssue = Boolean(staff && hasPermission(staff.role, 'invoices:issue'));

  return (
    <div className="invoice">
      <table className="table table--compact">
        <thead>
          <tr>
            <th scope="col">Item</th>
            <th scope="col">Quantity</th>
            <th scope="col">Each</th>
            <th scope="col">Amount</th>
          </tr>
        </thead>
        <tbody>
          {invoice.data.lines.map((line) => (
            <tr key={line.id}>
              <td>
                {line.description} <span className="code">{line.code}</span>
              </td>
              <td>{line.quantity}</td>
              <td>{formatPaise(line.unitPricePaise)}</td>
              <td>{formatPaise(line.amountPaise)}</td>
            </tr>
          ))}
          <tr>
            <td colSpan={3}>
              <strong>Total</strong>
            </td>
            <td>
              <strong>{formatPaise(invoice.data.totalPaise)}</strong>
            </td>
          </tr>
        </tbody>
      </table>

      <h4>Money</h4>
      {invoice.data.ledger.length === 0 ? (
        <p className="muted small">Nothing has been paid against it yet.</p>
      ) : (
        <ul className="items">
          {invoice.data.ledger.map((entry) => (
            <li key={entry.id}>
              <strong>{LEDGER_KIND_LABELS[entry.kind]}</strong> {formatPaise(entry.amountPaise)}
              <span className="item__meta">
                {[
                  entry.method ? PAYMENT_METHOD_LABELS[entry.method] : null,
                  entry.reference,
                  formatDateTime(entry.at),
                  entry.takenBy.name,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
              {entry.note ? <span className="item__detail">{entry.note}</span> : null}
            </li>
          ))}
        </ul>
      )}

      <p className="small">
        <strong>
          {invoice.data.outstandingPaise > 0
            ? `${formatPaise(invoice.data.outstandingPaise)} still to pay`
            : 'Nothing outstanding'}
        </strong>
      </p>

      {invoice.data.insurance.length > 0 ? (
        <>
          <h4>Scheme</h4>
          <ul className="items">
            {invoice.data.insurance.map((claim) => (
              <li key={claim.id}>
                <strong>{INSURANCE_SCHEME_LABELS[claim.scheme]}</strong>
                <span className="item__meta">
                  {[
                    claim.insurer,
                    claim.policyOrCard,
                    claim.approvedPaise === null
                      ? 'claimed'
                      : `approved ${formatPaise(claim.approvedPaise)}`,
                    formatDateTime(claim.recordedAt),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {canIssue ? <LedgerForms invoice={invoice.data} /> : null}
    </div>
  );
}

function LedgerForms({ invoice }: { invoice: Invoice }): JSX.Element {
  const record = useRecordEntry();
  const insure = useRecordInsurance();

  const [kind, setKind] = useState<LedgerKind>('payment');
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [reason, setReason] = useState('');
  const [scheme, setScheme] = useState<InsuranceScheme>('pmjay');
  const [policy, setPolicy] = useState('');
  const [approved, setApproved] = useState('');
  const [error, setError] = useState<string | null>(null);

  const take = async () => {
    setError(null);
    const paise = paiseFromRupees(amount);

    if (paise === null || paise <= 0) {
      setError('Type the amount in rupees, like 500 or 500.50');
      return;
    }

    try {
      await record.mutateAsync({
        id: invoice.id,
        body:
          kind === 'credit_note'
            ? { kind, amountPaise: paise, reason: reason.trim() }
            : { kind, method, amountPaise: paise, reference: reference.trim() || undefined },
      });
      setAmount('');
      setReference('');
      setReason('');
    } catch (caught) {
      setError(errorText(caught, 'Could not record it'));
    }
  };

  const claim = async () => {
    setError(null);
    const typed = approved.trim() ? paiseFromRupees(approved) : null;

    if (approved.trim() && typed === null) {
      setError('Type what the scheme approved in rupees, or leave it blank');
      return;
    }

    try {
      await insure.mutateAsync({
        id: invoice.id,
        body: {
          scheme,
          policyOrCard: policy.trim() || undefined,
          ...(typed === null ? {} : { approvedPaise: typed }),
        },
      });
      setApproved('');
    } catch (caught) {
      setError(errorText(caught, 'Could not record the claim'));
    }
  };

  return (
    <div className="form">
      <h4>Record money</h4>
      {error ? <p className="alert alert--error">{error}</p> : null}

      <div className="form-grid">
        <div className="field">
          <label htmlFor={`kind-${invoice.id}`}>What</label>
          <select
            id={`kind-${invoice.id}`}
            value={kind}
            onChange={(event) => setKind(event.target.value as LedgerKind)}
          >
            {(['payment', 'refund', 'credit_note'] as const).map((value) => (
              <option key={value} value={value}>
                {LEDGER_KIND_LABELS[value]}
              </option>
            ))}
          </select>
        </div>

        {kind === 'credit_note' ? null : (
          <div className="field">
            <label htmlFor={`method-${invoice.id}`}>How</label>
            <select
              id={`method-${invoice.id}`}
              value={method}
              onChange={(event) => setMethod(event.target.value as PaymentMethod)}
            >
              {PAYMENT_METHODS.map((value) => (
                <option key={value} value={value}>
                  {PAYMENT_METHOD_LABELS[value]}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="field">
          <label htmlFor={`amount-${invoice.id}`}>Amount (₹)</label>
          <input
            id={`amount-${invoice.id}`}
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            inputMode="decimal"
            placeholder="500"
          />
        </div>

        {kind === 'credit_note' ? (
          <div className="field field--wide">
            <label htmlFor={`reason-${invoice.id}`}>Why is it being credited?</label>
            <input
              id={`reason-${invoice.id}`}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Required, e.g. charged twice"
            />
          </div>
        ) : (
          <div className="field">
            <label htmlFor={`reference-${invoice.id}`}>Reference</label>
            <input
              id={`reference-${invoice.id}`}
              value={reference}
              onChange={(event) => setReference(event.target.value)}
              placeholder="UPI or receipt number"
            />
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={() => void take()}
        disabled={
          record.isPending ||
          amount.trim() === '' ||
          (kind === 'credit_note' && reason.trim().length < 3)
        }
      >
        {record.isPending ? 'Recording…' : 'Record it'}
      </button>

      <h4>Scheme or insurer</h4>
      <div className="form-grid">
        <div className="field">
          <label htmlFor={`scheme-${invoice.id}`}>Scheme</label>
          <select
            id={`scheme-${invoice.id}`}
            value={scheme}
            onChange={(event) => setScheme(event.target.value as InsuranceScheme)}
          >
            {INSURANCE_SCHEMES.map((value) => (
              <option key={value} value={value}>
                {INSURANCE_SCHEME_LABELS[value]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`policy-${invoice.id}`}>Policy or card</label>
          <input
            id={`policy-${invoice.id}`}
            value={policy}
            onChange={(event) => setPolicy(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={`approved-${invoice.id}`}>Approved (₹, if known)</label>
          <input
            id={`approved-${invoice.id}`}
            value={approved}
            onChange={(event) => setApproved(event.target.value)}
            inputMode="decimal"
          />
        </div>
      </div>

      <button
        type="button"
        className="ghost"
        onClick={() => void claim()}
        disabled={insure.isPending}
      >
        Record the claim
      </button>
    </div>
  );
}
