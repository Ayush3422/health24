/**
 * What may not reach a log (sp7-plan.md, T5, DF4).
 *
 * A log aggregator is a second copy of the patient record if nobody stops it
 * being one — and it is a copy with none of the record's protections: no
 * row-level security, no consent, no audit trail of who read it, and a
 * retention nobody thought about. So the rule is narrow and absolute: **logs
 * carry identifiers, never people.**
 *
 * An identifier — a UUID, a hospital id, a route, a status — says which row to
 * go and read under the controls that exist. A name, a phone number, an MRN or
 * a line of clinical text says what is in the row, which is the thing the
 * controls are there to protect.
 *
 * Two layers, because either alone leaks:
 *
 * 1. **By key.** Anything under a key that names a person or holds free text
 *    is replaced outright, whatever it contains.
 * 2. **By shape.** Every string is scanned for the patterns that identify a
 *    person in India — a mobile number, an email address, an MRN, an Aadhaar
 *    or ABHA number — because the leak that actually happens is a message
 *    somebody interpolated a value into, not a field somebody named `name`.
 */

export const REDACTED = '[redacted]';

/**
 * Keys whose value is never logged, matched case-insensitively and ignoring
 * `_` and `-`, so `patient_name`, `patientName` and `PATIENT-NAME` are one key.
 *
 * Deliberately broad on free text: a note, a reason, a complaint or a display
 * term is clinical content, and there is no version of it that belongs in an
 * operational log.
 */
const REDACTED_KEYS = new Set(
  [
    // Who the person is
    'name',
    'patientname',
    'fullname',
    'givenname',
    'familyname',
    'guardianname',
    'phone',
    'phonenumber',
    'mobile',
    'contactphone',
    'email',
    'contactemail',
    'address',
    'dateofbirth',
    'dob',
    'birthdate',
    'gender',
    'bloodgroup',
    'aadhaar',
    'abha',
    'abhaaddress',
    'mrn',
    // What is wrong with them
    'display',
    'term',
    'diagnosis',
    'chiefcomplaint',
    'complaint',
    'note',
    'notes',
    'clinicalnote',
    'reason',
    'statusreason',
    'medicinename',
    'substance',
    'reaction',
    'title',
    'text',
    'sections',
    'contents',
    'operativenote',
    'preopassessment',
    'postopcourse',
    'outcome',
    'filename',
    'comment',
    // Credentials, which are nobody's business either
    'password',
    'token',
    'accesstoken',
    'refreshtoken',
    'challengetoken',
    'selectiontoken',
    'secret',
    'totpsecret',
    'code',
    'otp',
    'authorization',
    'cookie',
    'setcookie',
  ].map((key) => key.toLowerCase()),
);

/** Patterns that identify a person wherever they appear, including in prose. */
const PATTERNS: Array<[RegExp, string]> = [
  // An Indian mobile number, with or without +91 and separators.
  [/(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}\b/g, REDACTED],
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, REDACTED],
  // An MRN: the hospital's prefix, a hyphen, and the serial.
  [/\b[A-Z]{2,6}-\d{4,}\b/g, REDACTED],
  // Aadhaar (12 digits) and an ABHA number (14), grouped or not.
  [/\b\d{4}[\s-]?\d{4}[\s-]?\d{4}([\s-]?\d{2})?\b/g, REDACTED],
];

const MAX_DEPTH = 6;
const MAX_ARRAY = 50;
const MAX_STRING = 2_000;

const normaliseKey = (key: string): string => key.toLowerCase().replace(/[_-]/g, '');

/** A string with anything that identifies a person taken out of it. */
export function scrubText(value: string): string {
  const capped = value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;

  return PATTERNS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), capped);
}

/**
 * Anything at all, with nothing in it that names a person.
 *
 * Structure is kept — a log line is still worth reading — and only the values
 * that could identify somebody are replaced. UUIDs, numbers, booleans, routes
 * and status codes pass through untouched, which is what makes the line useful
 * for finding the row under the controls that protect it.
 */
export function scrub(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') return scrubText(value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value;
  }

  if (value instanceof Date) return value.toISOString();

  if (value instanceof Error) {
    return {
      name: value.name,
      message: scrubText(value.message),
      // The stack names our files, not the patient's data — but the message is
      // often interpolated into the first line, so it goes through the same
      // scrub.
      stack: value.stack ? scrubText(value.stack) : undefined,
    };
  }

  if (depth >= MAX_DEPTH) return '[too deep]';

  if (Array.isArray(value)) {
    const kept = value.slice(0, MAX_ARRAY).map((entry) => scrub(entry, depth + 1));
    return value.length > MAX_ARRAY ? [...kept, `[+${value.length - MAX_ARRAY} more]`] : kept;
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};

    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = REDACTED_KEYS.has(normaliseKey(key)) ? REDACTED : scrub(entry, depth + 1);
    }

    return out;
  }

  // Functions, symbols: nothing a log needs.
  return undefined;
}

/** True when a line, as it would be written, still holds something it should not. */
export function looksLikePersonalData(line: string): boolean {
  return PATTERNS.some(([pattern]) => {
    pattern.lastIndex = 0;
    return pattern.test(line);
  });
}
