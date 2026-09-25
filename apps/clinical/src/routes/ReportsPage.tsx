import { useState } from 'react';
import {
  formatPaise,
  type CountRow,
  type DataQualityReport,
  type DiagnosisReport,
  type FootfallReport,
  type PrescriptionReport,
  type ReportRange,
  type RevenueReport,
} from '@health24/shared';
import { ApiError } from '../api/client';
import {
  useDataQuality,
  useDiagnosisReport,
  useFootfall,
  usePrescriptionReport,
  useRevenueReport,
} from '../api/reports';
import { DayBars } from '../clinical/DayBars';
import { istToday } from '../clinical/format';
import { QUICK_RANGES, defaultRange } from '../clinical/report-periods';

const errorText = (caught: unknown, fallback: string) =>
  caught instanceof ApiError ? caught.message : fallback;

type Tab = 'footfall' | 'diagnoses' | 'prescriptions' | 'revenue' | 'quality';

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'footfall', label: 'Visits' },
  { key: 'diagnoses', label: 'Diagnoses' },
  { key: 'prescriptions', label: 'Prescriptions' },
  { key: 'revenue', label: 'Money' },
  { key: 'quality', label: 'What is unfinished' },
];

const BREAKDOWNS: Array<{ key: 'class' | 'system' | 'clinician'; label: string }> = [
  { key: 'class', label: 'Outpatient or inpatient' },
  { key: 'system', label: 'System of medicine' },
  { key: 'clinician', label: 'Clinician' },
];

/**
 * The hospital's own numbers (sp6-plan.md, Phase 8).
 *
 * Counted from the record rather than kept beside it, so a figure here can
 * always be traced to the encounters, diagnoses and invoices it was counted
 * from — and never quietly disagrees with them.
 */
