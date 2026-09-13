import { useState } from 'react';
import { ALLERGY_CATEGORIES, ALLERGY_CRITICALITIES } from '@health24/shared';
import { ApiError } from '../api/client';
import { CRITICALITY_LABELS, useAllergyBanner, useRecordAllergy } from '../api/clinical';
import { ClinicianPicker, useAttribution } from './attribution';
import { humanise, optionalText } from './format';

/**
 * The allergy banner, at the top of every clinical screen for a patient.
 *
 * It never says "no known allergies". It says none are recorded in what this
 * hospital can see — and when other hospitals' allergies are not shared, it
 * says that too, because an empty banner is exactly where a missed allergy
 * would hide.
 */
export function AllergyBanner({ patientId }: { patientId: string }): JSX.Element {
  const banner = useAllergyBanner(patientId);

  if (banner.isPending) {
    return (
      <div className="allergy-banner" role="status">
        Checking allergies…
      </div>
    );
  }

  if (banner.isError) {
    return (
      <div className="allergy-banner allergy-banner--alert" role="alert">
        <strong>Allergies could not be loaded.</strong> Ask the patient before prescribing.
      </div>
    );
  }

  const { allergies, sharedFromOtherHospitals } = banner.data;
  const notShared = sharedFromOtherHospitals
    ? null
    : ' Other hospitals’ allergy records are not shared with your hospital.';

  if (allergies.length === 0) {
    return (
      <div className="allergy-banner" role="status">
        <strong>No allergies recorded</strong> in the records your hospital can see.{notShared}
      </div>
    );
  }

  return (
    <div className="allergy-banner allergy-banner--alert" role="alert">
      <strong className="allergy-banner__title">Allergies</strong>
      <ul>
        {allergies.map((allergy) => (
          <li key={allergy.id}>
            <strong>{allergy.substance}</strong>{' '}
            <span className={`criticality criticality--${allergy.criticality}`}>
              {CRITICALITY_LABELS[allergy.criticality]}
            </span>
            {allergy.reaction ? <span> · {allergy.reaction}</span> : null}
            {allergy.hospital.isOwn ? null : (
              <span className="allergy-banner__source"> · recorded at {allergy.hospital.name}</span>
            )}
          </li>
        ))}
      </ul>
      {notShared ? <span className="small">{notShared.trim()}</span> : null}
    </div>
  );
}

export function RecordAllergyForm({
  patientId,
  onDone,
}: {
  patientId: string;
  onDone: () => void;
}): JSX.Element {
  const record = useRecordAllergy();
  const attribution = useAttribution();

  const [substance, setSubstance] = useState('');
  const [category, setCategory] = useState<(typeof ALLERGY_CATEGORIES)[number]>('medication');
  const [criticality, setCriticality] =
    useState<(typeof ALLERGY_CRITICALITIES)[number]>('unable_to_assess');
  const [reaction, setReaction] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);

    try {
      await record.mutateAsync({
        patientId,
        substance: substance.trim(),
        category,
        criticality,
        reaction: optionalText(reaction),
        note: optionalText(note),
        ...attribution.body,
      });
      onDone();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not record the allergy');
    }
  };

  return (
    <div className="form card">
      <h3>Record an allergy</h3>
      {error ? <p className="alert alert--error">{error}</p> : null}

      <ClinicianPicker attribution={attribution} id="allergy-clinician" />

      <div className="form-grid">
        <div className="field">
          <label htmlFor="allergy-substance">Substance</label>
          <input
            id="allergy-substance"
            value={substance}
            onChange={(event) => setSubstance(event.target.value)}
            placeholder="As it would be prescribed, e.g. Penicillin V"
          />
        </div>
        <div className="field">
          <label htmlFor="allergy-category">Kind</label>
          <select
            id="allergy-category"
            value={category}
            onChange={(event) => setCategory(event.target.value as typeof category)}
          >
            {ALLERGY_CATEGORIES.map((value) => (
              <option key={value} value={value}>
                {humanise(value)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="allergy-criticality">Risk</label>
          <select
            id="allergy-criticality"
            value={criticality}
            onChange={(event) => setCriticality(event.target.value as typeof criticality)}
          >
            {ALLERGY_CRITICALITIES.map((value) => (
              <option key={value} value={value}>
                {CRITICALITY_LABELS[value]}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="form-grid form-grid--two">
        <div className="field">
          <label htmlFor="allergy-reaction">Reaction</label>
          <input
            id="allergy-reaction"
            value={reaction}
            onChange={(event) => setReaction(event.target.value)}
            placeholder="e.g. hives, breathlessness"
          />
        </div>
        <div className="field">
          <label htmlFor="allergy-note">Note</label>
          <input id="allergy-note" value={note} onChange={(event) => setNote(event.target.value)} />
        </div>
      </div>

      <p className="muted small">
        Prescriptions are checked against the substance by exact name, so write it as it would
        appear on a prescription.
      </p>

      <div className="row">
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!substance.trim() || !attribution.ready || record.isPending}
        >
          {record.isPending ? 'Saving…' : 'Record allergy'}
        </button>
        <button type="button" className="ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}
