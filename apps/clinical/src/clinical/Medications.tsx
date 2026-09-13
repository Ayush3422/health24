import { useState } from 'react';
import {
  DURATION_UNITS,
  FOOD_TIMINGS,
  MEDICATION_ROUTES,
  SYSTEMS_OF_MEDICINE,
  type AllergyMatch,
  type DurationUnit,
  type EncounterSummary,
  type FoodTiming,
  type MedicationRoute,
  type MedicationSummary,
  type SystemOfMedicine,
} from '@health24/shared';
import { ApiError } from '../api/client';
import {
  CRITICALITY_LABELS,
  FOOD_TIMING_LABELS,
  SYSTEM_LABELS,
  allergyMatchesFrom,
  usePrescribe,
  useStopPrescription,
} from '../api/clinical';
import { ClinicianPicker, useAttribution } from './attribution';
import { formatDate, humanise, istToday, optionalText } from './format';
import { Provenance, SystemTag } from './Provenance';

/**
 * Medicines, grouped by system of medicine so traditional and biomedical
 * treatment read as separate blocks — in the order the systems are declared,
 * which puts the traditional systems first.
 */
export function MedicationList({
  medications,
  canStop,
  emptyText,
}: {
  medications: MedicationSummary[];
  canStop: boolean;
  emptyText: string;
}): JSX.Element {
  if (medications.length === 0) {
    return <p className="muted">{emptyText}</p>;
  }

  const groups = SYSTEMS_OF_MEDICINE.map((system) => ({
    system,
    items: medications.filter((medication) => medication.systemOfMedicine === system),
  })).filter((group) => group.items.length > 0);

  return (
    <div className="medication-groups">
      {groups.map((group) => (
        <section key={group.system} className="medication-group">
          <h4>
            <SystemTag system={group.system} />
          </h4>
          <ul className="entries">
            {group.items.map((medication) => (
              <MedicationItem key={medication.id} medication={medication} canStop={canStop} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function MedicationItem({
  medication,
  canStop,
}: {
  medication: MedicationSummary;
  canStop: boolean;
}): JSX.Element {
  const stop = useStopPrescription();
  const [stopping, setStopping] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const dosing = [
    medication.dose ? `${medication.dose.quantity} ${medication.dose.unit}` : null,
    medication.frequency,
    humanise(medication.route),
    medication.vehicle ? `with ${medication.vehicle}` : null,
    medication.foodTiming && medication.foodTiming !== 'not_applicable'
      ? FOOD_TIMING_LABELS[medication.foodTiming].toLowerCase()
      : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const confirmStop = async () => {
    setError(null);

    try {
      await stop.mutateAsync({ id: medication.id, reason: reason.trim() });
      setStopping(false);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not stop the medicine');
    }
  };

  return (
    <li className={`entry ${medication.status === 'active' ? '' : 'entry--ended'}`}>
      <div className="entry__header">
        <strong>{medication.medicineName}</strong>
        {medication.strength ? <span> {medication.strength}</span> : null}
        {medication.form ? <span className="muted"> · {medication.form}</span> : null}
        {medication.status !== 'active' ? <em className="tag">{medication.status}</em> : null}
      </div>

      <div className="small">{dosing}</div>

      <div className="small muted">
        From {formatDate(medication.startDate)}
        {medication.endDate ? ` to ${formatDate(medication.endDate)}` : ', no end date'}
        {medication.endReason ? ` · stopped: ${medication.endReason}` : ''}
      </div>

      {medication.instructions ? (
        <p className="small entry__note">{medication.instructions}</p>
      ) : null}

      {medication.allergyOverrideReason ? (
        <p className="small override-note">
          Prescribed despite a matching recorded allergy: {medication.allergyOverrideReason}
        </p>
      ) : null}

      <div className="small muted">
        {formatDate(medication.prescribedAt)} ·{' '}
        <Provenance
          hospital={medication.hospital}
          clinician={medication.prescriber}
          entry={medication.entry}
        />
      </div>

      {canStop && medication.hospital.isOwn && medication.status === 'active' ? (
        stopping ? (
          <div className="inline-form">
            {error ? <p className="field__error">{error}</p> : null}
            <label htmlFor={`stop-${medication.id}`}>Why is it being stopped?</label>
            <div className="row">
              <input
                id={`stop-${medication.id}`}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Required, e.g. symptoms resolved"
              />
              <button
                type="button"
                className="danger"
                onClick={() => void confirmStop()}
                disabled={reason.trim().length < 3 || stop.isPending}
              >
                Stop medicine
              </button>
              <button type="button" className="ghost" onClick={() => setStopping(false)}>
                Keep
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="link" onClick={() => setStopping(true)}>
            Stop this medicine
          </button>
        )
      ) : null}
    </li>
  );
}

interface Draft {
  systemOfMedicine: SystemOfMedicine;
  medicineName: string;
  form: string;
  strength: string;
  doseQuantity: string;
  doseUnit: string;
  frequency: string;
  route: MedicationRoute;
  durationValue: string;
  durationUnit: DurationUnit;
  startDate: string;
  vehicle: string;
  foodTiming: FoodTiming | '';
  instructions: string;
}

const blankDraft = (encounter: EncounterSummary): Draft => ({
  systemOfMedicine: encounter.systemOfMedicine,
  medicineName: '',
  form: '',
  strength: '',
  doseQuantity: '',
  doseUnit: '',
  frequency: '',
  route: 'oral',
  durationValue: '',
  durationUnit: 'days',
  startDate: istToday(),
  vehicle: '',
  foodTiming: '',
  instructions: '',
});

/**
 * Writing a prescription. When the medicine or its vehicle matches a recorded
 * allergy, the server refuses it and this form shows the match — with where
 * it was recorded — and asks for a reason before it can go ahead.
 */
export function PrescriptionForm({ encounter }: { encounter: EncounterSummary }): JSX.Element {
  const prescribe = usePrescribe();
  const attribution = useAttribution(encounter.attending.id);

  const [draft, setDraft] = useState<Draft>(() => blankDraft(encounter));
  const [warning, setWarning] = useState<{ matches: AllergyMatch[]; limitation: string } | null>(
    null,
  );
  const [overrideReason, setOverrideReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [lastWritten, setLastWritten] = useState<{
    name: string;
    shared: boolean;
    limitation: string;
  } | null>(null);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    // A changed medicine or vehicle is a different prescription to check.
    if (key === 'medicineName' || key === 'vehicle') setWarning(null);
  };

  const doseIncomplete = Boolean(draft.doseQuantity) !== Boolean(draft.doseUnit.trim());
  const canSubmit =
    draft.medicineName.trim() !== '' &&
    draft.frequency.trim() !== '' &&
    !doseIncomplete &&
    attribution.ready &&
    !prescribe.isPending;

  const submit = async (override?: string) => {
    setError(null);

    try {
      const result = await prescribe.mutateAsync({
        encounterId: encounter.id,
        systemOfMedicine: draft.systemOfMedicine,
        medicineName: draft.medicineName.trim(),
        form: optionalText(draft.form),
        strength: optionalText(draft.strength),
        dose:
          draft.doseQuantity && draft.doseUnit.trim()
            ? { quantity: Number(draft.doseQuantity), unit: draft.doseUnit.trim() }
            : undefined,
        frequency: draft.frequency.trim(),
        route: draft.route,
        duration: draft.durationValue
          ? { value: Number(draft.durationValue), unit: draft.durationUnit }
          : undefined,
        startDate: draft.startDate || undefined,
        vehicle: optionalText(draft.vehicle),
        foodTiming: draft.foodTiming || undefined,
        instructions: optionalText(draft.instructions),
        ...(override ? { allergyOverride: { reason: override } } : {}),
        ...attribution.body,
      });

      setLastWritten({
        name: result.medicineName,
        shared: result.allergyCheck.sharedFromOtherHospitals,
        limitation: result.allergyCheck.limitation,
      });
      setWarning(null);
      setOverrideReason('');
      setDraft(blankDraft(encounter));
    } catch (caught) {
      const match = allergyMatchesFrom(caught);

      if (match) {
        setWarning(match);
        return;
      }

      setError(caught instanceof ApiError ? caught.message : 'Could not record the prescription');
    }
  };

  return (
    <div className="form card">
      <h3>Prescribe</h3>

      {lastWritten ? (
        <div className="alert alert--success">
          Prescribed {lastWritten.name}.{' '}
          <span className="small">
            {lastWritten.limitation}
            {lastWritten.shared
              ? ''
              : ' Other hospitals’ allergies are not shared with your hospital.'}
          </span>
        </div>
      ) : null}
      {error ? <p className="alert alert--error">{error}</p> : null}

      <ClinicianPicker attribution={attribution} id="prescription-clinician" />

      <div className="form-grid">
        <div className="field field--wide">
          <label htmlFor="rx-name">Medicine</label>
          <input
            id="rx-name"
            value={draft.medicineName}
            onChange={(event) => set('medicineName', event.target.value)}
            placeholder="e.g. Avipattikar churna, Pantoprazole"
          />
        </div>
        <div className="field">
          <label htmlFor="rx-system">System of medicine</label>
          <select
            id="rx-system"
            value={draft.systemOfMedicine}
            onChange={(event) => set('systemOfMedicine', event.target.value as SystemOfMedicine)}
          >
            {SYSTEMS_OF_MEDICINE.map((value) => (
              <option key={value} value={value}>
                {SYSTEM_LABELS[value]}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="form-grid form-grid--four">
        <div className="field">
          <label htmlFor="rx-form">Form</label>
          <input
            id="rx-form"
            value={draft.form}
            onChange={(event) => set('form', event.target.value)}
            placeholder="tablet, churna…"
          />
        </div>
        <div className="field">
          <label htmlFor="rx-strength">Strength</label>
          <input
            id="rx-strength"
            value={draft.strength}
            onChange={(event) => set('strength', event.target.value)}
            placeholder="40 mg"
          />
        </div>
        <div className="field">
          <label htmlFor="rx-dose">Dose</label>
          <input
            id="rx-dose"
            type="number"
            min="0"
            step="any"
            value={draft.doseQuantity}
            onChange={(event) => set('doseQuantity', event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="rx-dose-unit">Dose unit</label>
          <input
            id="rx-dose-unit"
            value={draft.doseUnit}
            onChange={(event) => set('doseUnit', event.target.value)}
            placeholder="g, ml, tablet"
          />
        </div>
      </div>
      {doseIncomplete ? (
        <p className="field__error">Give both the dose and its unit, or neither.</p>
      ) : null}

      <div className="form-grid form-grid--four">
        <div className="field">
          <label htmlFor="rx-frequency">Frequency</label>
          <input
            id="rx-frequency"
            value={draft.frequency}
            onChange={(event) => set('frequency', event.target.value)}
            placeholder="1-0-1"
          />
        </div>
        <div className="field">
          <label htmlFor="rx-route">Route</label>
          <select
            id="rx-route"
            value={draft.route}
            onChange={(event) => set('route', event.target.value as MedicationRoute)}
          >
            {MEDICATION_ROUTES.map((value) => (
              <option key={value} value={value}>
                {humanise(value)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="rx-duration">For</label>
          <input
            id="rx-duration"
            type="number"
            min="1"
            step="1"
            value={draft.durationValue}
            onChange={(event) => set('durationValue', event.target.value)}
            placeholder="Open-ended"
          />
        </div>
        <div className="field">
          <label htmlFor="rx-duration-unit">Unit</label>
          <select
            id="rx-duration-unit"
            value={draft.durationUnit}
            onChange={(event) => set('durationUnit', event.target.value as DurationUnit)}
          >
            {DURATION_UNITS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="form-grid form-grid--four">
        <div className="field">
          <label htmlFor="rx-vehicle">Taken with (anupana)</label>
          <input
            id="rx-vehicle"
            value={draft.vehicle}
            onChange={(event) => set('vehicle', event.target.value)}
            placeholder="warm water, honey"
          />
        </div>
        <div className="field">
          <label htmlFor="rx-food">Timing</label>
          <select
            id="rx-food"
            value={draft.foodTiming}
            onChange={(event) => set('foodTiming', event.target.value as FoodTiming | '')}
          >
            <option value="">Not specified</option>
            {FOOD_TIMINGS.map((value) => (
              <option key={value} value={value}>
                {FOOD_TIMING_LABELS[value]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="rx-start">Starts</label>
          <input
            id="rx-start"
            type="date"
            value={draft.startDate}
            onChange={(event) => set('startDate', event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="rx-instructions">Instructions</label>
          <input
            id="rx-instructions"
            value={draft.instructions}
            onChange={(event) => set('instructions', event.target.value)}
          />
        </div>
      </div>

      {warning ? (
        <div className="allergy-warning" role="alert">
          <strong>This patient has a recorded allergy matching this prescription.</strong>
          <ul>
            {warning.matches.map((match) => (
              <li key={match.allergyId}>
                <strong>{match.substance}</strong>{' '}
                <span className={`criticality criticality--${match.criticality}`}>
                  {CRITICALITY_LABELS[match.criticality]}
                </span>
                {match.reaction ? ` · ${match.reaction}` : ''} · matches the{' '}
                {match.matchedField === 'vehicle' ? 'vehicle' : 'medicine'} ·{' '}
                {match.hospital.isOwn ? 'recorded here' : `recorded at ${match.hospital.name}`}
              </li>
            ))}
          </ul>
          <p className="small">{warning.limitation}</p>

          <div className="field">
            <label htmlFor="rx-override">To prescribe anyway, record why</label>
            <input
              id="rx-override"
              value={overrideReason}
              onChange={(event) => setOverrideReason(event.target.value)}
              placeholder="Kept on the prescription, e.g. tolerated under supervision"
            />
          </div>

          <div className="row">
            <button
              type="button"
              className="danger"
              onClick={() => void submit(overrideReason.trim())}
              disabled={overrideReason.trim().length < 3 || !canSubmit}
            >
              Prescribe despite the allergy
            </button>
            <button type="button" className="ghost" onClick={() => setWarning(null)}>
              Change the prescription
            </button>
          </div>
        </div>
      ) : (
        <div className="row">
          <button type="button" onClick={() => void submit()} disabled={!canSubmit}>
            {prescribe.isPending ? 'Checking…' : 'Prescribe'}
          </button>
        </div>
      )}
    </div>
  );
}
