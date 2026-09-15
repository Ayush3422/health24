import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ENCOUNTER_CLASSES,
  SYSTEMS_OF_MEDICINE,
  type EncounterClass,
  type SystemOfMedicine,
} from '@health24/shared';
import { ApiError } from '../api/client';
import {
  ENCOUNTER_CLASS_LABELS,
  SYSTEM_LABELS,
  useCurrentMedications,
  useOpenEncounter,
  usePatientEncounters,
  useProblemList,
} from '../api/clinical';
import { useAuth } from '../auth/AuthProvider';
import { ClinicianPicker, useAttribution } from './attribution';
import { DiagnosisList } from './Diagnoses';
import { formatDate, humanise, optionalText } from './format';
import { MedicationList } from './Medications';
import { SharingNote, SystemTag } from './Provenance';

/**
 * Pieces of a patient's clinical record, placed on the patient page's tabs:
 * active problems, what they are taking, and every encounter this hospital may
 * see — its own, and other hospitals' where the patient has consented.
 */

export function StartEncounter({ patientId }: { patientId: string }): JSX.Element {
  const { staff } = useAuth();
  const navigate = useNavigate();
  const open = useOpenEncounter();
  const attribution = useAttribution();

  const [expanded, setExpanded] = useState(false);
  const [encounterClass, setEncounterClass] = useState<EncounterClass>('outpatient');
  const [system, setSystem] = useState<SystemOfMedicine | ''>('');
  const [complaint, setComplaint] = useState('');
  const [error, setError] = useState<string | null>(null);

  // The attending clinician's own system, unless changed: the clinician's for
  // direct entry, the chosen clinician's for records staff.
  const defaultSystem = attribution.transcribes
    ? attribution.clinician?.systemOfMedicine
    : staff?.systemOfMedicine;
  const effectiveSystem = system || defaultSystem || '';

  const submit = async () => {
    setError(null);

    try {
      const encounter = await open.mutateAsync({
        patientId,
        class: encounterClass,
        systemOfMedicine: effectiveSystem || undefined,
        chiefComplaint: optionalText(complaint),
        ...attribution.body,
      });
      navigate(`/encounters/${encounter.id}`);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not open the encounter');
    }
  };

  if (!expanded) {
    return (
      <div className="row">
        <button type="button" onClick={() => setExpanded(true)}>
          Start an encounter
        </button>
      </div>
    );
  }

  return (
    <div className="form card">
      <h3>Start an encounter</h3>
      {error ? <p className="alert alert--error">{error}</p> : null}

      <ClinicianPicker attribution={attribution} id="encounter-clinician" />

      <div className="form-grid">
        <div className="field">
          <label htmlFor="encounter-class">Type</label>
          <select
            id="encounter-class"
            value={encounterClass}
            onChange={(event) => setEncounterClass(event.target.value as EncounterClass)}
          >
            {ENCOUNTER_CLASSES.map((value) => (
              <option key={value} value={value}>
                {ENCOUNTER_CLASS_LABELS[value]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="encounter-system">System of medicine</label>
          <select
            id="encounter-system"
            value={effectiveSystem}
            onChange={(event) => setSystem(event.target.value as SystemOfMedicine)}
          >
            <option value="" disabled>
              Choose…
            </option>
            {SYSTEMS_OF_MEDICINE.map((value) => (
              <option key={value} value={value}>
                {SYSTEM_LABELS[value]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="encounter-complaint">Chief complaint</label>
          <input
            id="encounter-complaint"
            value={complaint}
            onChange={(event) => setComplaint(event.target.value)}
          />
        </div>
      </div>

      <div className="row">
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!attribution.ready || !effectiveSystem || open.isPending}
        >
          {open.isPending ? 'Opening…' : 'Open encounter'}
        </button>
        <button type="button" className="ghost" onClick={() => setExpanded(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function ProblemList({ patientId }: { patientId: string }): JSX.Element {
  const problems = useProblemList(patientId);

  return (
    <section>
      <h2>Active problems</h2>
      {problems.isPending ? <p className="muted">Loading…</p> : null}
      {problems.isError ? <p className="alert alert--error">Could not load problems.</p> : null}
      {problems.isSuccess ? (
        <>
          <DiagnosisList
            conditions={problems.data.problems}
            compact
            emptyText="No active problems recorded."
          />
          <SharingNote shared={problems.data.sharedFromOtherHospitals} what="Diagnoses" />
        </>
      ) : null}
    </section>
  );
}

export function CurrentMedications({
  patientId,
  canStop,
}: {
  patientId: string;
  canStop: boolean;
}): JSX.Element {
  const medications = useCurrentMedications(patientId);

  return (
    <section>
      <h2>Current medications</h2>
      {medications.isPending ? <p className="muted">Loading…</p> : null}
      {medications.isError ? (
        <p className="alert alert--error">Could not load medications.</p>
      ) : null}
      {medications.isSuccess ? (
        <>
          <MedicationList
            medications={medications.data.medications}
            canStop={canStop}
            emptyText="No current medications recorded."
          />
          <SharingNote shared={medications.data.sharedFromOtherHospitals} what="Medications" />
        </>
      ) : null}
    </section>
  );
}

export function EncounterHistory({ patientId }: { patientId: string }): JSX.Element {
  const encounters = usePatientEncounters(patientId);
  const rows = encounters.data?.results ?? [];

  return (
    <section>
      <h2>Encounters</h2>
      {encounters.isError ? <p className="alert alert--error">Could not load encounters.</p> : null}
      {encounters.isSuccess && rows.length === 0 ? (
        <p className="muted">No encounters recorded.</p>
      ) : null}
      {rows.length > 0 ? (
        <table className="table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Hospital</th>
              <th>System</th>
              <th>Type</th>
              <th>Clinician</th>
              <th>Status</th>
              <th aria-label="Open" />
            </tr>
          </thead>
          <tbody>
            {rows.map((encounter) => (
              <tr key={encounter.id}>
                <td>{formatDate(encounter.startedAt)}</td>
                <td>
                  {encounter.hospital.isOwn ? (
                    'This hospital'
                  ) : (
                    <em className="tag tag--shared">{encounter.hospital.name}</em>
                  )}
                </td>
                <td>
                  <SystemTag system={encounter.systemOfMedicine} />
                </td>
                <td>{ENCOUNTER_CLASS_LABELS[encounter.class]}</td>
                <td>{encounter.attending.name ?? '—'}</td>
                <td>
                  <span className={`status status--${encounter.status}`}>
                    {humanise(encounter.status)}
                  </span>
                </td>
                <td>
                  <Link to={`/encounters/${encounter.id}`}>Open</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}
