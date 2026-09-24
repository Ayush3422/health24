import { useState } from 'react';
import type { EncounterSummary, ImplantSummary, ProcedureSummary } from '@health24/shared';
import { ApiError } from '../api/client';
import { useCorrectImplant, useRecordImplant } from '../api/implants';
import { ClinicianPicker, useAttribution } from './attribution';
import { EntryActions } from './EntryActions';
import { formatDateTime, optionalText } from './format';
import { Provenance } from './Provenance';

/**
 * Implants and devices (sp6-plan.md, Phase 4).
 *
 * What was put into the patient, and how to find it again. The serial or lot
 * is what a recall notice is answered with, so it is shown plainly rather than
 * buried in a note.
 */
export function ImplantList({
  implants,
  editable,
}: {
  implants: ImplantSummary[];
  editable: boolean;
}): JSX.Element {
  if (implants.length === 0) {
    return <p className="muted">No devices recorded on this encounter.</p>;
  }

  return (
    <ul className="entries">
      {implants.map((implant) => (
        <ImplantItem key={implant.id} implant={implant} editable={editable} />
      ))}
    </ul>
  );
}

function ImplantItem({
  implant,
  editable,
}: {
  implant: ImplantSummary;
  editable: boolean;
}): JSX.Element {
  const [correcting, setCorrecting] = useState(false);

  return (
    <li className="entry">
      <div className="entry__header">
        <strong>{implant.name}</strong>
        {implant.serialOrLot ? <span className="code"> {implant.serialOrLot}</span> : null}
      </div>
      <div className="small">
        {[implant.manufacturer, implant.model].filter(Boolean).join(' · ')}
        {implant.manufacturer || implant.model ? ' · ' : ''}
        implanted {formatDateTime(implant.implantedAt)}
        {implant.procedureName ? ` · ${implant.procedureName}` : ''}
      </div>
      {implant.notes ? <p className="small entry__note">{implant.notes}</p> : null}
      <div className="small muted">
        <Provenance
          hospital={implant.hospital}
          clinician={implant.recordedBy}
          entry={implant.entry}
        />
      </div>

      <EntryActions
        kind="implants"
        id={implant.id}
        hospital={implant.hospital}
        entry={implant.entry}
        supersedesId={implant.supersedesId}
        editable={editable}
        onCorrect={() => setCorrecting(true)}
      />

      {correcting ? <ImplantForm correcting={implant} onDone={() => setCorrecting(false)} /> : null}
    </li>
  );
}

/** Recording a device, or correcting one that was typed from the wrong sticker. */
export function ImplantForm({
  encounter,
  procedures,
  correcting,
  onDone,
}: {
  encounter?: EncounterSummary;
  /** The operations on this encounter, so the device names the one it came from. */
  procedures?: ProcedureSummary[];
  correcting?: ImplantSummary;
  onDone?: () => void;
}): JSX.Element {
  const record = useRecordImplant();
  const correct = useCorrectImplant();
  const attribution = useAttribution(encounter?.attending.id);

  const formId = correcting?.id ?? 'new';

  const [name, setName] = useState(correcting?.name ?? '');
  const [manufacturer, setManufacturer] = useState(correcting?.manufacturer ?? '');
  const [model, setModel] = useState(correcting?.model ?? '');
  const [serial, setSerial] = useState(correcting?.serialOrLot ?? '');
  const [procedureId, setProcedureId] = useState(correcting?.procedureId ?? '');
  const [notes, setNotes] = useState(correcting?.notes ?? '');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const pending = record.isPending || correct.isPending;
  const options = procedures ?? [];

  const submit = async () => {
    setError(null);

    const content = {
      name: name.trim(),
      manufacturer: optionalText(manufacturer),
      model: optionalText(model),
      serialOrLot: optionalText(serial),
      notes: optionalText(notes),
      ...(procedureId ? { procedureId } : {}),
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
      setManufacturer('');
      setModel('');
      setSerial('');
      setNotes('');
      setSaved(true);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not record the device');
    }
  };

  return (
    <div className="form card">
      <h3>{correcting ? 'Correct this device' : 'Record an implant or device'}</h3>
      {saved ? <p className="alert alert--success">Device recorded.</p> : null}
      {error ? <p className="alert alert--error">{error}</p> : null}

      {correcting ? null : <ClinicianPicker attribution={attribution} id="implant-clinician" />}

      <div className="form-grid">
        <div className="field field--wide">
          <label htmlFor={`implant-name-${formId}`}>Device</label>
          <input
            id={`implant-name-${formId}`}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setSaved(false);
            }}
            placeholder="e.g. Uncemented acetabular cup"
          />
        </div>
        <div className="field">
          <label htmlFor={`implant-maker-${formId}`}>Manufacturer</label>
          <input
            id={`implant-maker-${formId}`}
            value={manufacturer}
            onChange={(event) => setManufacturer(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={`implant-model-${formId}`}>Model</label>
          <input
            id={`implant-model-${formId}`}
            value={model}
            onChange={(event) => setModel(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={`implant-serial-${formId}`}>Serial or lot</label>
          <input
            id={`implant-serial-${formId}`}
            value={serial}
            onChange={(event) => setSerial(event.target.value)}
            placeholder="From the sticker"
          />
        </div>
        {options.length > 0 ? (
          <div className="field">
            <label htmlFor={`implant-procedure-${formId}`}>Implanted during</label>
            <select
              id={`implant-procedure-${formId}`}
              value={procedureId}
              onChange={(event) => setProcedureId(event.target.value)}
            >
              <option value="">Not recorded against an operation</option>
              {options.map((procedure) => (
                <option key={procedure.id} value={procedure.id}>
                  {`${procedure.name} · ${formatDateTime(procedure.performedAt)}`}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <div className="field field--wide">
          <label htmlFor={`implant-notes-${formId}`}>Notes</label>
          <input
            id={`implant-notes-${formId}`}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            placeholder="e.g. right hip, 52 mm"
          />
        </div>
      </div>

      {correcting ? (
        <div className="field field--wide">
          <label htmlFor={`implant-reason-${formId}`}>Why is it being corrected?</label>
          <input
            id={`implant-reason-${formId}`}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Required, e.g. lot typed from the wrong sticker"
          />
        </div>
      ) : null}

      <div className="row">
        <button
          type="button"
          onClick={() => void submit()}
          disabled={
            name.trim().length < 2 ||
            pending ||
            !attribution.ready ||
            (correcting !== undefined && reason.trim().length < 3)
          }
        >
          {correcting ? 'Save the correction' : 'Record the device'}
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
