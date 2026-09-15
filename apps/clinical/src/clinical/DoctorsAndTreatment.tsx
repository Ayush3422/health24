import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import type {
  ClinicalDataCategory,
  SystemOfMedicine,
  TimelineItem,
  TimelineKind,
} from '@health24/shared';
import { ApiError } from '../api/client';
import { CATEGORY_LABELS, usePatientTimeline } from '../api/consent';
import { formatDate } from './format';
import { SystemTag } from './Provenance';

/** Enough history for any real patient; beyond it, the tab says the list is partial. */
const MAX_ENTRIES = 1_000;

const TREATMENT_CATEGORIES: ClinicalDataCategory[] = [
  'encounters',
  'diagnoses',
  'medications',
  'procedures',
  'notes',
];

/** Allergies, vitals, documents and lab results have their own tabs. */
const TREATMENT_KINDS: TimelineKind[] = ['encounter', 'diagnosis', 'prescription', 'procedure', 'note'];

type DoctorGroup = {
  key: string;
  clinician: TimelineItem['clinician'];
  hospital: TimelineItem['hospital'];
  systems: SystemOfMedicine[];
  lastSeen: string;
  visits: TimelineItem[];
  diagnoses: TimelineItem[];
  prescriptions: TimelineItem[];
  procedures: TimelineItem[];
  notes: TimelineItem[];
};

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** Every entry, grouped by the clinician it belongs to at their hospital; newest first. */
export function groupByDoctor(items: TimelineItem[]): DoctorGroup[] {
  const groups = new Map<string, DoctorGroup>();

  for (const item of items) {
    if (!TREATMENT_KINDS.includes(item.kind)) continue;

    const key = `${item.hospital.id}:${item.clinician.id}`;
    let group = groups.get(key);

    if (!group) {
      group = {
        key,
        clinician: item.clinician,
        hospital: item.hospital,
        systems: [],
        lastSeen: item.at,
        visits: [],
        diagnoses: [],
        prescriptions: [],
        procedures: [],
        notes: [],
      };
      groups.set(key, group);
    }

    if (item.at > group.lastSeen) group.lastSeen = item.at;
    if (item.systemOfMedicine && !group.systems.includes(item.systemOfMedicine)) {
      group.systems.push(item.systemOfMedicine);
    }

    const buckets: Partial<Record<TimelineKind, TimelineItem[]>> = {
      encounter: group.visits,
      diagnosis: group.diagnoses,
      prescription: group.prescriptions,
      procedure: group.procedures,
      note: group.notes,
    };
    buckets[item.kind]?.push(item);
  }

  return [...groups.values()].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
}

/**
 * Each doctor who has treated the patient — at this hospital, and at others
 * where the patient has consented — with what they diagnosed, prescribed and
 * did, newest first.
 */
export function DoctorsAndTreatment({ patientId }: { patientId: string }): JSX.Element {
  const timeline = usePatientTimeline(patientId, { categories: [], scope: 'all' });
  const pages = timeline.data?.pages ?? [];
  const items = pages.flatMap((page) => page.items);
  const truncated = timeline.hasNextPage && items.length >= MAX_ENTRIES;

  // Grouping needs the whole history, so older pages are fetched in turn.
  useEffect(() => {
    if (timeline.hasNextPage && !timeline.isFetchingNextPage && items.length < MAX_ENTRIES) {
      void timeline.fetchNextPage();
    }
  }, [timeline, items.length]);

  const sharedCategories = pages[0]?.sharedCategories ?? [];
  const notShared = TREATMENT_CATEGORIES.filter((category) => !sharedCategories.includes(category));
  const doctors = groupByDoctor(items);
  const stillLoading = timeline.isPending || (timeline.hasNextPage && !truncated);

  return (
    <section>
      <h2>Doctors and treatment</h2>

      {timeline.isSuccess && notShared.length > 0 ? (
        <p className="sharing-note small">
          {notShared.length === TREATMENT_CATEGORIES.length
            ? 'Records from other hospitals are not shared with your hospital. Only your hospital’s doctors are shown.'
            : `Not shared by other hospitals: ${notShared.map((category) => CATEGORY_LABELS[category]).join(', ')}.`}
        </p>
      ) : null}

      {timeline.isError ? (
        <p className="alert alert--error">
          {timeline.error instanceof ApiError ? timeline.error.message : 'Could not load the record'}
        </p>
      ) : null}
      {stillLoading ? <p className="muted">Loading the patient’s history…</p> : null}
      {truncated ? (
        <p className="alert alert--warning small">
          Showing the most recent {MAX_ENTRIES} entries. Older treatment is on the Visits &amp;
          timeline tab.
        </p>
      ) : null}
      {timeline.isSuccess && !stillLoading && doctors.length === 0 ? (
        <p className="muted">No doctor has recorded treatment for this patient yet.</p>
      ) : null}

      <div className="doctor-list">
        {doctors.map((doctor) => (
          <article key={doctor.key} className="doctor-card">
            <header className="doctor-card__header">
              <h3>{doctor.clinician.name ?? 'Clinician not named'}</h3>
              <p className="small muted">
                {doctor.hospital.isOwn ? (
                  'This hospital'
                ) : (
                  <em className="tag tag--shared">{doctor.hospital.name}</em>
                )}{' '}
                {doctor.systems.map((system) => (
                  <SystemTag key={system} system={system} />
                ))}{' '}
                · {plural(doctor.visits.length, 'visit', 'visits')} · last seen{' '}
                {formatDate(doctor.lastSeen)}
              </p>
            </header>

            <TreatmentGroup title="Diagnoses" items={doctor.diagnoses} />
            <TreatmentGroup title="Medicines prescribed" items={doctor.prescriptions} />
            <TreatmentGroup title="Procedures and therapies" items={doctor.procedures} />
            <TreatmentGroup title="Notes" items={doctor.notes} />
            <TreatmentGroup title="Visits" items={doctor.visits} />
          </article>
        ))}
      </div>
    </section>
  );
}

function TreatmentGroup({ title, items }: { title: string; items: TimelineItem[] }): JSX.Element | null {
  if (items.length === 0) return null;

  return (
    <div className="doctor-card__group">
      <h4>{title}</h4>
      <ul>
        {items.map((item) => (
          <li key={`${item.kind}-${item.id}`}>
            <span className="doctor-card__date">{formatDate(item.at)}</span>
            <strong>{item.title}</strong>
            {item.detail ? <span className="muted"> · {item.detail}</span> : null}
            {item.corrected ? (
              <>
                {' '}
                <em className="tag">corrected</em>
              </>
            ) : null}
            {item.encounterId && item.hospital.isOwn ? (
              <>
                {' · '}
                <Link to={`/encounters/${item.encounterId}`}>Open visit</Link>
              </>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
