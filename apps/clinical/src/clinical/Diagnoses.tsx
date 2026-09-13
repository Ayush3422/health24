import { useState } from 'react';
import {
  CONDITION_CLINICAL_STATUSES,
  CONDITION_VERIFICATION_STATUSES,
  TERMINOLOGY_KEYS,
  type ConceptSummary,
  type ConditionSummary,
  type EncounterSummary,
} from '@health24/shared';
import { ApiError } from '../api/client';
import { CODE_SYSTEM_LABELS, useRecordDiagnosis } from '../api/clinical';
import { useCorrectDiagnosis } from '../api/documentation';
import { useAutoCode, useCodeSystems, useTerminologySearch } from '../api/terminology';
import { ClinicianPicker, useAttribution } from './attribution';
import { CodingRow } from './CodingRow';
import { EntryActions } from './EntryActions';
import { formatDate, humanise, istToday, optionalText } from './format';
import { Provenance } from './Provenance';
import { useDebouncedValue } from './useDebouncedValue';

const systemLabel = (key: string): string => CODE_SYSTEM_LABELS[key] ?? key;

/**
 * Diagnoses as recorded: the clinician's selection, the TM2 translation and
 * any advisory biomedical code, exactly as they were attached at the time.
 * `compact` is for the problem list, where one line per coding is enough.
 * With an `encounter`, each diagnosis can be corrected or marked in error.
 */
export function DiagnosisList({
  conditions,
  compact = false,
  emptyText,
  encounter,
}: {
  conditions: ConditionSummary[];
  compact?: boolean;
  emptyText: string;
  encounter?: EncounterSummary;
}): JSX.Element {
  if (conditions.length === 0) {
    return <p className="muted">{emptyText}</p>;
  }

  return (
    <ul className="entries">
      {conditions.map((condition) => (
        <DiagnosisItem
          key={condition.id}
          condition={condition}
          compact={compact}
          encounter={encounter}
        />
      ))}
    </ul>
  );
}

function DiagnosisItem({
  condition,
  compact,
  encounter,
}: {
  condition: ConditionSummary;
  compact: boolean;
  encounter?: EncounterSummary;
}): JSX.Element {
  const [correcting, setCorrecting] = useState(false);
  const { primary, translated, advisory } = condition.codings;

  return (
    <li className="entry">
      <div className="entry__header">
        <strong>{primary.display}</strong> <span className="code">{primary.code}</span>
        {condition.isPrimary ? <em className="tag tag--primary">Primary</em> : null}
        {condition.verificationStatus === 'provisional' ? (
          <em className="tag">Provisional</em>
        ) : null}
        {condition.clinicalStatus !== 'active' ? (
          <em className="tag">{humanise(condition.clinicalStatus)}</em>
        ) : null}
      </div>

      {compact ? (
        <div className="small">
          <span className="muted">{systemLabel(primary.system)}</span>
          {translated ? (
            <>
              {' · '}
              <span className="muted">TM2</span> {translated.display}{' '}
              <span className="code">{translated.code}</span>
            </>
          ) : null}
          {advisory ? (
            <span className="advisory-inline">
              {' · '}suggested biomedical: {advisory.display}{' '}
              <span className="code">{advisory.code}</span> (not a diagnosis)
            </span>
          ) : null}
        </div>
      ) : (
        <div className="entry__codings">
          <CodingRow
            label={`Clinician’s selection · ${systemLabel(primary.system)}`}
            coding={primary}
          />
          <CodingRow
            label="Translation · ICD-11 TM2"
            coding={translated}
            emptyText="Not attached"
          />
          <CodingRow
            label="Advisory · biomedical"
            coding={advisory}
            emptyText="Not attached"
            advisory
          />
        </div>
      )}

      {condition.onsetDate || condition.note ? (
        <p className="small entry__note">
          {condition.onsetDate ? `Since ${formatDate(condition.onsetDate)}. ` : ''}
          {condition.note ?? ''}
        </p>
      ) : null}

      <div className="small muted">
        {formatDate(condition.recordedAt)} ·{' '}
        <Provenance
          hospital={condition.hospital}
          clinician={condition.recordedBy}
          entry={condition.entry}
        />
      </div>

      <EntryActions
        kind="diagnoses"
        id={condition.id}
        hospital={condition.hospital}
        entry={condition.entry}
        supersedesId={condition.supersedesId}
        editable={Boolean(encounter)}
        onCorrect={encounter ? () => setCorrecting(true) : undefined}
      />

      {correcting && encounter ? (
        <DiagnosisEntry
          encounter={encounter}
          hasPrimary
          correcting={condition}
          onDone={() => setCorrecting(false)}
        />
      ) : null}
    </li>
  );
}

