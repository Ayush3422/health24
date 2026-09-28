import type { AbhaVerificationMethod } from '@health24/shared';

/**
 * The one thing outside this folder that knows an ABHA can be confirmed
 * (sp8-plan.md, T5, DF4).
 *
 * Everything above this interface deals in this system's own types. What is
 * behind it in Phase 1 is a local mock (Decision Z1); what is behind it in
 * Phase 2 is the national gateway, with its sessions, correlation ids and
 * callbacks. Nothing above has to change when that happens, which is the
 * whole point of writing it down now rather than later.
 */

export const ABHA_VERIFICATION = Symbol('ABHA_VERIFICATION');

/** How this system is configured to reach ABDM. */
export type AbdmMode = 'off' | 'mock';

export interface AbhaChallengeRequest {
  /** One of the two is present; the address is the one a patient knows. */
  abhaNumber: string | null;
  abhaAddress: string | null;
  method: AbhaVerificationMethod;
}

export interface AbhaChallengeIssued {
  /** The gateway's handle for this challenge. Opaque above this interface. */
  transactionId: string;
  /** Where the code went, already masked by whoever sent it. */
  sentTo: string | null;
  expiresAt: Date;
}

/**
 * What the registry confirmed.
 *
 * Both identifiers are returned because the gateway resolves one from the
 * other, and a verification that started from an address can therefore also
 * establish the number. In Phase 1 the mock confirms only what it was given.
 */
export interface AbhaConfirmation {
  abhaNumber: string | null;
  abhaAddress: string | null;
  /**
   * How the patient answered. It comes back from the registry rather than
   * being remembered by the caller, so that what is recorded on the record is
   * the method that was actually used and not the one that was asked for.
   */
  method: AbhaVerificationMethod;
}

export interface AbhaVerificationPort {
  readonly mode: AbdmMode;

  /** Asks for a code to be sent to whatever the method names. */
  requestChallenge(request: AbhaChallengeRequest): Promise<AbhaChallengeIssued>;

  /**
   * Answers a challenge. Rejects a wrong, stale or exhausted code — the
   * refusal is the gateway's, not this system's, and it is surfaced as one.
   */
  confirmChallenge(transactionId: string, code: string): Promise<AbhaConfirmation>;
}
