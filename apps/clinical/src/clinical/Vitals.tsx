import { useState } from 'react';
import {
  LOINC_ATTRIBUTION,
  VITAL_SIGNS,
  type EncounterSummary,
  type VitalSet,
} from '@health24/shared';
import { ApiError } from '../api/client';
import { useMarkVitalsInError, useRecordVitals } from '../api/documentation';
import { ClinicianPicker, useAttribution } from './attribution';
import { useCanChange } from './EntryActions';
import { formatDateTime } from './format';
import { Provenance } from './Provenance';

/** UCUM units, as a clinician writes them. */
const UNIT_LABELS: Record<string, string> = {
  'mm[Hg]': 'mmHg',
  Cel: '°C',
  '/min': '/min',
  '%': '%',
  cm: 'cm',
  kg: 'kg',
  'kg/m2': 'kg/m²',
};

const unitLabel = (unit: string): string => UNIT_LABELS[unit] ?? unit;

/** One line of readings: blood pressure as systolic/diastolic, the rest in panel order. */
function readingsLine(set: VitalSet): string {
  const byKey = new Map(set.readings.map((reading) => [reading.key, reading]));
  const parts: string[] = [];

  const systolic = byKey.get('systolic');
  const diastolic = byKey.get('diastolic');

  if (systolic && diastolic) {
    parts.push(`BP ${systolic.value}/${diastolic.value} ${unitLabel(systolic.unit)}`);
  }

  for (const reading of set.readings) {
    if (reading.key === 'systolic' || reading.key === 'diastolic') continue;
    parts.push(`${VITAL_SIGNS[reading.key].label} ${reading.value} ${unitLabel(reading.unit)}`);
  }

  return parts.join(' · ');
}

export function VitalsList({
  sets,
  emptyText,
  editable,
}: {
  sets: VitalSet[];
  emptyText: string;
  editable: boolean;
}): JSX.Element {
  if (sets.length === 0) return <p className="muted">{emptyText}</p>;

  return (
    <ul className="entries">
      {sets.map((set) => (
        <li key={set.id} className="entry">
          <div className="vital-readings">{readingsLine(set)}</div>
          <div className="small muted">
            {formatDateTime(set.effectiveAt)} ·{' '}
            <Provenance hospital={set.hospital} clinician={set.recordedBy} entry={set.entry} />
          </div>
          {editable ? <VitalsInError set={set} /> : null}
        </li>
      ))}
    </ul>
  );
}

function VitalsInError({ set }: { set: VitalSet }): JSX.Element | null {
  const canChange = useCanChange(set.hospital, set.entry);
  const mark = useMarkVitalsInError();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (!canChange) return null;

  if (!open) {
    return (
      <button type="button" className="link link--danger" onClick={() => setOpen(true)}>
        Entered in error…
      </button>
    );
  }

  const confirm = async () => {
    setError(null);
    try {
      await mark.mutateAsync({ groupId: set.id, reason: reason.trim() });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not mark the readings');
    }
  };

  return (
    <div className="inline-form">
      {error ? <p className="field__error">{error}</p> : null}
      <label htmlFor={`vitals-error-${set.id}`}>Why were these readings entered in error?</label>
      <div className="row">
        <input
          id={`vitals-error-${set.id}`}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Required. The whole set is marked, and kept."
        />
        <button
          type="button"
          className="danger"
          onClick={() => void confirm()}
          disabled={reason.trim().length < 3 || mark.isPending}
        >
          Mark set entered in error
        </button>
        <button type="button" className="ghost" onClick={() => setOpen(false)}>
          Keep
        </button>
      </div>
    </div>
  );
}

const MEASURED = [
  'systolic',
  'diastolic',
  'heartRate',
  'respiratoryRate',
  'temperature',
  'oxygenSaturation',
  'height',
  'weight',
] as const;
type Measured = (typeof MEASURED)[number];

/**
 * Recording a set of vitals. Temperature may be typed in Fahrenheit, as it
 * usually is at an Indian bedside; it is stored in Celsius. BMI is worked out
 * by the server from height and weight.
 */
