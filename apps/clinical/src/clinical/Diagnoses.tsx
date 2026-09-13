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
import { useAutoCode, useCodeSystems, useTerminologySearch } from '../api/terminology';
import { ClinicianPicker, useAttribution } from './attribution';
import { CodingRow } from './CodingRow';
import { formatDate, humanise, istToday, optionalText } from './format';
import { Provenance } from './Provenance';
import { useDebouncedValue } from './useDebouncedValue';

const systemLabel = (key: string): string => CODE_SYSTEM_LABELS[key] ?? key;

/**
 * Diagnoses as recorded: the clinician's selection, the TM2 translation and
 * any advisory biomedical code, exactly as they were attached at the time.
 * `compact` is for the problem list, where one line per coding is enough.
 */
export function DiagnosisList({
  conditions,
  compact = false,
  emptyText,
}: {
  conditions: ConditionSummary[];
  compact?: boolean;
  emptyText: string;
}): JSX.Element {
  if (conditions.length === 0) {
    return <p className="muted">{emptyText}</p>;
  }

  return (
    <ul className="entries">
      {conditions.map((condition) => {
        const { primary, translated, advisory } = condition.codings;

        return (
          <li key={condition.id} className="entry">
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
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Recording a diagnosis: search in the clinician's own vocabulary, see what
 * will be attached, then record. The preview is the same auto-coding the
 * server performs, so what the clinician sees before saving is what is saved.
 */
export function DiagnosisEntry({
  encounter,
  hasPrimary,
}: {
  encounter: EncounterSummary;
  hasPrimary: boolean;
}): JSX.Element {
  const systems = useCodeSystems();
  const activeSystems = (systems.data ?? []).filter((system) => system.status === 'active');
  const record = useRecordDiagnosis();
  const attribution = useAttribution(encounter.attending.id);

  const [systemKey, setSystemKey] = useState<string>(TERMINOLOGY_KEYS.namaste);
  const [term, setTerm] = useState('');
  const [selected, setSelected] = useState<ConceptSummary | null>(null);
  const [isPrimary, setIsPrimary] = useState(!hasPrimary);
  const [clinicalStatus, setClinicalStatus] =
    useState<(typeof CONDITION_CLINICAL_STATUSES)[number]>('active');
  const [verificationStatus, setVerificationStatus] =
    useState<(typeof CONDITION_VERIFICATION_STATUSES)[number]>('confirmed');
  const [onsetDate, setOnsetDate] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [recorded, setRecorded] = useState<{ name: string; notes: string[] } | null>(null);

  const debouncedTerm = useDebouncedValue(term, 250);
  const search = useTerminologySearch(systemKey, debouncedTerm);
  const results = debouncedTerm.trim() && !selected ? (search.data ?? []) : [];
  const preview = useAutoCode(systemKey, selected?.code ?? null, Boolean(selected));
  const system = activeSystems.find((entry) => entry.key === systemKey);

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

    try {
      const result = await record.mutateAsync({
        encounterId: encounter.id,
        system: systemKey,
        code: selected.code,
        isPrimary,
        clinicalStatus,
        verificationStatus,
        onsetDate: onsetDate || undefined,
        note: optionalText(note),
        ...attribution.body,
      });

      setRecorded({ name: result.codings.primary.display, notes: result.codingNotes });
      reset();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not record the diagnosis');
    }
  };

  return (
    <div className="form card">
      <h3>Add a diagnosis</h3>

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

      <ClinicianPicker attribution={attribution} id="diagnosis-clinician" />

      <div className="form-grid form-grid--search">
        <div className="field">
          <label htmlFor="diagnosis-system">Vocabulary</label>
          <select
            id="diagnosis-system"
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
          <label htmlFor="diagnosis-search">Search</label>
          <input
            id="diagnosis-search"
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
              <label htmlFor="diagnosis-status">Status</label>
              <select
                id="diagnosis-status"
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
              <label htmlFor="diagnosis-verification">Certainty</label>
              <select
                id="diagnosis-verification"
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
              <label htmlFor="diagnosis-onset">Onset</label>
              <input
                id="diagnosis-onset"
                type="date"
                max={istToday()}
                value={onsetDate}
                onChange={(event) => setOnsetDate(event.target.value)}
              />
            </div>
          </div>

          <div className="field">
            <label htmlFor="diagnosis-note">Note</label>
            <input
              id="diagnosis-note"
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

          <div className="row">
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!attribution.ready || record.isPending}
            >
              {record.isPending ? 'Recording…' : 'Record diagnosis'}
            </button>
            <button type="button" className="ghost" onClick={reset}>
              Choose a different term
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}
