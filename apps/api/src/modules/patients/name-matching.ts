/**
 * Patient identity matching.
 *
 * Pure functions, deliberately: this is the logic whose failure is worst in
 * the whole system. Merging two people's records because their names are
 * similar hands one patient's history to another, and a clinician acting on
 * it would be acting on fiction. So everything here is testable without a
 * database, and the thresholds are conservative by design — a missed match
 * costs a duplicate record and some reconciliation work, a false match can
 * cost someone their health.
 */

/**
 * Honorifics and relationship prefixes stripped before comparison.
 *
 * `b/o`, `s/o`, `d/o` and `w/o` — "baby of", "son of", "daughter of", "wife
 * of" — are extremely common on Indian hospital registers, particularly for
 * newborns who are registered before being named. Leaving them in makes two
 * records for the same infant look like different people, and makes two
 * unrelated newborns of mothers with similar names look like the same one.
 */
const TITLES = [
  'dr',
  'doctor',
  'mr',
  'mrs',
  'ms',
  'miss',
  'master',
  'mstr',
  'shri',
  'sri',
  'smt',
  'kumari',
  'km',
  'baby',
  'b/o',
  'bo',
  's/o',
  'so',
  'd/o',
  'do',
  'w/o',
  'wo',
  'c/o',
  'late',
  'prof',
];

const TITLE_PATTERN = new RegExp(
  `^(?:${TITLES.map((title) => title.replace(/\//g, '\\/')).join('|')})[.\\s]+`,
  'i',
);

/**
 * Reduces a name to a comparable form.
 *
 * Lowercases, strips diacritics, removes honorifics and punctuation, and
 * collapses whitespace. Devanagari, Tamil and other Indic scripts pass through
 * intact — they have no case and no Latin diacritics, and transliterating them
 * here would lose information that the trigram index uses well.
 *
 * The result is for matching only. It is never displayed: a patient's name is
 * shown exactly as it was recorded.
 */
