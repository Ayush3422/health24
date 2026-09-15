import { useState } from 'react';
import {
  LAB_PANELS,
  LAB_PANEL_KEYS,
  hasPermission,
  type LabAnalyte,
  type LabPanelKey,
  type ResultSet,
} from '@health24/shared';
import { ApiError } from '../api/client';
import {
  usePatientDocuments,
  usePatientResults,
  useMarkResultsInError,
  useRecordResults,
  useResultTrend,
} from '../api/records';
import { useAuth } from '../auth/AuthProvider';
import { formatDate, formatDateTime, istToday, optionalText } from './format';
import { SharingNote } from './Provenance';
import { Flag, TrendChart } from './TrendChart';

const analytesOf = (panel: LabPanelKey) => LAB_PANELS[panel].analytes as readonly LabAnalyte[];

const errorText = (caught: unknown, fallback: string) => {
  if (caught instanceof ApiError) {
    const fields = caught.fieldErrors.map((issue) => issue.message);
    return fields.length > 0 ? fields.join('; ') : caught.message;
  }
  return fallback;
};

/**
 * Lab results (SP4): typed from a report by the front desk, records staff or a
 * clinician; read, with trends, by roles that read clinical records
 * (Decision H1).
 */
export function PatientResults({ patientId }: { patientId: string }): JSX.Element | null {
  const { staff } = useAuth();
  if (!staff) return null;

  const canEnter = hasPermission(staff.role, 'results:enter');
  const canRead = hasPermission(staff.role, 'clinical:read');
  if (!canEnter && !canRead) return null;

  return <ResultsSection patientId={patientId} canEnter={canEnter} canRead={canRead} />;
}

