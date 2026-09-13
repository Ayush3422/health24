import { useState } from 'react';
import {
  ALLERGY_CATEGORIES,
  ALLERGY_CLINICAL_STATUSES,
  ALLERGY_CRITICALITIES,
  type AllergySummary,
} from '@health24/shared';
import { ApiError } from '../api/client';
import { CRITICALITY_LABELS, useAllergyBanner } from '../api/clinical';
import { useCorrectAllergy, usePatientProcedures, usePatientVitals } from '../api/documentation';
import { EntryActions } from './EntryActions';
import { formatDate, humanise, optionalText } from './format';
import { ProcedureList } from './Procedures';
import { Provenance, SharingNote } from './Provenance';
import { LoincNotice, VitalsList } from './Vitals';

/**
 * The patient's active allergies as a list that can be corrected — or resolved,
 * which is a correction with a new status. The banner above stays read-only.
 */
export function PatientAllergies({
  patientId,
  editable,
}: {
  patientId: string;
  editable: boolean;
}): JSX.Element {
  const banner = useAllergyBanner(patientId);

  return (
    <section>
      <h2>Allergies</h2>
      {banner.isPending ? <p className="muted">Loading…</p> : null}
      {banner.isError ? <p className="alert alert--error">Could not load allergies.</p> : null}
      {banner.isSuccess ? (
        banner.data.allergies.length === 0 ? (
          <p className="muted">No active allergies recorded.</p>
        ) : (
          <ul className="entries">
            {banner.data.allergies.map((allergy) => (
              <AllergyItem key={allergy.id} allergy={allergy} editable={editable} />
            ))}
          </ul>
        )
      ) : null}
    </section>
  );
}

function AllergyItem({
  allergy,
  editable,
}: {
  allergy: AllergySummary;
  editable: boolean;
}): JSX.Element {
  const [correcting, setCorrecting] = useState(false);

  return (
    <li className="entry">
      <div className="entry__header">
        <strong>{allergy.substance}</strong>{' '}
        <span className={`criticality criticality--${allergy.criticality}`}>
          {CRITICALITY_LABELS[allergy.criticality]}
        </span>
        <em className="tag">{humanise(allergy.category)}</em>
      </div>
      {allergy.reaction || allergy.note ? (
        <div className="small">{[allergy.reaction, allergy.note].filter(Boolean).join(' · ')}</div>
      ) : null}
      <div className="small muted">
        {formatDate(allergy.recordedAt)} ·{' '}
        <Provenance
          hospital={allergy.hospital}
          clinician={allergy.recordedBy}
          entry={allergy.entry}
        />
      </div>

      <EntryActions
        kind="allergies"
        id={allergy.id}
        hospital={allergy.hospital}
        entry={allergy.entry}
        supersedesId={allergy.supersedesId}
        editable={editable}
        correctLabel="Correct or resolve"
        onCorrect={() => setCorrecting(true)}
      />

      {correcting ? (
        <AllergyCorrectionForm allergy={allergy} onDone={() => setCorrecting(false)} />
      ) : null}
    </li>
  );
}

function AllergyCorrectionForm({
  allergy,
  onDone,
}: {
  allergy: AllergySummary;
  onDone: () => void;
}): JSX.Element {
  const correct = useCorrectAllergy();

  const [substance, setSubstance] = useState(allergy.substance);
  const [category, setCategory] = useState(allergy.category);
  const [criticality, setCriticality] = useState(allergy.criticality);
  const [clinicalStatus, setClinicalStatus] = useState(allergy.clinicalStatus);
  const [reaction, setReaction] = useState(allergy.reaction ?? '');
  const [note, setNote] = useState(allergy.note ?? '');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);

    try {
      await correct.mutateAsync({
        id: allergy.id,
        body: {
          substance: substance.trim(),
          category,
          criticality,
          clinicalStatus,
          reaction: optionalText(reaction),
          note: optionalText(note),
          reason: reason.trim(),
        },
      });
      onDone();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not correct the allergy');
    }
  };

  const id = allergy.id;

  return (
    <div className="form card">
      <h3>Correct or resolve this allergy</h3>
      {error ? <p className="alert alert--error">{error}</p> : null}

      <div className="form-grid form-grid--four">
        <div className="field">
          <label htmlFor={`allergy-substance-${id}`}>Substance</label>
          <input
            id={`allergy-substance-${id}`}
            value={substance}
            onChange={(event) => setSubstance(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={`allergy-category-${id}`}>Kind</label>
          <select
            id={`allergy-category-${id}`}
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
          <label htmlFor={`allergy-criticality-${id}`}>Risk</label>
          <select
            id={`allergy-criticality-${id}`}
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
        <div className="field">
          <label htmlFor={`allergy-status-${id}`}>Status</label>
          <select
            id={`allergy-status-${id}`}
            value={clinicalStatus}
            onChange={(event) => setClinicalStatus(event.target.value as typeof clinicalStatus)}
          >
            {ALLERGY_CLINICAL_STATUSES.map((value) => (
              <option key={value} value={value}>
                {humanise(value)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="form-grid form-grid--two">
        <div className="field">
          <label htmlFor={`allergy-reaction-${id}`}>Reaction</label>
          <input
            id={`allergy-reaction-${id}`}
            value={reaction}
            onChange={(event) => setReaction(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={`allergy-note-${id}`}>Note</label>
          <input
            id={`allergy-note-${id}`}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </div>
      </div>

      {clinicalStatus !== 'active' ? (
        <p className="alert alert--warning small">
          A {clinicalStatus} allergy leaves the banner and is no longer checked when prescribing.
        </p>
      ) : null}

      <div className="field">
        <label htmlFor={`allergy-reason-${id}`}>Why is this being changed?</label>
        <input
          id={`allergy-reason-${id}`}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Required, e.g. tolerated on rechallenge"
        />
      </div>

      <div className="row">
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!substance.trim() || reason.trim().length < 3 || correct.isPending}
        >
          {correct.isPending ? 'Saving…' : 'Save correction'}
        </button>
        <button type="button" className="ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** The most recent sets of vitals, from every record the hospital may see. */
export function PatientVitals({ patientId }: { patientId: string }): JSX.Element {
  const vitals = usePatientVitals(patientId);

  return (
    <section>
      <h2>Recent vitals</h2>
      {vitals.isPending ? <p className="muted">Loading…</p> : null}
      {vitals.isError ? <p className="alert alert--error">Could not load vitals.</p> : null}
      {vitals.isSuccess ? (
        <>
          <VitalsList
            sets={vitals.data.sets.slice(0, 5)}
            emptyText="No vitals recorded."
            editable={false}
          />
          <SharingNote shared={vitals.data.sharedFromOtherHospitals} what="Vitals" />
          {vitals.data.sets.length > 0 ? <LoincNotice /> : null}
        </>
      ) : null}
    </section>
  );
}

export function PatientProcedures({ patientId }: { patientId: string }): JSX.Element {
  const procedures = usePatientProcedures(patientId);

  return (
    <section>
      <h2>Procedures and therapies</h2>
      {procedures.isPending ? <p className="muted">Loading…</p> : null}
      {procedures.isError ? <p className="alert alert--error">Could not load procedures.</p> : null}
      {procedures.isSuccess ? (
        <>
          <ProcedureList
            procedures={procedures.data.procedures}
            emptyText="No procedures recorded."
            editable={false}
          />
          <SharingNote shared={procedures.data.sharedFromOtherHospitals} what="Procedures" />
        </>
      ) : null}
    </section>
  );
}
