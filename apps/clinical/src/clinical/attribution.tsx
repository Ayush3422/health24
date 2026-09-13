import { useState } from 'react';
import { hasPermission, type ClinicianOption } from '@health24/shared';
import { SYSTEM_LABELS, useClinicians } from '../api/clinical';
import { useAuth } from '../auth/AuthProvider';

export interface AttributionState {
  /** True for medical records staff, who enter data in a clinician's name. */
  transcribes: boolean;
  clinicians: ClinicianOption[];
  clinicianId: string;
  setClinicianId: (id: string) => void;
  /** False until records staff have chosen a clinician. */
  ready: boolean;
  /** Spread into a write request. Empty for a clinician entering directly. */
  body: { onBehalfOfClinicianId?: string };
  clinician: ClinicianOption | null;
}

/**
 * Whose name a clinical entry goes in (Decision C).
 *
 * A clinician needs nothing: the server records them. Records staff must name
 * the clinician whose file they are transcribing. On an encounter the
 * attending clinician is the sensible default, and can be changed.
 */
export function useAttribution(defaultClinicianId?: string | null): AttributionState {
  const { staff } = useAuth();

  const transcribes = Boolean(
    staff &&
    !hasPermission(staff.role, 'clinical:write') &&
    hasPermission(staff.role, 'clinical:transcribe'),
  );

  const clinicians = useClinicians(transcribes);
  const [chosen, setChosen] = useState('');

  const clinicianId = transcribes ? chosen || defaultClinicianId || '' : '';
  const list = clinicians.data ?? [];

  return {
    transcribes,
    clinicians: list,
    clinicianId,
    setClinicianId: setChosen,
    ready: !transcribes || clinicianId !== '',
    body: transcribes && clinicianId ? { onBehalfOfClinicianId: clinicianId } : {},
    clinician: list.find((entry) => entry.id === clinicianId) ?? null,
  };
}

export function ClinicianPicker({
  attribution,
  id,
}: {
  attribution: AttributionState;
  id: string;
}): JSX.Element | null {
  if (!attribution.transcribes) return null;

  return (
    <div className="field transcribing">
      <label htmlFor={id}>Transcribing for</label>
      <select
        id={id}
        value={attribution.clinicianId}
        onChange={(event) => attribution.setClinicianId(event.target.value)}
        required
      >
        <option value="">Choose the clinician whose file this is…</option>
        {attribution.clinicians.map((clinician) => (
          <option key={clinician.id} value={clinician.id}>
            {clinician.name}
            {clinician.systemOfMedicine ? ` · ${SYSTEM_LABELS[clinician.systemOfMedicine]}` : ''}
            {clinician.status !== 'active' ? ' (no longer active)' : ''}
          </option>
        ))}
      </select>
      <span className="muted small">
        Recorded in this clinician&apos;s name, and marked as typed by you.
      </span>
    </div>
  );
}
