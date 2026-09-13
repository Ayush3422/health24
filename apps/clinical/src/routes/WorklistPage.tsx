import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../api/client';
import { ENCOUNTER_CLASS_LABELS, useWorklist } from '../api/clinical';
import { formatTime, humanise, istToday } from '../clinical/format';
import { SystemTag } from '../clinical/Provenance';

/**
 * The day's encounters at this hospital: where a clinician or a records clerk
 * starts. New encounters are opened from a patient's record, where the
 * patient has been found and their allergies are already on screen.
 */
export function WorklistPage(): JSX.Element {
  const [date, setDate] = useState(istToday());
  const worklist = useWorklist(date);
  const rows = worklist.data?.results ?? [];

  return (
    <div className="page">
      <div className="page-header">
        <h1>Encounters</h1>
        <div className="field page-header__control">
          <label htmlFor="worklist-date">Date</label>
          <input
            id="worklist-date"
            type="date"
            value={date}
            max={istToday()}
            onChange={(event) => setDate(event.target.value || istToday())}
          />
        </div>
      </div>

      {worklist.isError ? (
        <p className="alert alert--error">
          {worklist.error instanceof ApiError
            ? worklist.error.message
            : 'Could not load encounters'}
        </p>
      ) : null}

      {worklist.isSuccess && rows.length === 0 ? (
        <div className="empty">
          <p>No encounters on this date.</p>
          <p className="muted small">
            Find the patient, then open an encounter from their record.{' '}
            <Link to="/patients">Find a patient</Link>
          </p>
        </div>
      ) : null}

      {rows.length > 0 ? (
        <table className="table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Patient</th>
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
                <td>{formatTime(encounter.startedAt)}</td>
                <td>
                  <Link to={`/patients/${encounter.patientId}`}>
                    {encounter.patient?.name ?? 'Patient'}
                  </Link>
                  {encounter.patient?.mrn ? (
                    <span className="code"> {encounter.patient.mrn}</span>
                  ) : null}
                </td>
                <td>
                  <SystemTag system={encounter.systemOfMedicine} />
                </td>
                <td>{ENCOUNTER_CLASS_LABELS[encounter.class]}</td>
                <td>
                  {encounter.attending.name ?? '—'}
                  {encounter.entry.source === 'transcribed' ? (
                    <em className="tag tag--transcribed">transcribed</em>
                  ) : null}
                </td>
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
    </div>
  );
}
