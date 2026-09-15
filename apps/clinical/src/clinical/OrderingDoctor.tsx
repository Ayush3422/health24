import { useDeferredValue } from 'react';
import { useClinicians } from '../api/clinical';
import { useExternalClinicians } from '../api/imports';

export type OrderingDoctor = {
  mode: 'none' | 'account' | 'name';
  clinicianId: string;
  name: string;
};

export const NO_ORDERING_DOCTOR: OrderingDoctor = { mode: 'none', clinicianId: '', name: '' };

export const orderingDoctorReady = (value: OrderingDoctor) =>
  (value.mode !== 'account' || Boolean(value.clinicianId)) &&
  (value.mode !== 'name' || value.name.trim().length >= 2);

export const orderingDoctorPayload = (value: OrderingDoctor) => ({
  orderingClinicianId: value.mode === 'account' ? value.clinicianId : undefined,
  orderingClinicianName: value.mode === 'name' ? value.name.trim() || undefined : undefined,
});

/**
 * Who ordered a report: a clinician of this hospital, or a doctor without an
 * account (T20). Typing a name offers the names this hospital has already
 * written, so the same doctor is named alike on every document. The front
 * desk cannot list clinicians, so it names a doctor by name only.
 */
export function OrderingDoctorFields({
  idPrefix,
  value,
  onChange,
  canChooseClinician,
}: {
  idPrefix: string;
  value: OrderingDoctor;
  onChange: (next: OrderingDoctor) => void;
  canChooseClinician: boolean;
}): JSX.Element {
  const clinicians = useClinicians(canChooseClinician && value.mode === 'account');
  const typed = useDeferredValue(value.name.trim());
  const suggestions = useExternalClinicians(typed, value.mode === 'name');
  const listId = `${idPrefix}-doctor-names`;

  return (
    <>
      <div className="field">
        <label htmlFor={`${idPrefix}-ordering`}>Ordered by</label>
        <select
          id={`${idPrefix}-ordering`}
          value={value.mode}
          onChange={(event) =>
            onChange({ ...value, mode: event.target.value as OrderingDoctor['mode'] })
          }
        >
          <option value="none">Not stated</option>
          {canChooseClinician ? <option value="account">A clinician of this hospital</option> : null}
          <option value="name">A doctor without an account</option>
        </select>
      </div>

      {value.mode === 'account' ? (
        <div className="field">
          <label htmlFor={`${idPrefix}-clinician`}>Clinician</label>
          <select
            id={`${idPrefix}-clinician`}
            value={value.clinicianId}
            onChange={(event) => onChange({ ...value, clinicianId: event.target.value })}
          >
            <option value="" disabled>
              Choose…
            </option>
            {(clinicians.data ?? []).map((clinician) => (
              <option key={clinician.id} value={clinician.id}>
                {clinician.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      {value.mode === 'name' ? (
        <div className="field">
          <label htmlFor={`${idPrefix}-doctor-name`}>Doctor’s name</label>
          <input
            id={`${idPrefix}-doctor-name`}
            list={listId}
            autoComplete="off"
            value={value.name}
            onChange={(event) => onChange({ ...value, name: event.target.value })}
            placeholder="As written on the report"
          />
          <datalist id={listId}>
            {(suggestions.data?.names ?? []).map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </div>
      ) : null}
    </>
  );
}
