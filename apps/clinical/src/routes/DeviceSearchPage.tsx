import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../api/client';
import { useDeviceSearch } from '../api/implants';
import { useDebouncedValue } from '../clinical/useDebouncedValue';
import { formatDateTime } from '../clinical/format';

/**
 * A recall (sp6-plan.md, Phase 4): the manufacturer names a batch, and the
 * hospital has to answer "which of our patients has one of these" the same
 * day. Searched by serial, lot or model, over this hospital's own record —
 * another hospital answers for its own patients.
 */
export function DeviceSearchPage(): JSX.Element {
  const [term, setTerm] = useState('');
  const debounced = useDebouncedValue(term, 300);
  const search = useDeviceSearch(debounced);

  const results = search.data?.results ?? [];

  return (
    <div className="page">
      <div className="page-header">
        <h1>Implants and devices</h1>
      </div>

      <div className="form card">
        <div className="field">
          <label htmlFor="device-search">Serial number, lot or model</label>
          <input
            id="device-search"
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            placeholder="e.g. LOT-2026-0041"
            autoComplete="off"
          />
          <p className="small muted">
            Every device this hospital has recorded, current version only. The history of a
            corrected device is on the device itself.
          </p>
        </div>
      </div>

      {search.isError ? (
        <p className="alert alert--error">
          {search.error instanceof ApiError ? search.error.message : 'Could not search'}
        </p>
      ) : null}

      {debounced.trim().length >= 2 && search.isSuccess && results.length === 0 ? (
        <p className="muted">No device matches that.</p>
      ) : null}

      {results.length > 0 ? (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Patient</th>
                <th scope="col">Device</th>
                <th scope="col">Serial or lot</th>
                <th scope="col">Implanted</th>
                <th scope="col">Operation</th>
              </tr>
            </thead>
            <tbody>
              {results.map((device) => (
                <tr key={device.id}>
                  <td>
                    <Link to={`/patients/${device.patient.id}`}>{device.patient.name}</Link>
                    {device.patient.mrn ? (
                      <span className="code"> {device.patient.mrn}</span>
                    ) : null}
                  </td>
                  <td>
                    {device.name}
                    {device.manufacturer ? (
                      <span className="small muted"> · {device.manufacturer}</span>
                    ) : null}
                  </td>
                  <td>
                    <span className="code">{device.serialOrLot ?? '—'}</span>
                  </td>
                  <td>{formatDateTime(device.implantedAt)}</td>
                  <td>
                    {device.procedureName ? (
                      <Link to={`/encounters/${device.encounterId}`}>{device.procedureName}</Link>
                    ) : (
                      <Link to={`/encounters/${device.encounterId}`}>the encounter</Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
