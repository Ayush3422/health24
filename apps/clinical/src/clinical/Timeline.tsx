import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  CLINICAL_DATA_CATEGORIES,
  type ClinicalDataCategory,
  type TimelineItem,
} from '@health24/shared';
import { ApiError } from '../api/client';
import { ENCOUNTER_CLASS_LABELS } from '../api/clinical';
import {
  CATEGORY_LABELS,
  TIMELINE_KIND_LABELS,
  usePatientSummary,
  usePatientTimeline,
  type TimelineFilters,
} from '../api/consent';
import { formatDate, formatDateTime, formatTime } from './format';
import { Provenance, SystemTag } from './Provenance';
import { describeVitalSet } from './Vitals';

/**
 * The thirty-second view: what is shared, the latest vitals, what the patient
 * is taking and being treated for, and where they were last seen.
 */
export function PatientSummaryCard({ patientId }: { patientId: string }): JSX.Element | null {
  const summary = usePatientSummary(patientId);

  if (summary.isPending) return <div className="summary-card muted">Loading summary…</div>;
  if (summary.isError) return null;

  const { problems, medications, latestVitals, recentEncounters, recentAbnormalResults, sharing } =
    summary.data;
  const lastVisit = recentEncounters[0];

  return (
    <section
      className={`summary-card${sharing.breakGlassUntil ? ' summary-card--emergency' : ''}`}
      aria-label="Patient summary"
    >
      <div>
        <h3>Shared with you</h3>
        {sharing.breakGlassUntil ? (
          <p>
            <em className="tag tag--emergency">Emergency access</em> until{' '}
            {formatTime(sharing.breakGlassUntil)}
          </p>
        ) : sharing.categories.length > 0 ? (
          <p>
            {CLINICAL_DATA_CATEGORIES.filter((category) => sharing.categories.includes(category))
              .map((category) => CATEGORY_LABELS[category])
              .join(', ')}
            {sharing.expiresAt ? (
              <span className="small muted"> · until {formatDate(sharing.expiresAt)}</span>
            ) : null}
          </p>
        ) : (
          <p className="muted">Nothing from other hospitals</p>
        )}
      </div>

      <div>
        <h3>Active problems</h3>
        <p>{problems.problems.length === 0 ? 'None recorded' : problems.problems.length}</p>
      </div>

      <div>
        <h3>Current medicines</h3>
        {medications.medications.length === 0 ? (
          <p className="muted">None recorded</p>
        ) : (
          <ul>
            {medications.medications.slice(0, 4).map((medication) => (
              <li key={medication.id}>{medication.medicineName}</li>
            ))}
            {medications.medications.length > 4 ? (
              <li className="muted">and {medications.medications.length - 4} more</li>
            ) : null}
          </ul>
        )}
      </div>

      <div>
        <h3>Latest vitals</h3>
        {latestVitals ? (
          <p>
            {describeVitalSet(latestVitals)}
            <span className="small muted"> · {formatDate(latestVitals.effectiveAt)}</span>
          </p>
        ) : (
          <p className="muted">None recorded</p>
        )}
      </div>

      <div>
        <h3>Abnormal lab results</h3>
        {recentAbnormalResults.length === 0 ? (
          <p className="muted">None recorded</p>
        ) : (
          <ul>
            {recentAbnormalResults.slice(0, 3).map((result) => (
              <li key={result.observationId}>
                {/* The direction as a glyph and a word, never colour alone. */}
                <span className={`flag flag--${result.interpretation}`}>
                  {result.interpretation === 'high' ? '▲' : result.interpretation === 'low' ? '▼' : '!'}
                </span>{' '}
                {result.label} {result.value} {result.unit} ({result.interpretation})
                <span className="small muted">
                  {' '}
                  · {formatDate(result.collectedAt)}
                  {result.hospital.isOwn ? '' : ` · ${result.hospital.name}`}
                </span>
              </li>
            ))}
            {recentAbnormalResults.length > 3 ? (
              <li>
                <Link to={`/patients/${patientId}/reports`}>All lab results</Link>
              </li>
            ) : null}
          </ul>
        )}
      </div>

      <div>
        <h3>Last visit</h3>
        {lastVisit ? (
          <p>
            {formatDate(lastVisit.startedAt)} · {ENCOUNTER_CLASS_LABELS[lastVisit.class]}
            <span className="small muted">
              {' '}
              · {lastVisit.hospital.isOwn ? 'this hospital' : lastVisit.hospital.name}
            </span>
          </p>
        ) : (
          <p className="muted">None recorded</p>
        )}
      </div>
    </section>
  );
}

/**
 * The patient's whole record as one stream, newest first, across every
 * hospital this one may see. Entries from another hospital are marked as such,
 * and the screen says which kinds of record are not shared — an absence here
 * is never proof that nothing happened elsewhere.
 */
