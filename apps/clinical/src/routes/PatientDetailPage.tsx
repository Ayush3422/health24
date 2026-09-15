import { useState } from 'react';
import { Link, NavLink, Navigate, useLocation, useParams } from 'react-router-dom';
import { BLOOD_GROUPS, hasPermission, type PatientSummary, type StaffRole } from '@health24/shared';
import { ApiError } from '../api/client';
import { usePatient, useUpdatePatient } from '../api/hooks';
import { useAuth } from '../auth/AuthProvider';
import { AllergyBanner, RecordAllergyForm } from '../clinical/AllergyBanner';
import { DoctorsAndTreatment } from '../clinical/DoctorsAndTreatment';
import { PatientDocuments } from '../clinical/Documents';
import { PatientImports } from '../clinical/Imports';
import {
  CurrentMedications,
  EncounterHistory,
  ProblemList,
  StartEncounter,
} from '../clinical/PatientClinicalRecord';
import { PatientAllergies, PatientProcedures, PatientVitals } from '../clinical/PatientDocumentation';
import { PatientResults } from '../clinical/Results';
import { PatientSharing } from '../clinical/Sharing';
import { PatientSummaryCard, PatientTimeline } from '../clinical/Timeline';

type TabKey =
  | 'overview'
  | 'doctors'
  | 'reports'
  | 'bills'
  | 'medicines'
  | 'visits'
  | 'imports'
  | 'consent';

const readsClinical = (role: StaffRole) => hasPermission(role, 'clinical:read');
const handlesDocuments = (role: StaffRole) =>
  readsClinical(role) || hasPermission(role, 'documents:upload');

/** The patient record's sections, each on its own address; a role sees only the tabs it may use. */
const TABS: Array<{ key: TabKey; label: string; allowed: (role: StaffRole) => boolean }> = [
  { key: 'overview', label: 'Overview', allowed: () => true },
  { key: 'doctors', label: 'Doctors & treatment', allowed: readsClinical },
  { key: 'reports', label: 'All reports', allowed: handlesDocuments },
  { key: 'bills', label: 'Bills', allowed: handlesDocuments },
  { key: 'medicines', label: 'Medicines', allowed: readsClinical },
  { key: 'visits', label: 'Visits & timeline', allowed: readsClinical },
  { key: 'imports', label: 'Paper imports', allowed: (role) => hasPermission(role, 'documents:import') },
  { key: 'consent', label: 'Consent & sharing', allowed: (role) => hasPermission(role, 'consent:read') },
];

const tabPath = (patientId: string, key: TabKey) =>
  key === 'overview' ? `/patients/${patientId}` : `/patients/${patientId}/${key}`;

export function PatientDetailPage(): JSX.Element {
  const { id, tab = 'overview' } = useParams<{ id: string; tab?: string }>();
  const { staff } = useAuth();
  const patient = usePatient(id);

  if (patient.isPending) return <div className="page">Loading…</div>;

  if (patient.isError || !staff) {
    return (
      <div className="page">
        <p className="alert alert--error">This patient is not available at your hospital.</p>
        <Link to="/patients">Back to search</Link>
      </div>
    );
  }

  const record = patient.data;
  const tabs = TABS.filter((candidate) => candidate.allowed(staff.role));
  const current = tabs.find((candidate) => candidate.key === tab);

  if (!current) return <Navigate to={`/patients/${record.id}`} replace />;

  return (
    <div className="page">
      <header className="patient-header">
        <div>
          <h1>{record.name}</h1>
          <p className="muted">
            {record.mrn} · {record.gender}
            {record.dateOfBirth
              ? ` · born ${record.dateOfBirth}`
              : record.approximateAgeYears !== null
                ? ` · about ${record.approximateAgeYears} years old`
                : ''}
            {record.phone ? ` · ${record.phone}` : ''}
          </p>
        </div>
      </header>

      {readsClinical(staff.role) ? <AllergyBanner patientId={record.id} /> : null}

      <nav className="patient-tabs" aria-label="Patient record">
        {tabs.map((candidate) => (
          <NavLink
            key={candidate.key}
            end
            to={tabPath(record.id, candidate.key)}
            className={({ isActive }) =>
              `patient-tabs__link${isActive ? ' patient-tabs__link--active' : ''}`
            }
          >
            {candidate.label}
          </NavLink>
        ))}
      </nav>

      <div className="patient-tab-panel">
        <TabContent tab={current.key} record={record} role={staff.role} />
      </div>

      <p>
        <Link to="/patients">Back to search</Link>
      </p>
    </div>
  );
}