export function normalizeName(raw: string): string {
  let value = raw
    .normalize('NFD')
    // Strip Latin combining marks only. Indic scripts use combining marks to
    // carry vowels, so removing theirs would corrupt the name.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();

  // Titles can stack: "dr. mrs. meera joshi".
  let previous: string;
  do {
    previous = value;
    value = value.replace(TITLE_PATTERN, '').trim();
  } while (value !== previous && value.length > 0);

  return value
    .replace(/[.,'"`_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Bigrams of a string, for the Dice coefficient. */
function bigrams(value: string): Map<string, number> {
  const counts = new Map<string, number>();

  for (let i = 0; i < value.length - 1; i += 1) {
    const pair = value.slice(i, i + 2);
    counts.set(pair, (counts.get(pair) ?? 0) + 1);
  }

  return counts;
}

/**
 * Similarity between two names, 0 to 1.
 *
 * Sørensen–Dice over character bigrams, applied both to the whole string and
 * to the set of name tokens, taking the better of the two. The token pass is
 * what makes "Meera Joshi" and "Joshi Meera" match: Indian records reverse
 * given and family names constantly, and a pure string comparison scores that
 * pair as though they were strangers.
 */
export function nameSimilarity(a: string, b: string): number {
  const left = normalizeName(a);
  const right = normalizeName(b);

  if (!left || !right) return 0;
  if (left === right) return 1;

  return Math.max(diceCoefficient(left, right), tokenSetSimilarity(left, right));
}

function diceCoefficient(left: string, right: string): number {
  if (left.length < 2 || right.length < 2) {
    return left === right ? 1 : 0;
  }

  const leftGrams = bigrams(left);
  const rightGrams = bigrams(right);

  let shared = 0;
  let leftTotal = 0;
  let rightTotal = 0;

  for (const count of leftGrams.values()) leftTotal += count;
  for (const count of rightGrams.values()) rightTotal += count;

  for (const [gram, count] of leftGrams) {
    const other = rightGrams.get(gram);
    if (other) shared += Math.min(count, other);
  }

  return (2 * shared) / (leftTotal + rightTotal);
}

/**
 * Compares names as unordered sets of tokens, tolerating reordering and
 * treating a single initial as matching the word it abbreviates ("A. Nair"
 * against "Arun Nair").
 */
function tokenSetSimilarity(left: string, right: string): number {
  const leftTokens = left.split(' ').filter(Boolean);
  const rightTokens = right.split(' ').filter(Boolean);

  if (leftTokens.length === 0 || rightTokens.length === 0) return 0;

  const unmatched = [...rightTokens];
  let score = 0;

  for (const token of leftTokens) {
    let bestIndex = -1;
    let best = 0;

    unmatched.forEach((candidate, index) => {
      const value = tokenScore(token, candidate);
      if (value > best) {
        best = value;
        bestIndex = index;
      }
    });

    if (bestIndex >= 0 && best > 0) {
      score += best;
      unmatched.splice(bestIndex, 1);
    }
  }

  // Normalised by the longer token list, so extra names on one side reduce
  // the score rather than being ignored.
  return score / Math.max(leftTokens.length, rightTokens.length);
}

function tokenScore(a: string, b: string): number {
  if (a === b) return 1;

  // An initial matching the start of a full name. Scored below an exact match
  // because "A. Nair" genuinely could be a different Nair.
  if ((a.length === 1 && b.startsWith(a)) || (b.length === 1 && a.startsWith(b))) {
    return 0.6;
  }

  return diceCoefficient(a, b);
}

/**
 * Derives a birth year from whichever of the two date fields was captured.
 *
 * Many patients do not know their date of birth, so age is recorded instead.
 * Reducing both to a year gives matching one number to compare, rather than
 * two mutually exclusive fields it has to reason about.
 */
export function deriveBirthYear(
  dateOfBirth: string | null | undefined,
  approximateAgeYears: number | null | undefined,
  now: Date = new Date(),
): number | null {
  if (dateOfBirth) {
    const year = Number(dateOfBirth.slice(0, 4));
    return Number.isFinite(year) ? year : null;
  }

  if (approximateAgeYears !== null && approximateAgeYears !== undefined) {
    return now.getFullYear() - approximateAgeYears;
  }

  return null;
}

export interface MatchableIdentity {
  name: string;
  gender?: string | null;
  phone?: string | null;
  abhaNumber?: string | null;
  birthYear?: number | null;
}

export interface MatchScore {
  score: number;
  matchedOn: string[];
  method: 'abha_exact' | 'probabilistic';
}

/**
 * Confidence at or above which two records are linked without asking a human.
 *
 * Reachable only with an exact phone match plus a strong name match plus an
 * agreeing birth year. Everything softer goes to review — see
 * `REVIEW_THRESHOLD`.
 */
export const AUTO_LINK_THRESHOLD = 0.92;

/** Below this, a pairing is not worth a human's attention. */
export const REVIEW_THRESHOLD = 0.55;

/**
 * Ceiling on a probabilistic score.
 *
 * A score of exactly 1 is reserved for an ABHA match, which is certainty: a
 * government-issued identifier shared by two records means one person. No
 * amount of agreeing name, phone, age and gender amounts to the same thing —
 * they are strong evidence, and strong evidence is not proof. Without this
 * cap the weights happen to sum to 1.0, and the two cases become
 * indistinguishable to anything reading the score.
 */
export const MAX_PROBABILISTIC_SCORE = 0.98;

/**
 * Scores two identities against each other.
 *
 * An ABHA match is decisive: it is a government-issued health identifier, and
 * two records carrying the same one are the same person by definition.
 *
 * Everything else is weighted evidence. Phone carries the most, because in
 * India a mobile number is close to a personal identifier — but not quite:
 * families share handsets, which is exactly why a phone match alone cannot
 * reach the auto-link threshold. A gender mismatch subtracts rather than
 * merely failing to add, because it is positive evidence of two different
 * people.
 */
export function scoreIdentities(left: MatchableIdentity, right: MatchableIdentity): MatchScore {
  if (left.abhaNumber && right.abhaNumber && left.abhaNumber === right.abhaNumber) {
    return { score: 1, matchedOn: ['abha_number'], method: 'abha_exact' };
  }

  const matchedOn: string[] = [];
  let score = 0;

  const similarity = nameSimilarity(left.name, right.name);

  if (similarity >= 0.85) {
    score += 0.4;
    matchedOn.push('name');
  } else if (similarity >= 0.6) {
    score += 0.4 * (similarity - 0.6) * 2.5;
    matchedOn.push('name_partial');
  }

  const phoneMatches = Boolean(left.phone && right.phone && left.phone === right.phone);

  if (phoneMatches) {
    score += 0.35;
    matchedOn.push('phone');
  }

  if (left.birthYear != null && right.birthYear != null) {
    const gap = Math.abs(left.birthYear - right.birthYear);

    if (gap === 0) {
      score += 0.18;
      matchedOn.push('birth_year');
    } else if (gap <= 2) {
      // Recorded ages drift; a two-year gap is weak agreement, not
      // disagreement.
      score += 0.07;
      matchedOn.push('birth_year_near');
    } else if (gap >= 8) {
      score -= 0.25;
    }
  }

  if (
    left.gender &&
    right.gender &&
    left.gender !== 'undisclosed' &&
    right.gender !== 'undisclosed'
  ) {
    if (left.gender === right.gender) {
      score += 0.07;
      matchedOn.push('gender');
    } else {
      score -= 0.3;
    }
  }

  // A strong name alone must never approach the auto-link threshold. Common
  // Indian names repeat constantly — there are a great many people called
  // Ramesh Kumar — so without a second corroborating identifier this is a
  // suggestion for a human, not a conclusion.
  if (!phoneMatches) {
    score = Math.min(score, 0.7);
  }

  return {
    score: Math.max(0, Math.min(MAX_PROBABILISTIC_SCORE, Number(score.toFixed(4)))),
    matchedOn,
    method: 'probabilistic',
  };
}

/** Masks a name for display in the review queue before a merge is approved. */
export function maskName(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) =>
      part.length <= 1 ? part : `${part[0]}${'•'.repeat(Math.min(part.length - 1, 6))}`,
    )
    .join(' ');
}

/** Masks a phone number, leaving enough for a human to recognise it. */
export function maskPhone(phone: string | null): string | null {
  if (!phone) return null;
  return phone.length <= 4 ? phone : `${'•'.repeat(6)}${phone.slice(-4)}`;
}
