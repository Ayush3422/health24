import { timingSafeEqual } from 'node:crypto';
import type { GatewayCallback } from './operations';

/**
 * Proving that a request claiming to be the gateway is one
 * (sp8-plan.md, T8).
 *
 * This endpoint is reachable from outside and is answered on behalf of the
 * national registry, so the honest question is not "how do we authenticate
 * it" but "what does the specification actually give us to authenticate it
 * with". The answer is less than one would like, so this is three checks and
 * a written account of what each is worth:
 *
 * 1. **A shared secret**, compared in constant time. Required in production.
 *    Where the gateway cannot be configured to send one, this degrades to the
 *    two checks below — and `docs/abdm.md` says so rather than implying a
 *    boundary that is not there.
 *
 * 2. **A correlation id we issued and are still waiting on.** This is the
 *    strongest of the three and the one that needs nothing from ABDM: an
 *    answer to a question nobody asked is refused, so a caller who reaches
 *    this URL cannot inject an outcome — only answer a call we made, within
 *    the seconds we are waiting.
 *
 * 3. **A timestamp within the skew window.** A captured callback replayed
 *    later is refused, and check 2 has usually already forgotten it.
 *
 * What none of them establishes is the **content** of a consent artefact.
 * That rests on the artefact's own signature, which is Phase 4's problem and
 * is deliberately not pretended at here.
 */

export type CallbackRefusal =
  | 'no-secret-configured'
  | 'wrong-secret'
  | 'no-correlation'
  | 'unknown-correlation'
  | 'stale-timestamp';

export interface CallbackCheck {
  /** The secret the deployment expects, or null when none is configured. */
  expectedSecret: string | null;
  /** Whether a missing secret is fatal. True in production. */
  secretRequired: boolean;
  maxSkewMs: number;
  isWaitingFor: (requestId: string) => boolean;
  now?: number;
}

/** Constant time, and false rather than throwing on a length mismatch. */
function secretMatches(expected: string, given: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(given);

  if (a.length !== b.length) return false;

  return timingSafeEqual(a, b);
}

/**
 * Null when the callback may be processed, or the reason it may not.
 *
 * A single function rather than a guard so that it can be tested without an
 * HTTP request, and so the order of the checks is visible in one place.
 */
export function refuseCallback(
  body: GatewayCallback,
  header: string | undefined,
  check: CallbackCheck,
): CallbackRefusal | null {
  if (check.expectedSecret) {
    if (!header || !secretMatches(check.expectedSecret, header)) return 'wrong-secret';
  } else if (check.secretRequired) {
    return 'no-secret-configured';
  }

  const correlation = body.resp?.requestId;
  if (!correlation) return 'no-correlation';
  if (!check.isWaitingFor(correlation)) return 'unknown-correlation';

  const at = Date.parse(body.timestamp ?? '');
  const now = check.now ?? Date.now();

  // Skew in both directions: a clock ahead of ours is as ordinary as one
  // behind, and refusing only one of them would be arbitrary.
  if (!Number.isFinite(at) || Math.abs(now - at) > check.maxSkewMs) return 'stale-timestamp';

  return null;
}

/** What to tell the caller. Never which check failed. */
export const CALLBACK_REFUSED = 'This callback was not accepted.';