/**
 * Recording a diagnosis — or correcting one — by searching the clinician's own
 * vocabulary and seeing what will be attached. The preview is the same
 * auto-coding the server performs, so what is shown before saving is what is
 * saved. A correction re-codes the chosen term afresh; the original keeps what
 * it was recorded with.
 */
export function DiagnosisEntry({
  encounter,
  hasPrimary,
  correcting,
  onDone,
}: {
  encounter: EncounterSummary;
  hasPrimary: boolean;
  correcting?: ConditionSummary;
  onDone?: () => void;
}): JSX.Element {
  const systems = useCodeSystems();
  const activeSystems = (systems.data ?? []).filter((system) => system.status === 'active');
  const record = useRecordDiagnosis();
  const correct = useCorrectDiagnosis();
  const attribution = useAttribution(encounter.attending.id);

  const original = correcting?.codings.primary;

  const [systemKey, setSystemKey] = useState<string>(original?.system ?? TERMINOLOGY_KEYS.namaste);
  const [term, setTerm] = useState('');
  const [selected, setSelected] = useState<ConceptSummary | null>(
    original
      ? ({
          code: original.code,
          display: original.display,
          designations: [],
        } as unknown as ConceptSummary)
      : null,
  );
  const [isPrimary, setIsPrimary] = useState(correcting ? correcting.isPrimary : !hasPrimary);
  const [clinicalStatus, setClinicalStatus] = useState<
    (typeof CONDITION_CLINICAL_STATUSES)[number]
  >(correcting?.clinicalStatus ?? 'active');
  const [verificationStatus, setVerificationStatus] = useState<
    (typeof CONDITION_VERIFICATION_STATUSES)[number]
  >(correcting?.verificationStatus ?? 'confirmed');
  const [onsetDate, setOnsetDate] = useState(correcting?.onsetDate ?? '');
  const [note, setNote] = useState(correcting?.note ?? '');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [recorded, setRecorded] = useState<{ name: string; notes: string[] } | null>(null);

  const debouncedTerm = useDebouncedValue(term, 250);
  const search = useTerminologySearch(systemKey, debouncedTerm);
  const results = debouncedTerm.trim() && !selected ? (search.data ?? []) : [];
  const preview = useAutoCode(systemKey, selected?.code ?? null, Boolean(selected));
  const system = activeSystems.find((entry) => entry.key === systemKey);
  const pending = record.isPending || correct.isPending;
  const idPrefix = correcting ? `diagnosis-${correcting.id}` : 'diagnosis';

  const reset = () => {
    setSelected(null);
    setTerm('');
    setNote('');
    setOnsetDate('');
    setClinicalStatus('active');
    setVerificationStatus('confirmed');
    setIsPrimary(false);
  };

  const submit = async () => {
    if (!selected) return;
    setError(null);

    const content = {
      system: systemKey,
      code: selected.code,
      isPrimary,
      clinicalStatus,
      verificationStatus,
      onsetDate: onsetDate || undefined,
      note: optionalText(note),
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

      const result = await record.mutateAsync({
        ...content,
        encounterId: encounter.id,
        ...attribution.body,
      });

      setRecorded({ name: result.codings.primary.display, notes: result.codingNotes });
      reset();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not save the diagnosis');
    }
  };

  return (
    <div className="form card">
      <h3>{correcting ? 'Correct this diagnosis' : 'Add a diagnosis'}</h3>

      {recorded ? (
        <div className="alert alert--success">
          Recorded {recorded.name}.
          {recorded.notes.length > 0 ? (
            <ul className="notes">
              {recorded.notes.map((entry) => (
                <li key={entry}>{entry}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {error ? <p className="alert alert--error">{error}</p> : null}

      {correcting ? null : <ClinicianPicker attribution={attribution} id="diagnosis-clinician" />}

      <div className="form-grid form-grid--search">
        <div className="field">
          <label htmlFor={`${idPrefix}-system`}>Vocabulary</label>
          <select
            id={`${idPrefix}-system`}
            value={systemKey}
            onChange={(event) => {
              setSystemKey(event.target.value);
              setSelected(null);
            }}
          >
            {activeSystems.map((entry) => (
              <option key={entry.key} value={entry.key}>
                {entry.name}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor={`${idPrefix}-search`}>Search</label>
          <input
            id={`${idPrefix}-search`}
            value={selected ? selected.display : term}
            onChange={(event) => {
              setSelected(null);
              setTerm(event.target.value);
              setRecorded(null);
            }}
            placeholder="Type a term, in any script: अम्लपित्त, amlapitta…"
            autoComplete="off"
          />
        </div>
      </div>

      {system?.experimental ? (
        <p className="demo-banner" role="note">
          Demo terminology: synthetic codes, not for use on a real patient record.
        </p>
      ) : null}

      {results.length > 0 ? (
        <ul className="results" aria-label="Matching terms">
          {results.map((result) => (
            <li key={result.code}>
              <button type="button" onClick={() => setSelected(result)}>
                <strong>{result.display}</strong> <span className="code">{result.code}</span>
                {result.designations.length > 0 ? (
                  <span className="result__names">
                    {result.designations.slice(0, 4).map((designation) => (
                      <span key={`${designation.language}-${designation.value}`}>
                        {designation.value}
                      </span>
                    ))}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {debouncedTerm.trim() && !selected && search.isSuccess && results.length === 0 ? (
        <p className="muted">No terms match “{debouncedTerm}”.</p>
      ) : null}

      {selected ? (
        <>
          <div className="auto-code">
            <h4>Will be recorded as</h4>
            {preview.isPending ? (
              <p className="muted">Working out the codings…</p>
            ) : preview.isError ? (
              <p className="alert alert--error">Could not work out the codings for this term.</p>
            ) : (
              <>
                <CodingRow
                  label={`Clinician’s selection · ${systemLabel(preview.data.primary.system)}`}
                  coding={preview.data.primary}
                />
                <CodingRow
                  label="Translation · ICD-11 TM2"
                  coding={preview.data.translated}
                  emptyText="Not attached"
                />
                <CodingRow
                  label="Advisory · biomedical"
                  coding={preview.data.advisory}
                  emptyText="Not attached"
                  advisory
                />
              </>
            )}
          </div>

          <div className="form-grid">
            <div className="field">
              <label htmlFor={`${idPrefix}-status`}>Status</label>
              <select
                id={`${idPrefix}-status`}
                value={clinicalStatus}
                onChange={(event) => setClinicalStatus(event.target.value as typeof clinicalStatus)}
              >
                {CONDITION_CLINICAL_STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {humanise(value)}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor={`${idPrefix}-verification`}>Certainty</label>
              <select
                id={`${idPrefix}-verification`}
                value={verificationStatus}
                onChange={(event) =>
                  setVerificationStatus(event.target.value as typeof verificationStatus)
                }
              >
                {CONDITION_VERIFICATION_STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {humanise(value)}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor={`${idPrefix}-onset`}>Onset</label>
              <input
                id={`${idPrefix}-onset`}
                type="date"
                max={istToday()}
                value={onsetDate}
                onChange={(event) => setOnsetDate(event.target.value)}
              />
            </div>
          </div>

          <div className="field">
            <label htmlFor={`${idPrefix}-note`}>Note</label>
            <input
              id={`${idPrefix}-note`}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </div>

          <label className="checkbox">
            <input
              type="checkbox"
              checked={isPrimary}
              onChange={(event) => setIsPrimary(event.target.checked)}
            />
            Primary diagnosis of this encounter
          </label>

          {correcting ? (
            <div className="field">
              <label htmlFor={`${idPrefix}-reason`}>Why is this being corrected?</label>
              <input
                id={`${idPrefix}-reason`}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Required. Kept in the diagnosis history."
              />
            </div>
          ) : null}

          <div className="row">
            <button
              type="button"
              onClick={() => void submit()}
              disabled={pending || (correcting ? reason.trim().length < 3 : !attribution.ready)}
            >
              {pending ? 'Saving…' : correcting ? 'Save correction' : 'Record diagnosis'}
            </button>
            <button type="button" className="ghost" onClick={correcting ? onDone : reset}>
              {correcting ? 'Cancel' : 'Choose a different term'}
            </button>
          </div>
        </>
      ) : correcting ? (
        <div className="row">
          <button type="button" className="ghost" onClick={onDone}>
            Cancel
          </button>
        </div>
      ) : null}
    </div>
  );
}