export function ReportsPage(): JSX.Element {
  const [range, setRange] = useState<ReportRange>(defaultRange);
  const [tab, setTab] = useState<Tab>('footfall');

  const backwards = range.from > range.to;

  return (
    <div className="page page--wide">
      <div className="page-header">
        <h1>Reports</h1>
        <p className="muted small">
          Counted from this hospital's own record, and nobody else's.
        </p>
      </div>

      <div className="form card">
        <div className="form-grid">
          <div className="field">
            <label htmlFor="report-from">From</label>
            <input
              id="report-from"
              type="date"
              value={range.from}
              max={istToday()}
              onChange={(event) => setRange({ ...range, from: event.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="report-to">To</label>
            <input
              id="report-to"
              type="date"
              value={range.to}
              max={istToday()}
              onChange={(event) => setRange({ ...range, to: event.target.value })}
            />
          </div>
          <fieldset className="field field--wide">
            <legend>Or a period at a time</legend>
            <div className="row row--tight">
              {QUICK_RANGES.map((quick) => (
                <button
                  key={quick.label}
                  type="button"
                  className="ghost small"
                  onClick={() => setRange(quick.range(istToday()))}
                >
                  {quick.label}
                </button>
              ))}
            </div>
          </fieldset>
        </div>
        {backwards ? (
          <p className="alert alert--warning">The period ends before it starts.</p>
        ) : null}
      </div>

      <div className="tabs" role="tablist" aria-label="Reports">
        {TABS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            role="tab"
            aria-selected={tab === entry.key}
            onClick={() => setTab(entry.key)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {backwards ? null : (
        <>
          {tab === 'footfall' ? <Footfall range={range} /> : null}
          {tab === 'diagnoses' ? <Diagnoses range={range} /> : null}
          {tab === 'prescriptions' ? <Prescriptions range={range} /> : null}
          {tab === 'revenue' ? <Revenue range={range} /> : null}
          {tab === 'quality' ? <DataQuality /> : null}
        </>
      )}
    </div>
  );
}

/** One big number and what it counts. */
function Figure({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="figure">
      <span className="figure__value">{value}</span>
      <span className="figure__label">{label}</span>
    </div>
  );
}

function Loading({
  query,
  fallback,
}: {
  query: { isPending: boolean; isError: boolean; error: unknown };
  fallback: string;
}): JSX.Element | null {
  if (query.isError) return <p className="alert alert--error">{errorText(query.error, fallback)}</p>;
  if (query.isPending) return <p>Loading…</p>;
  return null;
}

function CountTable({
  rows,
  heading,
  caption,
}: {
  rows: CountRow[];
  heading: string;
  caption: string;
}): JSX.Element {
  if (rows.length === 0) return <p className="muted">Nothing in this period.</p>;

  return (
    <div className="table-scroll">
      <table className="table">
        <caption className="small muted">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">{heading}</th>
            <th scope="col">Count</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <th scope="row">{row.label}</th>
              <td>{row.count.toLocaleString('en-IN')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Footfall({ range }: { range: ReportRange }): JSX.Element {
  const [by, setBy] = useState<'class' | 'system' | 'clinician'>('class');
  const report = useFootfall(range, by);
  const data: FootfallReport | undefined = report.data;

  return (
    <section className="card">
      <h2>Visits</h2>
      <Loading query={report} fallback="Could not count the visits" />

      {data ? (
        <>
          <div className="figures">
            <Figure label="Encounters in the period" value={data.total.toLocaleString('en-IN')} />
          </div>

          <DayBars
            caption="Encounters"
            points={data.byDay.map((day) => ({ date: day.date, value: day.count }))}
          />

          <div className="field">
            <label htmlFor="footfall-by">Broken down by</label>
            <select
              id="footfall-by"
              value={by}
              onChange={(event) => setBy(event.target.value as typeof by)}
            >
              {BREAKDOWNS.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <CountTable
            rows={data.breakdown}
            heading={BREAKDOWNS.find((option) => option.key === by)!.label}
            caption="Encounters in the period"
          />
        </>
      ) : null}
    </section>
  );
}

function Diagnoses({ range }: { range: ReportRange }): JSX.Element {
  const report = useDiagnosisReport(range);
  const data: DiagnosisReport | undefined = report.data;

  return (
    <section className="card">
      <h2>Diagnoses</h2>
      <p className="muted small">
        Counted from the codes on them: the clinician's own NAMASTE term, and the ICD-11 code the
        mapping gave it.
      </p>
      <Loading query={report} fallback="Could not count the diagnoses" />

      {data ? (
        <>
          <div className="figures">
            <Figure label="Diagnoses recorded" value={data.total.toLocaleString('en-IN')} />
            <Figure
              label="Without an ICD-11 code"
              value={data.diagnoses
                .filter((row) => row.icd11Code === null)
                .reduce((sum, row) => sum + row.count, 0)
                .toLocaleString('en-IN')}
            />
          </div>

          {data.diagnoses.length === 0 ? (
            <p className="muted">Nothing in this period.</p>
          ) : (
            <div className="table-scroll">
              <table className="table">
                <caption className="small muted">Commonest first</caption>
                <thead>
                  <tr>
                    <th scope="col">Diagnosis</th>
                    <th scope="col">Code</th>
                    <th scope="col">ICD-11</th>
                    <th scope="col">Count</th>
                  </tr>
                </thead>
                <tbody>
                  {data.diagnoses.map((row) => (
                    <tr key={`${row.system}:${row.key}`}>
                      <th scope="row">{row.label}</th>
                      <td>
                        <span className="code">{row.key}</span>
                      </td>
                      <td>
                        {row.icd11Code ? (
                          <>
                            <span className="code">{row.icd11Code}</span>
                            {row.icd11Display ? (
                              <span className="small muted"> {row.icd11Display}</span>
                            ) : null}
                          </>
                        ) : (
                          <span className="small muted">Not mapped</span>
                        )}
                      </td>
                      <td>{row.count.toLocaleString('en-IN')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}

function Prescriptions({ range }: { range: ReportRange }): JSX.Element {
  const report = usePrescriptionReport(range);
  const data: PrescriptionReport | undefined = report.data;

  return (
    <section className="card">
      <h2>Prescriptions</h2>
      <Loading query={report} fallback="Could not count the prescriptions" />

      {data ? (
        <>
          <div className="figures">
            <Figure label="Prescriptions written" value={data.total.toLocaleString('en-IN')} />
          </div>

          <div className="report-columns">
            <CountTable rows={data.medicines} heading="Medicine" caption="Most prescribed first" />
            <CountTable
              rows={data.bySystem}
              heading="System of medicine"
              caption="Prescriptions by the system they belong to"
            />
          </div>
        </>
      ) : null}
    </section>
  );
}

function Revenue({ range }: { range: ReportRange }): JSX.Element {
  const report = useRevenueReport(range);
  const data: RevenueReport | undefined = report.data;

  return (
    <section className="card">
      <h2>Money</h2>
      <p className="muted small">
        What was invoiced in the period, and what has been received against it since.
      </p>
      <Loading query={report} fallback="Could not count the money" />

      {data ? (
        <>
          <div className="figures">
            <Figure label="Invoiced" value={formatPaise(data.invoicedPaise)} />
            <Figure label="Received" value={formatPaise(data.receivedPaise)} />
            <Figure label="Credited back" value={formatPaise(data.creditedPaise)} />
            <Figure label="Still owed" value={formatPaise(data.outstandingPaise)} />
          </div>

          <DayBars
            caption="Invoiced"
            points={data.byDay.map((day) => ({ date: day.date, value: day.invoicedPaise }))}
            format={(value) => formatPaise(value)}
          />

          <div className="report-columns">
            <MoneyTable
              rows={data.byCategory}
              heading="What it was for"
              caption="Charges invoiced in the period"
            />
            <MoneyTable
              rows={data.byMethod}
              heading="How it came in"
              caption="Received in the period"
            />
          </div>
        </>
      ) : null}
    </section>
  );
}

function MoneyTable({
  rows,
  heading,
  caption,
}: {
  rows: Array<{ key: string; label: string; amountPaise: number }>;
  heading: string;
  caption: string;
}): JSX.Element {
  if (rows.length === 0) return <p className="muted">Nothing in this period.</p>;

  return (
    <div className="table-scroll">
      <table className="table">
        <caption className="small muted">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">{heading}</th>
            <th scope="col">Amount</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <th scope="row">{row.label}</th>
              <td>{formatPaise(row.amountPaise)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * What the record itself says is unfinished.
 *
 * Not a scolding: every line here is something somebody can put right, which
 * is why each carries a sentence saying what to do about it.
 */
function DataQuality(): JSX.Element {
  const report = useDataQuality();
  const data: DataQualityReport | undefined = report.data;

  return (
    <section className="card">
      <h2>What is unfinished</h2>
      <p className="muted small">
        As the record stands now, not over the period above.
      </p>
      <Loading query={report} fallback="Could not check the record" />

      {data ? (
        <ul className="quality-list">
          {data.checks.map((check) => (
            <li key={check.key} className={check.count > 0 ? 'quality--open' : 'quality--clear'}>
              <span className="quality__count">{check.count.toLocaleString('en-IN')}</span>
              <div>
                <strong>{check.label}</strong>
                <p className="small muted">{check.explanation}</p>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