function TabContent({
  tab,
  record,
  role,
}: {
  tab: TabKey;
  record: PatientSummary;
  role: StaffRole;
}): JSX.Element {
  const patientId = record.id;

  switch (tab) {
    case 'overview':
      return <Overview record={record} role={role} />;
    case 'doctors':
      return <DoctorsAndTreatment patientId={patientId} />;
    case 'reports':
      return (
        <>
          <PatientDocuments patientId={patientId} kind="reports" />
          <PatientResults patientId={patientId} />
        </>
      );
    case 'bills':
      return <PatientDocuments patientId={patientId} kind="bills" />;
    case 'medicines':
      return (
        <div className="clinical-record">
          <CurrentMedications patientId={patientId} canStop={hasPermission(role, 'clinical:write')} />
          <PatientTimeline
            patientId={patientId}
            categories={['medications']}
            title="Prescription history"
          />
        </div>
      );
    case 'visits':
      return (
        <div className="clinical-record">
          <EncounterHistory patientId={patientId} />
          <PatientProcedures patientId={patientId} />
          <PatientTimeline patientId={patientId} />
        </div>
      );
    case 'imports':
      return <PatientImports patientId={patientId} />;
    case 'consent':
      return <PatientSharing patientId={patientId} />;
  }
}

function Overview({ record, role }: { record: PatientSummary; role: StaffRole }): JSX.Element {
  const location = useLocation();
  const arrival = location.state as { linkedExisting?: boolean; queued?: number } | null;
  const canWrite = hasPermission(role, 'clinical:write') || hasPermission(role, 'clinical:transcribe');

  return (
    <>
      {arrival?.linkedExisting ? (
        <p className="alert alert--success">
          This patient already had a record from another hospital. It has been linked, so their
          history is available here — and they have been given your hospital&apos;s own MRN.
        </p>
      ) : null}

      {arrival?.queued ? (
        <p className="alert alert--warning">
          A possible duplicate was recorded for the records team to review.
        </p>
      ) : null}

      <dl className="details">
        <div>
          <dt>Mobile</dt>
          <dd>{record.phone ?? '—'}</dd>
        </div>
        <div>
          <dt>ABHA</dt>
          <dd>{record.abhaNumber ?? 'Not linked'}</dd>
        </div>
        <div>
          <dt>Blood group</dt>
          <dd>{record.bloodGroup ?? 'Not known'}</dd>
        </div>
        <div>
          <dt>Registered</dt>
          <dd>{new Date(record.createdAt).toLocaleDateString()}</dd>
        </div>
      </dl>

      {hasPermission(role, 'patient:update') ? <CorrectBloodGroup patientId={record.id} /> : null}

      {readsClinical(role) ? (
        <div className="clinical-record">
          <PatientSummaryCard patientId={record.id} />

          {canWrite ? <ClinicalActions patientId={record.id} /> : null}

          <div className="clinical-columns">
            <ProblemList patientId={record.id} />
            <CurrentMedications
              patientId={record.id}
              canStop={hasPermission(role, 'clinical:write')}
            />
          </div>

          <div className="clinical-columns">
            <PatientAllergies patientId={record.id} editable={canWrite} />
            <PatientVitals patientId={record.id} />
          </div>
        </div>
      ) : null}
    </>
  );
}

function ClinicalActions({ patientId }: { patientId: string }): JSX.Element {
  const [addingAllergy, setAddingAllergy] = useState(false);

  return (
    <>
      {addingAllergy ? (
        <RecordAllergyForm patientId={patientId} onDone={() => setAddingAllergy(false)} />
      ) : (
        <div className="row">
          <button type="button" className="ghost" onClick={() => setAddingAllergy(true)}>
            Record an allergy
          </button>
        </div>
      )}
      <StartEncounter patientId={patientId} />
    </>
  );
}

function CorrectBloodGroup({ patientId }: { patientId: string }): JSX.Element {
  const update = useUpdatePatient(patientId);
  const [editing, setEditing] = useState(false);
  const [bloodGroup, setBloodGroup] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setError(null);

    try {
      await update.mutateAsync({ bloodGroup, reason });
      setEditing(false);
      setReason('');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not save the correction');
    }
  };

  return (
    <section className="card">
      <h2>Correct a detail</h2>

      {error ? <p className="alert alert--error">{error}</p> : null}

      {editing ? (
        <div className="form">
          <div className="field">
            <label htmlFor="bloodGroup">Blood group</label>
            <select
              id="bloodGroup"
              value={bloodGroup}
              onChange={(event) => setBloodGroup(event.target.value)}
            >
              <option value="">Select…</option>
              {BLOOD_GROUPS.filter((group) => group !== 'unknown').map((group) => (
                <option key={group} value={group}>
                  {group}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="reason">Why is this being corrected?</label>
            <input
              id="reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="e.g. confirmed against lab report"
            />
            {/* A reason is required by the server: a demographic change
                without one is untraceable later. */}
          </div>

          <div className="row">
            <button
              type="button"
              onClick={() => void save()}
              disabled={!bloodGroup || reason.trim().length < 3 || update.isPending}
            >
              {update.isPending ? 'Saving…' : 'Save correction'}
            </button>
            <button type="button" className="ghost" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="ghost" onClick={() => setEditing(true)}>
          Correct blood group
        </button>
      )}
    </section>
  );
}
