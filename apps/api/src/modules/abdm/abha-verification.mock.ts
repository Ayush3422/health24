import { randomUUID } from 'node:crypto';
import { HttpException, HttpStatus, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { AbhaVerificationMethod } from '@health24/shared';
import type {
  AbdmMode,
  AbhaChallengeIssued,
  AbhaChallengeRequest,
  AbhaConfirmation,
  AbhaVerificationPort,
} from './abha-verification.port';

/**
 * A stand-in for the national gateway (sp8-plan.md, T7, Decision Z1).
 *
 * It exists so that the flow above it can be built and tested before there
 * are sandbox credentials, and so that the test suite never needs a secret
 * (DF9). It is refused in production by the configuration schema, because a
 * gateway that accepts a well-known code is a way to mark any ABHA verified
 * without the patient being there.
 *
 * It is deliberately not generous. It expires challenges, counts attempts and
 * refuses a reused transaction, because a mock that says yes to everything
 * teaches the code above it to handle nothing.
 */

/** The code the mock accepts. Published, because it protects nothing. */
export const MOCK_ABHA_CODE = '000000';

const TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;

interface Challenge {
  abhaNumber: string | null;
  abhaAddress: string | null;
  method: AbhaVerificationMethod;
  expiresAt: number;
  attempts: number;
}

@Injectable()
export class MockAbhaVerification implements AbhaVerificationPort {
  readonly mode: AbdmMode = 'mock';

  /**
   * In memory, and only here. The real gateway holds this state; when the
   * adapter in Phase 2 replaces this class, nothing in the service above it
   * gains a dependency on where a challenge lives.
   */
  private readonly challenges = new Map<string, Challenge>();

  requestChallenge(request: AbhaChallengeRequest): Promise<AbhaChallengeIssued> {
    this.forgetExpired();

    const transactionId = randomUUID();
    const expiresAt = Date.now() + TTL_MS;

    this.challenges.set(transactionId, {
      abhaNumber: request.abhaNumber,
      abhaAddress: request.abhaAddress,
      method: request.method,
      expiresAt,
      attempts: 0,
    });

    return Promise.resolve({
      transactionId,
      // The gateway returns the patient's own mobile, masked by ABDM. The
      // mock has never seen it and does not invent one.
      sentTo: null,
      expiresAt: new Date(expiresAt),
    });
  }

  confirmChallenge(transactionId: string, code: string): Promise<AbhaConfirmation> {
    const challenge = this.challenges.get(transactionId);

    if (!challenge || challenge.expiresAt < Date.now()) {
      this.challenges.delete(transactionId);
      throw new HttpException(
        'That verification has expired. Ask for a new code.',
        HttpStatus.GONE,
      );
    }

    challenge.attempts += 1;

    if (challenge.attempts > MAX_ATTEMPTS) {
      this.challenges.delete(transactionId);
      throw new HttpException(
        'Too many attempts on that code. Ask for a new one.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    if (code !== MOCK_ABHA_CODE) {
      throw new HttpException('That code is not correct.', HttpStatus.UNAUTHORIZED);
    }

    // Answered once. A transaction is not a password that keeps working.
    this.challenges.delete(transactionId);

    return Promise.resolve({
      abhaNumber: challenge.abhaNumber,
      abhaAddress: challenge.abhaAddress,
      method: challenge.method,
    });
  }

  private forgetExpired(): void {
    const now = Date.now();

    for (const [id, challenge] of this.challenges) {
      if (challenge.expiresAt < now) this.challenges.delete(id);
    }
  }
}

/**
 * What is behind the interface when ABDM is switched off.
 *
 * It refuses rather than pretending, and the message says which setting to
 * change — an operator reading "ABHA verification is unavailable" learns
 * nothing.
 */
@Injectable()
export class DisabledAbhaVerification implements AbhaVerificationPort {
  readonly mode: AbdmMode = 'off';

  requestChallenge(): Promise<AbhaChallengeIssued> {
    throw new ServiceUnavailableException(
      'ABDM is switched off on this deployment (ABDM_MODE). ABHA cannot be verified.',
    );
  }

  confirmChallenge(): Promise<AbhaConfirmation> {
    throw new ServiceUnavailableException(
      'ABDM is switched off on this deployment (ABDM_MODE). ABHA cannot be verified.',
    );
  }
}