export function PatientTimeline({
  patientId,
  categories,
  title = 'Timeline',
}: {
  patientId: string;
  /** Fixes the kinds of record shown, and hides the filter. */
  categories?: ClinicalDataCategory[];
  title?: string;
}): JSX.Element {
  const [filters, setFilters] = useState<TimelineFilters>({
    categories: categories ?? [],
    scope: 'all',
  });
  const timeline = usePatientTimeline(patientId, filters);

  const pages = timeline.data?.pages ?? [];
  const items = pages.flatMap((page) => page.items);
  const sharedCategories = pages[0]?.sharedCategories ?? [];
  const relevant = categories ?? CLINICAL_DATA_CATEGORIES;
  const notShared = relevant.filter((category) => !sharedCategories.includes(category));

  const toggle = (category: ClinicalDataCategory) =>
    setFilters((current) => ({
      ...current,
      categories: current.categories.includes(category)
        ? current.categories.filter((value) => value !== category)
        : [...current.categories, category],
    }));

  // Grouped by day, in India Standard Time.
  const days: Array<{ day: string; items: TimelineItem[] }> = [];
  for (const item of items) {
    const day = formatDate(item.at);
    const last = days.at(-1);
    if (last?.day === day) last.items.push(item);
    else days.push({ day, items: [item] });
  }

  return (
    <section>
      <h2>{title}</h2>

      <div className="timeline-filters">
        {categories ? null : (
          <div className="chips" role="group" aria-label="Kinds of record">
            {CLINICAL_DATA_CATEGORIES.map((category) => (
              <button
                key={category}
                type="button"
                className="chip"
                aria-pressed={filters.categories.includes(category)}
                onClick={() => toggle(category)}
              >
                {CATEGORY_LABELS[category]}
              </button>
            ))}
          </div>
        )}
        <select
          aria-label="Hospitals"
          value={filters.scope}
          onChange={(event) =>
            setFilters((current) => ({ ...current, scope: event.target.value as 'all' | 'own' }))
          }
        >
          <option value="all">All hospitals shared with you</option>
          <option value="own">This hospital only</option>
        </select>
      </div>

      {timeline.isSuccess && filters.scope === 'all' ? (
        notShared.length === relevant.length ? (
          <p className="sharing-note small">
            Records from other hospitals are not shared with your hospital. Only your
            hospital&apos;s records are shown.
          </p>
        ) : notShared.length > 0 ? (
          <p className="sharing-note small">
            Not shared by other hospitals:{' '}
            {notShared.map((category) => CATEGORY_LABELS[category]).join(', ')}.
          </p>
        ) : null
      ) : null}

      {timeline.isPending ? <p className="muted">Loading…</p> : null}
      {timeline.isError ? (
        <p className="alert alert--error">
          {timeline.error instanceof ApiError
            ? timeline.error.message
            : 'Could not load the timeline'}
        </p>
      ) : null}
      {timeline.isSuccess && items.length === 0 ? (
        <p className="muted">
          Nothing recorded{filters.categories.length ? ' of these kinds' : ''}.
        </p>
      ) : null}

      {days.map(({ day, items: dayItems }) => (
        <div key={day}>
          <h3 className="timeline__day">{day}</h3>
          <ol className="timeline">
            {dayItems.map((item) => (
              <TimelineEntry key={`${item.kind}-${item.id}`} item={item} patientId={patientId} />
            ))}
          </ol>
        </div>
      ))}

      {timeline.hasNextPage ? (
        <div className="row">
          <button
            type="button"
            className="ghost"
            onClick={() => void timeline.fetchNextPage()}
            disabled={timeline.isFetchingNextPage}
          >
            {timeline.isFetchingNextPage ? 'Loading…' : 'Show older entries'}
          </button>
        </div>
      ) : null}
    </section>
  );
}

function TimelineEntry({ item, patientId }: { item: TimelineItem; patientId: string }): JSX.Element {
  // Documents and lab results open on the reports tab.
  const inReports = item.kind === 'document' || item.kind === 'result';
  // Another hospital's encounter page opens only where its visits are shared.
  const canOpen =
    !inReports && item.encounterId && (item.hospital.isOwn || item.kind === 'encounter');

  return (
    <li className={`timeline__item${item.hospital.isOwn ? '' : ' timeline__item--shared'}`}>
      <span className="timeline__time" title={formatDateTime(item.at)}>
        {formatTime(item.at)}
      </span>
      <span className="timeline__kind">{TIMELINE_KIND_LABELS[item.kind]}</span>
      <div>
        <div>
          <strong>{item.title}</strong>{' '}
          {item.systemOfMedicine ? <SystemTag system={item.systemOfMedicine} /> : null}
          {item.corrected ? <em className="tag">corrected</em> : null}
        </div>
        {item.detail ? <div className="timeline__detail">{item.detail}</div> : null}
        <div className="small muted">
          <Provenance hospital={item.hospital} clinician={item.clinician} entry={item.entry} />
          {inReports ? (
            <>
              {' · '}
              <Link to={`/patients/${patientId}/reports`}>Open in reports</Link>
            </>
          ) : null}
          {canOpen ? (
            <>
              {' · '}
              <Link to={`/encounters/${item.encounterId}`}>Open visit</Link>
            </>
          ) : null}
        </div>
      </div>
    </li>
  );
}