export function VitalsForm({
  patientId,
  encounter,
}: {
  patientId: string;
  encounter?: EncounterSummary;
}): JSX.Element {
  const record = useRecordVitals();
  const attribution = useAttribution(encounter?.attending.id);

  const [values, setValues] = useState<Record<Measured, string>>({
    systolic: '',
    diastolic: '',
    heartRate: '',
    respiratoryRate: '',
    temperature: '',
    oxygenSaturation: '',
    height: '',
    weight: '',
  });
  const [fahrenheit, setFahrenheit] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const set = (key: Measured, value: string) => {
    setValues((current) => ({ ...current, [key]: value }));
    setSaved(false);
  };

  const anyReading = MEASURED.some((key) => values[key].trim() !== '');

  const submit = async () => {
    setError(null);

    const readings: Partial<Record<Measured, number>> = {};

    for (const key of MEASURED) {
      const raw = values[key].trim();
      if (!raw) continue;

      const number = Number(raw);
      readings[key] =
        key === 'temperature' && fahrenheit
          ? Math.round((((number - 32) * 5) / 9) * 10) / 10
          : number;
    }

    try {
      await record.mutateAsync({
        patientId,
        encounterId: encounter?.id,
        readings,
        ...attribution.body,
      });

      setValues({
        systolic: '',
        diastolic: '',
        heartRate: '',
        respiratoryRate: '',
        temperature: '',
        oxygenSaturation: '',
        height: '',
        weight: '',
      });
      setSaved(true);
    } catch (caught) {
      if (caught instanceof ApiError && caught.fieldErrors.length > 0) {
        setError(caught.fieldErrors.map((entry) => entry.message).join(' '));
      } else {
        setError(caught instanceof ApiError ? caught.message : 'Could not record the vitals');
      }
    }
  };

  const field = (key: Measured, label: string, unit: string, step = '1') => (
    <div className="field">
      <label htmlFor={`vital-${key}`}>
        {label} <span className="muted small">{unit}</span>
      </label>
      <input
        id={`vital-${key}`}
        type="number"
        inputMode="decimal"
        step={step}
        value={values[key]}
        onChange={(event) => set(key, event.target.value)}
      />
    </div>
  );

  return (
    <div className="form card">
      <h3>Record vitals</h3>
      {saved ? <p className="alert alert--success">Vitals recorded.</p> : null}
      {error ? <p className="alert alert--error">{error}</p> : null}

      <ClinicianPicker attribution={attribution} id="vitals-clinician" />

      <div className="form-grid form-grid--four">
        {field('systolic', 'Systolic', 'mmHg')}
        {field('diastolic', 'Diastolic', 'mmHg')}
        {field('heartRate', 'Pulse', '/min')}
        {field('respiratoryRate', 'Respiratory rate', '/min')}
      </div>

      <div className="form-grid form-grid--four">
        <div className="field">
          <label htmlFor="vital-temperature">
            Temperature{' '}
            <select
              aria-label="Temperature unit"
              className="unit-select"
              value={fahrenheit ? 'F' : 'C'}
              onChange={(event) => setFahrenheit(event.target.value === 'F')}
            >
              <option value="C">°C</option>
              <option value="F">°F</option>
            </select>
          </label>
          <input
            id="vital-temperature"
            type="number"
            inputMode="decimal"
            step="0.1"
            value={values.temperature}
            onChange={(event) => set('temperature', event.target.value)}
          />
        </div>
        {field('oxygenSaturation', 'SpO₂', '%')}
        {field('height', 'Height', 'cm', '0.1')}
        {field('weight', 'Weight', 'kg', '0.1')}
      </div>

      <div className="row">
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!anyReading || !attribution.ready || record.isPending}
        >
          {record.isPending ? 'Saving…' : 'Record vitals'}
        </button>
      </div>
    </div>
  );
}

/** LOINC's licence requires this notice wherever its codes are shown. */
export function LoincNotice(): JSX.Element {
  return <p className="attribution">{LOINC_ATTRIBUTION}</p>;
}
