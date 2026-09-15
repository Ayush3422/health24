import { useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { BLOOD_GROUPS, hasPermission } from '@health24/shared';
import { ApiError } from '../api/client';
import { usePatient, useUpdatePatient } from '../api/hooks';
import { useAuth } from '../auth/AuthProvider';
import { PatientClinicalRecord } from '../clinical/PatientClinicalRecord';
import { PatientDocuments } from '../clinical/Documents';
import { PatientResults } from '../clinical/Results';
import { PatientSharing } from '../clinical/Sharing';

export function PatientDetailPage(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const { staff } = useAuth();
  const patient = usePatient(id);
  const update = useUpdatePatient(id ?? '');

  const [editing, setEditing] = useState(false);
  const [bloodGroup, setBloodGroup] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const arrival = location.state as { linkedExisting?: boolean; queued?: number } | null;
  const canEdit = staff ? hasPermission(staff.role, 'patient:update') : false;

  if (patient.isPending) return <div className="page">Loading…</div>;

  if (patient.isError) {
    return (
      <div className="page">
        <p className="alert alert--error">This patient is not available at your hospital.</p>
        <Link to="/patients">Back to search</Link>
      </div>
    );
  }

  const record = patient.data;

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
    <div className="page">
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
          </p>
        </div>
      </header>

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

      {canEdit ? (
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
      ) : null}

      <PatientSharing patientId={record.id} />

      <PatientDocuments patientId={record.id} />

      <PatientResults patientId={record.id} />

      <PatientClinicalRecord patientId={record.id} />

      <Link to="/patients">Back to search</Link>
    </div>
  );
}
