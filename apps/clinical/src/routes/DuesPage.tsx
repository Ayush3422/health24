import { Fragment, useState } from 'react';
import { Link } from 'react-router-dom';
import { formatPaise, type InvoiceListItem } from '@health24/shared';
import { ApiError } from '../api/client';
import { useInvoices } from '../api/billing';
import { InvoiceDetail } from '../clinical/Invoices';
import { formatDateTime } from '../clinical/format';

const STANDING_LABELS: Record<InvoiceListItem['standing'], string> = {
  unpaid: 'Unpaid',
  part_paid: 'Part paid',
  settled: 'Settled',
  overpaid: 'Overpaid',
};

/** How long a bill has been outstanding, said the way a person would say it. */
const waited = (issuedAt: string): string => {
  const days = Math.floor((Date.now() - Date.parse(issuedAt)) / 86_400_000);

  if (days < 1) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 31) return `${days} days`;

  const months = Math.floor(days / 30);
  return `${months} month${months === 1 ? '' : 's'}`;
};

/**
 * What the hospital is owed (sp6-plan.md, T18).
 *
 * Every figure here is arithmetic over the ledger, so this page and the
 * invoices it lists cannot disagree about what was paid.
 */
export function DuesPage(): JSX.Element {
  const [scope, setScope] = useState<'outstanding' | 'all'>('outstanding');
  const [open, setOpen] = useState<string | null>(null);
  const invoices = useInvoices(scope);

  const rows = invoices.data?.invoices ?? [];

  return (
    <div className="page">
      <div className="page-header">
        <h1>Bills</h1>
        <div className="field page-header__control">
          <label htmlFor="dues-scope">Show</label>
          <select
            id="dues-scope"
            value={scope}
            onChange={(event) => setScope(event.target.value as 'outstanding' | 'all')}
          >
            <option value="outstanding">Still owed</option>
            <option value="all">Everything billed</option>
          </select>
        </div>
      </div>

      {invoices.isError ? (
        <p className="alert alert--error">
          {invoices.error instanceof ApiError ? invoices.error.message : 'Could not load the bills'}
        </p>
      ) : null}
      {invoices.isPending ? <p>Loading…</p> : null}

      {rows.length > 0 ? (
        <p className="muted small">
          {scope === 'outstanding' ? 'Outstanding' : 'Outstanding across these'}:{' '}
          <strong>{formatPaise(invoices.data!.outstandingPaise)}</strong> over {rows.length} invoice
          {rows.length === 1 ? '' : 's'}.
        </p>
      ) : null}

      {invoices.isSuccess && rows.length === 0 ? (
        <p className="muted">
          {scope === 'outstanding'
            ? 'Nothing is owed. Every bill is settled.'
            : 'Nothing billed yet.'}
        </p>
      ) : null}

      {rows.length > 0 ? (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Invoice</th>
                <th scope="col">Patient</th>
                <th scope="col">Issued</th>
                <th scope="col">Total</th>
                <th scope="col">Outstanding</th>
                <th scope="col">Standing</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((invoice) => (
                // A row and the invoice it opens are one item of the list.
                <Fragment key={invoice.id}>
                  <tr>
                    <td>
                      <button
                        type="button"
                        className="link"
                        onClick={() => setOpen(open === invoice.id ? null : invoice.id)}
                      >
                        {invoice.number}
                      </button>
                    </td>
                    <td>
                      <Link to={`/patients/${invoice.patientId}`}>{invoice.patientName}</Link>
                      {invoice.mrn ? <span className="code"> {invoice.mrn}</span> : null}
                    </td>
                    <td className="small">
                      {formatDateTime(invoice.issuedAt)}
                      {invoice.outstandingPaise > 0 ? (
                        <span className="small muted"> · waiting {waited(invoice.issuedAt)}</span>
                      ) : null}
                    </td>
                    <td>{formatPaise(invoice.totalPaise)}</td>
                    <td>{formatPaise(invoice.outstandingPaise)}</td>
                    <td>
                      <span className={`status status--${invoice.standing}`}>
                        {STANDING_LABELS[invoice.standing]}
                      </span>
                    </td>
                  </tr>
                  {open === invoice.id ? (
                    <tr>
                      <td colSpan={6}>
                        <InvoiceDetail invoiceId={invoice.id} />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