function ResultsSection({
  patientId,
  canEnter,
  canRead,
}: {
  patientId: string;
  canEnter: boolean;
  canRead: boolean;
}): JSX.Element {
  const [entering, setEntering] = useState(false);
  const [justRecorded, setJustRecorded] = useState<ResultSet | null>(null);
  const [trendCode, setTrendCode] = useState<string | null>(null);
  const results = usePatientResults(patientId, canRead);
  const sets = results.data?.sets ?? [];

  return (
    <section className="card">
      <div className="section-heading">
        <h2>Lab results</h2>
        {canEnter && !entering ? (
          <button
            type="button"
            onClick={() => {
              setEntering(true);
              setJustRecorded(null);
            }}
          >
            Enter results
          </button>
        ) : null}
      </div>

      {entering ? (
        <EnterResultsForm
          patientId={patientId}
          onDone={(set) => {
            setEntering(false);
            setJustRecorded(set);
          }}
          onCancel={() => setEntering(false)}
        />
      ) : null}

      {/* The front desk sees what it has just typed, and nothing else (Decision H1). */}
      {justRecorded && !canRead ? (
        <div className="subpanel">
          <p className="alert alert--success">Results recorded. Check them against the report:</p>
          <ResultSetView set={justRecorded} canTrend={false} canWithdraw={false} onTrend={() => undefined} />
        </div>
      ) : null}

      {canRead && trendCode ? (
        <TrendPanel patientId={patientId} code={trendCode} onClose={() => setTrendCode(null)} />
      ) : null}

      {canRead ? (
        <>
          {results.isPending ? <p className="muted">Loading…</p> : null}
          {results.isError ? <p className="alert alert--error">Could not load lab results.</p> : null}
          {results.isSuccess && sets.length === 0 ? <p className="muted">No lab results recorded.</p> : null}
          {sets.map((set) => (
            <ResultSetView
              key={set.id}
              set={set}
              canTrend
              canWithdraw={canEnter && set.hospital.isOwn}
              onTrend={setTrendCode}
            />
          ))}
          {results.isSuccess ? (
            <SharingNote shared={results.data.sharedFromOtherHospitals} what="Lab results" />
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function TrendPanel({
  patientId,
  code,
  onClose,
}: {
  patientId: string;
  code: string;
  onClose: () => void;
}): JSX.Element {
  const trend = useResultTrend(patientId, code);

  return (
    <div className="subpanel trend-panel">
      <div className="section-heading">
        <h3>Trend</h3>
        <button type="button" className="ghost small" onClick={onClose}>
          Close trend
        </button>
      </div>
      {trend.isPending ? <p className="muted">Loading…</p> : null}
      {trend.isError ? <p className="alert alert--error">Could not load the trend.</p> : null}
      {trend.isSuccess ? (
        trend.data.points.length === 0 ? (
          <p className="muted">No results for this test.</p>
        ) : (
          <>
            <TrendChart trend={trend.data} />
            <SharingNote shared={trend.data.sharedFromOtherHospitals} what="Lab results" />
          </>
        )
      ) : null}
    </div>
  );
}

function rangeOf(result: ResultSet['results'][number]): string {
  if (result.referenceLow !== null && result.referenceHigh !== null) {
    return `${result.referenceLow}–${result.referenceHigh} ${result.unit}`;
  }
  if (result.referenceHigh !== null) return `below ${result.referenceHigh} ${result.unit}`;
  if (result.referenceLow !== null) return `above ${result.referenceLow} ${result.unit}`;
  return result.referenceText ?? '—';
}

function ResultSetView({
  set,
  canTrend,
  canWithdraw,
  onTrend,
}: {
  set: ResultSet;
  canTrend: boolean;
  canWithdraw: boolean;
  onTrend: (code: string) => void;
}): JSX.Element {
  const withdraw = useMarkResultsInError();
  const [withdrawing, setWithdrawing] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    try {
      await withdraw.mutateAsync({ id: set.id, reason: reason.trim() });
    } catch (caught) {
      setError(errorText(caught, 'Could not withdraw these results'));
    }
  };

  return (
    <article className="result-set">
      <header className="result-set__header">
        <strong>{set.panelLabel}</strong>
        <span className="small muted">
          collected {formatDateTime(set.collectedAt)}
          {set.performingFacility ? ` · ${set.performingFacility}` : ''}
          {` · typed by ${set.recordedBy.name ?? 'staff'}`}
        </span>
        {set.hospital.isOwn ? null : <em className="tag tag--shared">{set.hospital.name}</em>}
      </header>

      <div className="table-scroll">
        <table className="table table--compact">
          <thead>
            <tr>
              <th scope="col">Test</th>
              <th scope="col">Result</th>
              <th scope="col">Reference range</th>
              <th scope="col">Flag</th>
              {canTrend ? <th scope="col" aria-label="Trend" /> : null}
            </tr>
          </thead>
          <tbody>
            {set.results.map((result) => (
              <tr key={result.observationId}>
                <td>{result.label}</td>
                <td>
                  {`${result.value} ${result.unit}`}
                  {result.unit !== result.unitCanonical ? (
                    <span className="small muted">{` (${result.valueCanonical} ${result.unitCanonical})`}</span>
                  ) : null}
                </td>
                <td>{rangeOf(result)}</td>
                <td>
                  <Flag interpretation={result.interpretation} />
                  {result.labFlag ? <span className="small muted">{` lab: ${result.labFlag}`}</span> : null}
                </td>
                {canTrend ? (
                  <td>
                    <button type="button" className="ghost small" onClick={() => onTrend(result.code)}>
                      Trend
                    </button>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {canWithdraw ? (
        withdrawing ? (
          <div className="inline-form-block">
            {error ? <p className="alert alert--error">{error}</p> : null}
            <div className="field">
              <label htmlFor={`withdraw-results-${set.id}`}>
                Why were these results entered in error? Type them again afterwards.
              </label>
              <input id={`withdraw-results-${set.id}`} value={reason} onChange={(event) => setReason(event.target.value)} />
            </div>
            <div className="row">
              <button type="button" className="danger" onClick={() => void submit()} disabled={reason.trim().length < 3 || withdraw.isPending}>
                {withdraw.isPending ? 'Saving…' : 'Mark entered in error'}
              </button>
              <button type="button" className="ghost" onClick={() => setWithdrawing(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="ghost small" onClick={() => setWithdrawing(true)}>
            Entered in error…
          </button>
        )
      ) : null}
    </article>
  );
}

type Row = { value: string; unit: string; low: string; high: string; flag: string };

const blankRows = (panel: LabPanelKey): Record<string, Row> =>
  Object.fromEntries(
    analytesOf(panel).map((analyte) => [
      analyte.code,
      {
        value: '',
        unit: analyte.units[0].code,
        low: analyte.defaultRange?.low?.toString() ?? '',
        high: analyte.defaultRange?.high?.toString() ?? '',
        flag: '',
      },
    ]),
  );

function EnterResultsForm({
  patientId,
  onDone,
  onCancel,
}: {
  patientId: string;
  onDone: (set: ResultSet) => void;
  onCancel: () => void;
}): JSX.Element {
  const record = useRecordResults();
  const reports = usePatientDocuments(patientId, {
    types: ['lab_report'],
    from: '',
    to: '',
    scope: 'own',
  });

  const [panel, setPanel] = useState<LabPanelKey>('lft');
  const [rows, setRows] = useState<Record<string, Row>>(() => blankRows('lft'));
  const [date, setDate] = useState(istToday());
  const [time, setTime] = useState('09:00');
  const [reportId, setReportId] = useState('');
  const [facility, setFacility] = useState('');
  const [error, setError] = useState<string | null>(null);

  const change = (code: string, patch: Partial<Row>) =>
    setRows((current) => ({ ...current, [code]: { ...current[code]!, ...patch } }));

  const filled = analytesOf(panel).filter((analyte) => rows[analyte.code]?.value.trim());

  const submit = async () => {
    setError(null);

    try {
      const set = await record.mutateAsync({
        patientId,
        panel,
        collectedAt: `${date}T${time}:00+05:30`,
        documentId: reportId || undefined,
        performingFacility: optionalText(facility),
        results: filled.map((analyte) => {
          const row = rows[analyte.code]!;
          return {
            code: analyte.code,
            value: Number(row.value),
            unit: row.unit,
            referenceLow: row.low.trim() ? Number(row.low) : undefined,
            referenceHigh: row.high.trim() ? Number(row.high) : undefined,
            labFlag: optionalText(row.flag),
          };
        }),
      });
      onDone(set);
    } catch (caught) {
      setError(errorText(caught, 'Could not record the results'));
    }
  };

  const reportOptions = (reports.data?.results ?? []).filter(
    (document) => document.availability !== 'abandoned' && document.availability !== 'quarantined',
  );

  return (
    <div className="form inline-form-block results-entry">
      <h3>Enter lab results</h3>
      <p className="small muted">
        Type the values and the reference range exactly as printed on the report. Leave a test blank
        if it was not done. Ranges are prefilled with typical adult values — replace them with the
        report’s.
      </p>
      {error ? <p className="alert alert--error">{error}</p> : null}

      <div className="form-grid form-grid--four">
        <div className="field">
          <label htmlFor="results-panel">Panel</label>
          <select
            id="results-panel"
            value={panel}
            onChange={(event) => {
              const next = event.target.value as LabPanelKey;
              setPanel(next);
              setRows(blankRows(next));
            }}
          >
            {LAB_PANEL_KEYS.map((key) => (
              <option key={key} value={key}>
                {LAB_PANELS[key].label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="results-date">Sample collected on</label>
          <input id="results-date" type="date" value={date} max={istToday()} onChange={(event) => setDate(event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="results-time">at</label>
          <input id="results-time" type="time" value={time} onChange={(event) => setTime(event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="results-facility">Laboratory</label>
          <input id="results-facility" value={facility} onChange={(event) => setFacility(event.target.value)} />
        </div>
        <div className="field field--wide">
          <label htmlFor="results-report">Typed from the report</label>
          <select id="results-report" value={reportId} onChange={(event) => setReportId(event.target.value)}>
            <option value="">No uploaded report</option>
            {reportOptions.map((document) => (
              <option key={document.id} value={document.id}>
                {`${formatDate(document.reportDate)}${document.title ? ` · ${document.title}` : ''}${document.performingFacility ? ` · ${document.performingFacility}` : ''}`}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="table-scroll">
        <table className="table table--compact">
          <thead>
            <tr>
              <th scope="col">Test</th>
              <th scope="col">Result</th>
              <th scope="col">Unit</th>
              <th scope="col">Range low</th>
              <th scope="col">Range high</th>
              <th scope="col">Lab flag</th>
            </tr>
          </thead>
          <tbody>
            {analytesOf(panel).map((analyte) => {
              const row = rows[analyte.code]!;
              const id = `result-${analyte.code}`;

              return (
                <tr key={analyte.code}>
                  <td>
                    <label htmlFor={id}>{analyte.label}</label>
                  </td>
                  <td>
                    <input id={id} type="number" step="any" inputMode="decimal" value={row.value} onChange={(event) => change(analyte.code, { value: event.target.value })} />
                  </td>
                  <td>
                    <select
                      aria-label={`${analyte.label} unit`}
                      value={row.unit}
                      onChange={(event) => {
                        const unit = event.target.value;
                        // Typical ranges are in the standard unit; another unit takes the report's own.
                        change(analyte.code, unit === analyte.units[0].code ? { unit } : { unit, low: '', high: '' });
                      }}
                    >
                      {analyte.units.map((unit) => (
                        <option key={unit.code} value={unit.code}>
                          {unit.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input aria-label={`${analyte.label} range low`} type="number" step="any" value={row.low} onChange={(event) => change(analyte.code, { low: event.target.value })} />
                  </td>
                  <td>
                    <input aria-label={`${analyte.label} range high`} type="number" step="any" value={row.high} onChange={(event) => change(analyte.code, { high: event.target.value })} />
                  </td>
                  <td>
                    <input aria-label={`${analyte.label} flag printed by the lab`} value={row.flag} maxLength={10} onChange={(event) => change(analyte.code, { flag: event.target.value })} placeholder="H / L" />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="row">
        <button type="button" onClick={() => void submit()} disabled={filled.length === 0 || record.isPending}>
          {record.isPending ? 'Saving…' : `Record ${filled.length === 1 ? '1 result' : `${filled.length} results`}`}
        </button>
        <button type="button" className="ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
