import { useState } from 'react';
import {
  PANCHAKARMA_THERAPIES,
  SYSTEMS_OF_MEDICINE,
  type EncounterSummary,
  type ProcedureSummary,
  type SystemOfMedicine,
} from '@health24/shared';
import { ApiError } from '../api/client';
import { SYSTEM_LABELS, useClinicians } from '../api/clinical';
import { useCorrectProcedure, useRecordProcedure } from '../api/documentation';
import { ClinicianPicker, useAttribution } from './attribution';
import { EntryActions } from './EntryActions';
import { formatDateTime, optionalText } from './format';
import { Provenance, SystemTag } from './Provenance';

export function ProcedureList({
  procedures,
  emptyText,
  editable,
}: {
  procedures: ProcedureSummary[];
  emptyText: string;
  editable: boolean;
}): JSX.Element {
  if (procedures.length === 0) return <p className="muted">{emptyText}</p>;

  return (
    <ul className="entries">
      {procedures.map((procedure) => (
        <ProcedureItem key={procedure.id} procedure={procedure} editable={editable} />
      ))}
    </ul>
  );
}

function ProcedureItem({
  procedure,
  editable,
}: {
  procedure: ProcedureSummary;
  editable: boolean;
}): JSX.Element {
  const [correcting, setCorrecting] = useState(false);

  return (
    <li className="entry">
      <div className="entry__header">
        <strong>{procedure.name}</strong> <SystemTag system={procedure.systemOfMedicine} />
      </div>
      <div className="small">
        {formatDateTime(procedure.performedAt)} · performed by{' '}
        {procedure.performer.name ?? 'a clinician'}
        {procedure.outcome ? ` · ${procedure.outcome}` : ''}
      </div>
      {procedure.notes ? <p className="small entry__note">{procedure.notes}</p> : null}
      <div className="small muted">
        Recorded {formatDateTime(procedure.recordedAt)} ·{' '}
        <Provenance
          hospital={procedure.hospital}
          clinician={procedure.recordedBy}
          entry={procedure.entry}
        />
      </div>

      <EntryActions
        kind="procedures"
        id={procedure.id}
        hospital={procedure.hospital}
        entry={procedure.entry}
        supersedesId={procedure.supersedesId}
        editable={editable}
        onCorrect={() => setCorrecting(true)}
      />

      {correcting ? (
        <ProcedureForm correcting={procedure} onDone={() => setCorrecting(false)} />
      ) : null}
    </li>
  );
}

/** A Date as the value of a datetime-local input, in the browser's own time. */
const toLocalInput = (date: Date): string =>
  new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

/**
 * Recording a procedure or therapy, or correcting one. Panchakarma therapies
 * are offered as suggestions; the name stays free text.
 */
