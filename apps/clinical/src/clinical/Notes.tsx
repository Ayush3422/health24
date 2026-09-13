import { useState } from 'react';
import {
  NOTE_TEMPLATES,
  NOTE_TEMPLATE_KEYS,
  type EncounterSummary,
  type NoteSummary,
  type NoteTemplateKey,
} from '@health24/shared';
import { ApiError } from '../api/client';
import { useCorrectNote, useWriteNote } from '../api/documentation';
import { ClinicianPicker, useAttribution } from './attribution';
import { EntryActions } from './EntryActions';
import { formatDateTime } from './format';
import { Provenance } from './Provenance';

export function NoteList({
  notes,
  emptyText,
  editable,
}: {
  notes: NoteSummary[];
  emptyText: string;
  editable: boolean;
}): JSX.Element {
  if (notes.length === 0) return <p className="muted">{emptyText}</p>;

  return (
    <ul className="entries">
      {notes.map((note) => (
        <NoteItem key={note.id} note={note} editable={editable} />
      ))}
    </ul>
  );
}

function NoteItem({ note, editable }: { note: NoteSummary; editable: boolean }): JSX.Element {
  const [correcting, setCorrecting] = useState(false);

  return (
    <li className="entry">
      <div className="entry__header">
        <strong>{note.title ?? note.templateLabel}</strong>
        {note.title ? <em className="tag">{note.templateLabel}</em> : null}
      </div>

      <dl className="note-sections">
        {note.sections.map((section) => (
          <div key={section.key}>
            <dt>{section.label}</dt>
            <dd className="note-text">{section.text}</dd>
          </div>
        ))}
      </dl>

      <div className="small muted">
        {formatDateTime(note.recordedAt)} ·{' '}
        <Provenance hospital={note.hospital} clinician={note.recordedBy} entry={note.entry} />
      </div>

      <EntryActions
        kind="notes"
        id={note.id}
        hospital={note.hospital}
        entry={note.entry}
        supersedesId={note.supersedesId}
        editable={editable}
        correctLabel="Amend"
        onCorrect={() => setCorrecting(true)}
      />

      {correcting ? <NoteForm correcting={note} onDone={() => setCorrecting(false)} /> : null}
    </li>
  );
}

const defaultTemplate = (encounter?: EncounterSummary): NoteTemplateKey =>
  encounter?.systemOfMedicine === 'ayurveda' ? 'ayurveda_initial' : 'general';

/**
 * Writing a note against a template, or amending one. An amendment is a new
 * version: the original stays in the note's history with the reason given.
 */
export function NoteForm({
  encounter,
  correcting,
  onDone,
}: {
  encounter?: EncounterSummary;
  correcting?: NoteSummary;
  onDone?: () => void;
}): JSX.Element {
  const write = useWriteNote();
  const correct = useCorrectNote();
  const attribution = useAttribution(encounter?.attending.id);

  const [template, setTemplate] = useState<NoteTemplateKey>(
    (correcting?.template as NoteTemplateKey | undefined) ?? defaultTemplate(encounter),
  );
  const [title, setTitle] = useState(correcting?.title ?? '');
  const [sections, setSections] = useState<Record<string, string>>(() =>
    Object.fromEntries((correcting?.sections ?? []).map((section) => [section.key, section.text])),
  );
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const templateSections = NOTE_TEMPLATES[template].sections;
  // Only the chosen template's sections are sent: text typed under another
  // template stays in the form but is not part of this note.
  const written = Object.fromEntries(
    templateSections.map((section) => [section.key, sections[section.key] ?? '']),
  );
  const hasText = Object.values(written).some((text) => text.trim() !== '');
  const pending = write.isPending || correct.isPending;

  const submit = async () => {
    setError(null);

    try {
      if (correcting) {
        await correct.mutateAsync({
          id: correcting.id,
          body: {
            template,
            title: title.trim() || undefined,
            sections: written,
            reason: reason.trim(),
          },
        });
        onDone?.();
        return;
      }

      if (!encounter) return;

      await write.mutateAsync({
        encounterId: encounter.id,
        template,
        title: title.trim() || undefined,
        sections: written,
        ...attribution.body,
      });

      setSections({});
      setTitle('');
      setSaved(true);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not save the note');
    }
  };

  return (
    <div className="form card">
      <h3>{correcting ? 'Amend this note' : 'Write a note'}</h3>
      {saved ? <p className="alert alert--success">Note saved.</p> : null}
      {error ? <p className="alert alert--error">{error}</p> : null}

      {correcting ? null : <ClinicianPicker attribution={attribution} id="note-clinician" />}

      <div className="form-grid form-grid--two">
        <div className="field">
          <label htmlFor={`note-template-${correcting?.id ?? 'new'}`}>Template</label>
          <select
            id={`note-template-${correcting?.id ?? 'new'}`}
            value={template}
            onChange={(event) => setTemplate(event.target.value as NoteTemplateKey)}
          >
            {NOTE_TEMPLATE_KEYS.map((key) => (
              <option key={key} value={key}>
                {NOTE_TEMPLATES[key].label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`note-title-${correcting?.id ?? 'new'}`}>Title</label>
          <input
            id={`note-title-${correcting?.id ?? 'new'}`}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Optional"
          />
        </div>
      </div>

      {templateSections.map((section) => (
        <div className="field" key={section.key}>
          <label htmlFor={`note-${correcting?.id ?? 'new'}-${section.key}`}>{section.label}</label>
          <textarea
            id={`note-${correcting?.id ?? 'new'}-${section.key}`}
            rows={3}
            value={sections[section.key] ?? ''}
            onChange={(event) => {
              setSections((current) => ({ ...current, [section.key]: event.target.value }));
              setSaved(false);
            }}
          />
        </div>
      ))}

      {correcting ? (
        <div className="field">
          <label htmlFor={`note-reason-${correcting.id}`}>Why is the note being amended?</label>
          <input
            id={`note-reason-${correcting.id}`}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Required. Kept in the note’s history."
          />
        </div>
      ) : null}

      <div className="row">
        <button
          type="button"
          onClick={() => void submit()}
          disabled={
            !hasText || pending || (correcting ? reason.trim().length < 3 : !attribution.ready)
          }
        >
          {pending ? 'Saving…' : correcting ? 'Save amendment' : 'Save note'}
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
