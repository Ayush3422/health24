import { useState } from 'react';
import { Link } from 'react-router-dom';
import { usePatientSearch } from '../api/hooks';

/**
 * Patient search.
 *
 * Scoped to the caller's own hospital by the server, so this cannot surface a
 * patient the hospital has never seen — finding someone treated elsewhere is a
 * separate, deliberately narrower operation that happens during registration.
 */
export function PatientSearchPage(): JSX.Element {
  const [term, setTerm] = useState('');
  const search = usePatientSearch(term);

  return (
    <div className="page">
      <h1>Patients</h1>

      <input
        className="search"
        value={term}
        onChange={(event) => setTerm(event.target.value)}
        placeholder="Name, mobile number, MRN or ABHA number"
        autoFocus
        aria-label="Search patients"
      />

      {term.trim().length === 0 ? (
        <p className="muted">Search by name, mobile number, medical record number or ABHA.</p>
      ) : null}

      {search.isFetching ? <p className="muted">Searching…</p> : null}

      {search.isError ? (
        <p className="alert alert--error">Could not search. {String(search.error)}</p>
      ) : null}

      {search.data && search.data.results.length === 0 ? (
        <div className="empty">
          <p>No patients here match “{term}”.</p>
          <p className="muted">
            If they have been treated at another hospital, registering them here will link their
            existing record rather than create a new one.
          </p>
          <Link className="button" to="/patients/new">
            Register a new patient
          </Link>
        </div>
      ) : null}

      {search.data && search.data.results.length > 0 ? (
        <table className="table">
          <thead>
            <tr>
              <th>MRN</th>
              <th>Name</th>
              <th>Gender</th>
              <th>Age</th>
              <th>Mobile</th>
            </tr>
          </thead>
          <tbody>
            {search.data.results.map((patient) => (
              <tr key={patient.id}>
                <td>
                  <Link to={`/patients/${patient.id}`}>{patient.mrn}</Link>
                </td>
                <td>{patient.name}</td>
                <td>{patient.gender}</td>
                <td>
                  {patient.dateOfBirth
                    ? new Date().getFullYear() - Number(patient.dateOfBirth.slice(0, 4))
                    : (patient.approximateAgeYears ?? '—')}
                </td>
                <td>{patient.phone ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}
