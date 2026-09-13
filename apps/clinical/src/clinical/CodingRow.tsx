import type { Coding } from '@health24/shared';
import { EQUIVALENCE_LABELS } from '../api/terminology';

/**
 * One coding on a diagnosis: the clinician's selection, its translation, or
 * an advisory correspondence. The advisory row is styled apart wherever it
 * appears, and says in words that it is not a diagnosis.
 */
export function CodingRow({
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
