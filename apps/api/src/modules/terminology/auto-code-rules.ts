import {
  TERMINOLOGY_KEYS,
  type AutoCodeResult,
  type Coding,
  type MapElementStatus,
  type MapEquivalence,
} from '@health24/shared';

/**
 * The auto-coding rules, as a pure function.
 *
 * Separated from the service that fetches mappings so that the rules — which
 * decide what gets attached to a patient's diagnosis — can be tested
 * exhaustively without a database. From planning.md §7.4:
 *
 *   - The clinician's own selection is the primary coding.
 *   - The TM2 translation is attached from an approved mapping, with its
 *     equivalence recorded.
 *   - A biomedical code is attached only as advisory, and only when the
 *     correspondence is equivalent or wider. A narrower or inexact
 *     correspondence is not suggested at all.
 *   - Only approved mappings are ever attached. Proposed, rejected and retired
 *     ones are not, however plausible.
 *   - Unmapped is a normal outcome, explained in a note, never an error.
 */

export interface CandidateMapping {
  elementId: string;
  status: MapElementStatus;
  equivalence: MapEquivalence;
  confidence: number | null;
  targetKey: string;
  targetVersion: string;
  /** Null exactly when the equivalence is `unmatched`. */
  targetCode: string | null;
  targetDisplay: string | null;
  /** True when the map or its target system is demo data. */
  experimental: boolean;
}

const EQUIVALENCE_STRENGTH: Record<MapEquivalence, number> = {
  equivalent: 0,
  wider: 1,
  narrower: 2,
  inexact: 3,
  unmatched: 4,
};

/**
 * Strongest correspondence first, then highest confidence, then code — the
 * last so the choice is deterministic rather than dependent on row order.
 */
export function byStrength(a: CandidateMapping, b: CandidateMapping): number {
  const strength = EQUIVALENCE_STRENGTH[a.equivalence] - EQUIVALENCE_STRENGTH[b.equivalence];
  if (strength !== 0) return strength;

  const confidence = (b.confidence ?? -1) - (a.confidence ?? -1);
  if (confidence !== 0) return confidence;

  return (a.targetCode ?? '').localeCompare(b.targetCode ?? '');
}

function toCoding(mapping: CandidateMapping, role: 'translated' | 'advisory'): Coding {
  return {
    system: mapping.targetKey,
    systemVersion: mapping.targetVersion,
    code: mapping.targetCode as string,
    display: mapping.targetDisplay ?? (mapping.targetCode as string),
    role,
    equivalence: mapping.equivalence,
    confidence: mapping.confidence,
    conceptMapElementId: mapping.elementId,
  };
}

export function decideAutoCode(input: {
  primary: Coding;
  primaryExperimental: boolean;
  mappings: readonly CandidateMapping[];
}): AutoCodeResult {
  const notes: string[] = [];

  // --- TM2: the authoritative translation ---------------------------------
  const tm2 = input.mappings.filter((mapping) => mapping.targetKey === TERMINOLOGY_KEYS.tm2);
  const tm2Approved = tm2.filter((mapping) => mapping.status === 'approved').sort(byStrength);
  const tm2Matched = tm2Approved.filter((mapping) => mapping.equivalence !== 'unmatched');

  let translated: Coding | null = null;

  if (tm2Matched.length > 0) {
    const chosen = tm2Matched[0] as CandidateMapping;
    translated = toCoding(chosen, 'translated');

    if (chosen.equivalence !== 'equivalent') {
      notes.push(
        `The TM2 correspondence is ${chosen.equivalence}, not equivalent. It is attached with that qualification recorded.`,
      );
    }

    if (tm2Matched.length > 1) {
      notes.push(
        `${tm2Matched.length - 1} further approved TM2 correspondence(s) exist; the strongest was attached.`,
      );
    }
  } else if (tm2Approved.length > 0) {
    notes.push('Reviewed: this code has no TM2 correspondence.');
  } else if (tm2.some((mapping) => mapping.status === 'proposed')) {
    notes.push('A TM2 mapping for this code is awaiting curator review and is not attached.');
  } else {
    notes.push('No reviewed TM2 mapping exists for this code yet.');
  }

  // --- Biomedical: advisory only, and only when strong enough -------------
  const mms = input.mappings.filter((mapping) => mapping.targetKey === TERMINOLOGY_KEYS.mms);
  const mmsApproved = mms.filter((mapping) => mapping.status === 'approved').sort(byStrength);
  const attachable = mmsApproved.find(
    (mapping) => mapping.equivalence === 'equivalent' || mapping.equivalence === 'wider',
  );

  let advisory: Coding | null = null;

  if (attachable) {
    advisory = toCoding(attachable, 'advisory');
    notes.push('The biomedical code is advisory: a suggested correspondence, not a diagnosis.');
  } else {
    const weaker = mmsApproved.find(
      (mapping) => mapping.equivalence === 'narrower' || mapping.equivalence === 'inexact',
    );

    if (weaker) {
      notes.push(
        `An approved biomedical correspondence exists but is ${weaker.equivalence}. Only equivalent or wider correspondences are suggested, so none is attached.`,
      );
    } else if (mmsApproved.length > 0) {
      notes.push('Reviewed: this code has no biomedical correspondence.');
    } else if (mms.some((mapping) => mapping.status === 'proposed')) {
      notes.push(
        'A biomedical mapping for this code is awaiting curator review and is not attached.',
      );
    } else {
      notes.push('No reviewed biomedical mapping exists for this code yet.');
    }
  }

  const involved = [translated, advisory]
    .filter((coding): coding is Coding => coding !== null)
    .map((coding) =>
      input.mappings.find((mapping) => mapping.elementId === coding.conceptMapElementId),
    );

  if (input.primaryExperimental || involved.some((mapping) => mapping?.experimental)) {
    notes.unshift('Demo terminology — not for use on a real patient record.');
  }

  return { primary: input.primary, translated, advisory, notes };
}
