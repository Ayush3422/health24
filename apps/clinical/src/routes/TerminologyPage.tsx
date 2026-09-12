import { useEffect, useState, type KeyboardEvent } from 'react';
import { TERMINOLOGY_KEYS, type Coding } from '@health24/shared';
import { ApiError } from '../api/client';
import {
  EQUIVALENCE_LABELS,
  useAutoCode,
  useCodeSystems,
  useConcept,
  useTerminologySearch,
} from '../api/terminology';

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}

const errorMessage = (error: unknown): string =>
  error instanceof ApiError ? error.message : 'Something went wrong';

/**
 * Terminology search and browse.
 *
 * Built for the way the search is actually used — as autocomplete while a
 * clinician types — so it is keyboard-driven: arrows move through results and
 * Enter opens one, without reaching for the mouse mid-consultation.
 *
 * For a NAMASTE term it also shows exactly what a diagnosis coded with that
 * term would record: the clinician's selection, the TM2 translation, and any
 * advisory biomedical code, with the reasons for anything left out.
 */
export function TerminologyPage(): JSX.Element {
  const systems = useCodeSystems();
  const activeSystems = (systems.data ?? []).filter((system) => system.status === 'active');

  const [systemKey, setSystemKey] = useState<string>(TERMINOLOGY_KEYS.namaste);
  const [term, setTerm] = useState('');
  const [highlight, setHighlight] = useState(0);
  const [selectedCode, setSelectedCode] = useState<string | null>(null);

  const debouncedTerm = useDebouncedValue(term, 200);
  const search = useTerminologySearch(systemKey, debouncedTerm);
  const results = debouncedTerm.trim() ? (search.data ?? []) : [];
  const system = activeSystems.find((entry) => entry.key === systemKey);

  useEffect(() => {
    setHighlight(0);
  }, [debouncedTerm, systemKey]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (results.length === 0) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlight((index) => Math.min(index + 1, results.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlight((index) => Math.max(index - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const result = results[highlight];
      if (result) setSelectedCode(result.code);
    }
  };

  return (
    <div className="page page--wide">
      <h1>Terminology</h1>
      <p className="muted">
        Search in any script. अम्लपित्त, amlapitta and Amlapitta all find the same term, and a typo
        still gets close.
      </p>

      <div className="terminology">
        <section>
          <div className="terminology__controls">
            <select
              aria-label="Code system"
              value={systemKey}
              onChange={(event) => {
                setSystemKey(event.target.value);
                setSelectedCode(null);
              }}
            >
              {activeSystems.length === 0 ? (
                <option value={TERMINOLOGY_KEYS.namaste}>
                  {systems.isPending ? 'Loading…' : 'No active terminology'}
                </option>
              ) : (
                activeSystems.map((entry) => (
                  <option key={entry.key} value={entry.key}>
                    {entry.name}
                  </option>
                ))
              )}
            </select>
          </div>

          {system?.experimental ? (
            <p className="demo-banner" role="note">
              Demo terminology: synthetic codes, not for use on a real patient record.
            </p>
          ) : null}

          <input
            className="search"
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Type a term, in any script"
            aria-label="Search terminology"
            aria-describedby="terminology-hint"
            autoFocus
          />
          <p id="terminology-hint" className="muted small">
            ↑ ↓ to move, Enter to open.
          </p>

          {search.isError ? (
            <p className="alert alert--error">{errorMessage(search.error)}</p>
          ) : null}

          {debouncedTerm.trim() && search.isSuccess && results.length === 0 ? (
            <p className="muted">No terms match “{debouncedTerm}”.</p>
          ) : null}

          {results.length > 0 ? (
            <ul className="results" aria-label="Search results">
              {results.map((result, index) => (
                <li key={result.code}>
                  <button
                    type="button"
                    className={index === highlight ? 'is-highlighted' : undefined}
                    aria-current={result.code === selectedCode ? 'true' : undefined}
                    onClick={() => setSelectedCode(result.code)}
                    onMouseEnter={() => setHighlight(index)}
                  >
                    <strong>{result.display}</strong> <span className="code">{result.code}</span>
                    {result.designations.length > 0 ? (
                      <span className="result__names">
                        {result.designations.map((designation) => (
                          <span
                            key={`${designation.language}-${designation.value}`}
                            lang={designation.language === 'und' ? undefined : designation.language}
                          >
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
        </section>

        <section aria-live="polite">
          {selectedCode ? (
            <ConceptPanel systemKey={systemKey} code={selectedCode} onNavigate={setSelectedCode} />
          ) : (
            <div className="empty">
              <p>
                Select a term to see its details
                {systemKey === TERMINOLOGY_KEYS.namaste
                  ? ', and what a diagnosis coded with it would record.'
                  : '.'}
              </p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function ConceptPanel({
  systemKey,
  code,
  onNavigate,
}: {
  systemKey: string;
  code: string;
  onNavigate: (code: string) => void;
}): JSX.Element {
  const isNamaste = systemKey === TERMINOLOGY_KEYS.namaste;
  const detail = useConcept(systemKey, code);
  const autoCode = useAutoCode(systemKey, code, isNamaste);

  if (detail.isPending) return <div className="card">Loading…</div>;
  if (detail.isError) return <p className="alert alert--error">{errorMessage(detail.error)}</p>;

  const { concept, parent, children, codeSystem } = detail.data;

  return (
    <article className="card concept">
      <header>
        <h2>
          {concept.display} <span className="code">{concept.code}</span>
        </h2>
        <p className="muted small">
          {codeSystem.name} · version {codeSystem.version}
        </p>
      </header>

      {concept.designations.length > 0 ? (
        <p className="designations">
          {concept.designations.map((designation) => (
            <span
              key={`${designation.language}-${designation.value}`}
              lang={designation.language === 'und' ? undefined : designation.language}
            >
              {designation.value}
            </span>
          ))}
        </p>
      ) : null}

      {concept.definition ? <p>{concept.definition}</p> : null}

      {parent ? (
        <p className="small">
          <span className="muted">Part of </span>
          <button type="button" className="chip" onClick={() => onNavigate(parent.code)}>
            {parent.display}
          </button>
        </p>
      ) : null}

      {children.length > 0 ? (
        <div className="small">
          <span className="muted">Includes </span>
          <span className="chips">
            {children.map((child) => (
              <button
                key={child.code}
                type="button"
                className="chip"
                onClick={() => onNavigate(child.code)}
              >
                {child.display}
              </button>
            ))}
          </span>
        </div>
      ) : null}

      {isNamaste ? (
        <section className="auto-code">
          <h3>Recorded on a diagnosis coded with this term</h3>

          {autoCode.isPending ? (
            <p className="muted">Working out the codings…</p>
          ) : autoCode.isError ? (
            <p className="alert alert--error">{errorMessage(autoCode.error)}</p>
          ) : (
            <>
              <CodingRow label="Clinician’s selection · NAMASTE" coding={autoCode.data.primary} />
              <CodingRow
                label="Translation · ICD-11 TM2"
                coding={autoCode.data.translated}
                emptyText="Not attached"
              />
              <CodingRow
                label="Advisory · biomedical"
                coding={autoCode.data.advisory}
                emptyText="Not attached"
                advisory
              />
              {autoCode.data.notes.length > 0 ? (
                <ul className="notes">
                  {autoCode.data.notes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              ) : null}
            </>
          )}
        </section>
      ) : null}

      {codeSystem.attribution || codeSystem.licence ? (
        <footer className="attribution">
          {codeSystem.attribution}
          {codeSystem.licence ? (
            <>
              <br />
              {codeSystem.licence}
            </>
          ) : null}
        </footer>
      ) : null}
    </article>
  );
}

function CodingRow({
  label,
  coding,
  emptyText,
  advisory = false,
}: {
  label: string;
  coding: Coding | null;
  emptyText?: string;
  advisory?: boolean;
}): JSX.Element {
  const classes = ['coding', advisory ? 'coding--advisory' : '', coding ? '' : 'coding--empty']
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classes}>
      <div className="coding__label">{label}</div>

      {coding ? (
        <div>
          <strong>{coding.display}</strong> <span className="code">{coding.code}</span>
          {coding.equivalence ? (
            <span className={`equivalence equivalence--${coding.equivalence}`}>
              {EQUIVALENCE_LABELS[coding.equivalence]}
            </span>
          ) : null}
          {advisory ? (
            <div className="small">A suggested correspondence only. It is not a diagnosis.</div>
          ) : null}
        </div>
      ) : (
        <div>{emptyText}</div>
      )}
    </div>
  );
}