export function ProcedureForm({
  encounter,
  correcting,
  onDone,
}: {
  encounter?: EncounterSummary;
  correcting?: ProcedureSummary;
  onDone?: () => void;
}): JSX.Element {
  const record = useRecordProcedure();
  const correct = useCorrectProcedure();
  const clinicians = useClinicians(true);
  const attribution = useAttribution(encounter?.attending.id);

  const formId = correcting?.id ?? 'new';

  const [name, setName] = useState(correcting?.name ?? '');
  const [system, setSystem] = useState<SystemOfMedicine>(
    correcting?.systemOfMedicine ?? encounter?.systemOfMedicine ?? 'allopathy',
  );
  const [performedAt, setPerformedAt] = useState(
    toLocalInput(correcting ? new Date(correcting.performedAt) : new Date()),
  );
  // Until the time is changed by hand, a new procedure is recorded at the moment it is
  // saved — not when the form happened to be opened.
  const [performedAtTouched, setPerformedAtTouched] = useState(false);
  const [performer, setPerformer] = useState(correcting?.performer.id ?? '');
  const [outcome, setOutcome] = useState(correcting?.outcome ?? '');
  const [notes, setNotes] = useState(correcting?.notes ?? '');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const pending = record.isPending || correct.isPending;

  const submit = async () => {
    setError(null);

    const content = {
      name: name.trim(),
      systemOfMedicine: system,
      performedAt:
        correcting || performedAtTouched
          ? new Date(performedAt).toISOString()
          : new Date().toISOString(),
      performerClinicianId: performer || undefined,
      outcome: optionalText(outcome),
      notes: optionalText(notes),
    };

    try {
      if (correcting) {
        await correct.mutateAsync({
          id: correcting.id,
          body: { ...content, reason: reason.trim() },
        });
        onDone?.();
        return;
      }

      if (!encounter) return;

      await record.mutateAsync({ ...content, encounterId: encounter.id, ...attribution.body });

      setName('');
      setOutcome('');
      setNotes('');
      setPerformedAt(toLocalInput(new Date()));
      setPerformedAtTouched(false);
      setSaved(true);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not save the procedure');
    }
  };

  return (
    <div className="form card">
      <h3>{correcting ? 'Correct this procedure' : 'Record a procedure or therapy'}</h3>
      {saved ? <p className="alert alert--success">Procedure recorded.</p> : null}
      {error ? <p className="alert alert--error">{error}</p> : null}

      {correcting ? null : <ClinicianPicker attribution={attribution} id="procedure-clinician" />}

      <div className="form-grid">
        <div className="field field--wide">
          <label htmlFor={`procedure-name-${formId}`}>Procedure or therapy</label>
          <input
            id={`procedure-name-${formId}`}
            list="panchakarma-therapies"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setSaved(false);
            }}
            placeholder="e.g. Shirodhara, Appendicectomy"
          />
          <datalist id="panchakarma-therapies">
            {PANCHAKARMA_THERAPIES.map((therapy) => (
              <option key={therapy} value={therapy} />
            ))}
          </datalist>
        </div>
        <div className="field">
          <label htmlFor={`procedure-system-${formId}`}>System of medicine</label>
          <select
            id={`procedure-system-${formId}`}
            value={system}
            onChange={(event) => setSystem(event.target.value as SystemOfMedicine)}
          >
            {SYSTEMS_OF_MEDICINE.map((value) => (
              <option key={value} value={value}>
                {SYSTEM_LABELS[value]}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="form-grid">
        <div className="field">
          <label htmlFor={`procedure-when-${formId}`}>Performed at</label>
          <input
            id={`procedure-when-${formId}`}
            type="datetime-local"
            max={toLocalInput(new Date())}
            value={performedAt}
            onChange={(event) => {
              setPerformedAt(event.target.value);
              setPerformedAtTouched(true);
            }}
          />
        </div>
        <div className="field">
          <label htmlFor={`procedure-performer-${formId}`}>Performed by</label>
          <select
            id={`procedure-performer-${formId}`}
            value={performer}
            onChange={(event) => setPerformer(event.target.value)}
          >
            <option value="">The clinician this entry is for</option>
            {(clinicians.data ?? []).map((clinician) => (
              <option key={clinician.id} value={clinician.id}>
                {clinician.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`procedure-outcome-${formId}`}>Outcome</label>
          <input
            id={`procedure-outcome-${formId}`}
            value={outcome}
            onChange={(event) => setOutcome(event.target.value)}
          />
        </div>
      </div>

      <div className="field">
        <label htmlFor={`procedure-notes-${formId}`}>Notes</label>
        <textarea
          id={`procedure-notes-${formId}`}
          rows={2}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
        />
      </div>

      {correcting ? (
        <div className="field">
          <label htmlFor={`procedure-reason-${formId}`}>Why is this being corrected?</label>
          <input
            id={`procedure-reason-${formId}`}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Required. Kept in the procedure’s history."
          />
        </div>
      ) : null}

      <div className="row">
        <button
          type="button"
          onClick={() => void submit()}
          disabled={
            !name.trim() ||
            !performedAt ||
            pending ||
            (correcting ? reason.trim().length < 3 : !attribution.ready)
          }
        >
          {pending ? 'Saving…' : correcting ? 'Save correction' : 'Record procedure'}
        </button>
        {onDone ? (
          <button type="button" className="ghost" onClick={onDone}>
            Cancel
          </button>
        ) : null}
      </div>
    </div>
  );
}
