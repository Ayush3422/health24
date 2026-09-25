import { useState } from 'react';
import { hasPermission, type ReportRange } from '@health24/shared';
import { ApiError } from '../api/client';
import {
  downloadReturnCsv,
  useGenerateReturn,
  useStatutoryReturn,
  useStatutoryReturns,
  useSubmitReturn,
} from '../api/reports';
import { useAuth } from '../auth/AuthProvider';
import { formatDate, formatDateTime, istToday } from '../clinical/format';
import { financialYear, lastMonth } from '../clinical/report-periods';

const errorText = (caught: unknown, fallback: string) =>
  caught instanceof ApiError ? caught.message : fallback;

/**
 * The Ayush morbidity return (sp6-plan.md, T21, DF10).
 *
 * Generated from the coded diagnoses, read before it goes, and kept exactly as
 * it was sent. Corrections made to the record afterwards do not reach back
 * into a return already submitted — which is the point of keeping its contents
 * rather than recomputing them.
 */
export function StatutoryReturnsPage(): JSX.Element {
  const { staff } = useAuth();
  const canSubmit = Boolean(staff && hasPermission(staff.role, 'reports:submit'));

  const returns = useStatutoryReturns();
  const generate = useGenerateReturn();

  const [range, setRange] = useState<ReportRange>(() => lastMonth(istToday()));
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const make = async () => {
    setError(null);

    try {
      const filed = await generate.mutateAsync(range);
      setOpenId(filed.id);
    } catch (caught) {
      setError(errorText(caught, 'Could not generate the return'));
    }
  };

  const filed = returns.data?.returns ?? [];

  return (
    <div className="page page--wide">
      <div className="page-header">
        <h1>Statutory returns</h1>
        <p className="muted small">
          The Ayush morbidity return: counted by NAMASTE code and by the ICD-11 code its mapping
          gave, for a period.
        </p>
      </div>

      {canSubmit ? (
        <div className="form card">
          <h3>Generate a return</h3>
          {error ? <p className="alert alert--error">{error}</p> : null}

          <div className="form-grid">
            <div className="field">
              <label htmlFor="return-from">From</label>
              <input
                id="return-from"
                type="date"
                value={range.from}
                max={istToday()}
                onChange={(event) => setRange({ ...range, from: event.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="return-to">To</label>
              <input
                id="return-to"
                type="date"
                value={range.to}
                max={istToday()}
                onChange={(event) => setRange({ ...range, to: event.target.value })}
              />
            </div>
            <fieldset className="field">
              <legend>Or a period at a time</legend>
              <div className="row row--tight">
                <button
                  type="button"
                  className="ghost small"
                  onClick={() => setRange(lastMonth(istToday()))}
                >
                  Last month
                </button>
                <button
                  type="button"
                  className="ghost small"
                  onClick={() => setRange(financialYear(istToday()))}
                >
                  This financial year
                </button>
              </div>
            </fieldset>
          </div>

          <div className="row">
            <button
              type="button"
              onClick={() => void make()}
              disabled={generate.isPending || range.from > range.to}
            >
              {generate.isPending ? 'Counting…' : 'Generate it'}
            </button>
            <p className="small muted">
              Nothing is sent anywhere. Read it, then record that you submitted it.
            </p>
          </div>
        </div>
      ) : null}

      {returns.isError ? (
        <p className="alert alert--error">
          {errorText(returns.error, 'Could not load the returns')}
        </p>
      ) : null}
      {returns.isPending ? <p>Loading…</p> : null}

      {returns.isSuccess && filed.length === 0 ? (
        <p className="muted">No return has been generated yet.</p>
      ) : null}

      {filed.length > 0 ? (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Period</th>
                <th scope="col">Diagnoses counted</th>
                <th scope="col">Generated</th>
                <th scope="col">Submitted</th>
                <th scope="col">Open</th>
              </tr>
            </thead>
            <tbody>
              {filed.map((entry) => (
                <tr key={entry.id}>
                  <th scope="row">
                    {formatDate(entry.periodFrom)} – {formatDate(entry.periodTo)}
                  </th>
                  <td>{entry.total.toLocaleString('en-IN')}</td>
                  <td className="small">
                    {formatDateTime(entry.generatedAt)}
                    <span className="muted"> by {entry.generatedBy.name ?? 'a colleague'}</span>
                  </td>
                  <td className="small">
                    {entry.submittedAt ? (
                      <>
                        <span className="status status--settled">Submitted</span>
                        <span className="muted"> {formatDate(entry.submittedAt)}</span>
                        {entry.reference ? (
                          <>
                            {' '}
                            <span className="code">{entry.reference}</span>
                          </>
                        ) : null}
                      </>
                    ) : (
                      <span className="status status--unpaid">Not yet</span>
                    )}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="ghost small"
                      onClick={() => setOpenId(openId === entry.id ? null : entry.id)}
                    >
                      {openId === entry.id ? 'Close' : 'Open'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {openId ? <ReturnDetail returnId={openId} canSubmit={canSubmit} /> : null}
    </div>
  );
}

function ReturnDetail({
  returnId,
  canSubmit,
}: {
  returnId: string;
  canSubmit: boolean;
}): JSX.Element {
  const filed = useStatutoryReturn(returnId);
  const submit = useSubmitReturn();

  const [reference, setReference] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (filed.isError) {
    return (
      <p className="alert alert--error">{errorText(filed.error, 'Could not load the return')}</p>
    );
  }

  if (!filed.data) return <p>Loading…</p>;

  const record = filed.data;

  const send = async () => {
    setError(null);

    try {
      await submit.mutateAsync({
        id: record.id,
        body: reference.trim() ? { reference: reference.trim() } : {},
      });
      setReference('');
    } catch (caught) {
      setError(errorText(caught, 'Could not record the submission'));
    }
  };

  const download = async () => {
    setError(null);

    try {
      await downloadReturnCsv(record);
    } catch (caught) {
      setError(errorText(caught, 'Could not download the spreadsheet'));
    }
  };

  return (
    <section className="card">
      <div className="section-heading">
        <h2>
          {formatDate(record.periodFrom)} – {formatDate(record.periodTo)}
        </h2>
        <button type="button" className="ghost small" onClick={() => void download()}>
          Download as a spreadsheet
        </button>
      </div>

      {error ? <p className="alert alert--error">{error}</p> : null}

      <p className="small muted">
        {record.total.toLocaleString('en-IN')} diagnoses, counted as the record stood on{' '}
        {formatDateTime(record.generatedAt)}.
        {record.submittedAt
          ? ` Submitted ${formatDate(record.submittedAt)}${
              record.submittedBy?.name ? ` by ${record.submittedBy.name}` : ''
            }${record.reference ? `, acknowledged as ${record.reference}` : ''}.`
          : ''}
      </p>

      {record.rows.length === 0 ? (
        <p className="muted">No coded diagnosis falls in this period.</p>
      ) : (
        <div className="table-scroll">
          <table className="table table--compact">
            <caption className="small muted">Commonest first</caption>
            <thead>
              <tr>
                <th scope="col">NAMASTE</th>
                <th scope="col">Term</th>
                <th scope="col">ICD-11</th>
                <th scope="col">Total</th>
                <th scope="col">Male</th>
                <th scope="col">Female</th>
                <th scope="col">Other</th>
              </tr>
            </thead>
            <tbody>
              {record.rows.map((row) => (
                <tr key={`${row.namasteCode}:${row.icd11Code ?? 'none'}`}>
                  <th scope="row">
                    <span className="code">{row.namasteCode}</span>
                  </th>
                  <td>{row.namasteDisplay}</td>
                  <td>
                    {row.icd11Code ? (
                      <span className="code">{row.icd11Code}</span>
                    ) : (
                      <span className="small muted">Not mapped</span>
                    )}
                  </td>
                  <td>{row.total}</td>
                  <td>{row.male}</td>
                  <td>{row.female}</td>
                  <td>{row.other}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canSubmit && !record.submittedAt ? (
        <div className="form">
          <h3>Record that it was submitted</h3>
          <div className="row row--tight">
            <input
              aria-label="Acknowledgement number"
              value={reference}
              onChange={(event) => setReference(event.target.value)}
              placeholder="Acknowledgement number, if there is one"
            />
            <button type="button" onClick={() => void send()} disabled={submit.isPending}>
              {submit.isPending ? 'Recording…' : 'It was submitted'}
            </button>
          </div>
          <p className="small muted">
            What is above is kept exactly as it stands now. A diagnosis corrected later will not
            change it.
          </p>
        </div>
      ) : null}
    </section>
  );
}
