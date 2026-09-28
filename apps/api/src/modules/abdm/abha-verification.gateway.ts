import { Injectable } from '@nestjs/common';
import { throughGateway } from './gateway/failures';
import { GatewayClient } from './gateway/gateway.client';
import type {
  AbhaVerifyConfirmResult,
  AbhaVerifyInitResult,
} from './gateway/operations';
import type {
  AbdmMode,
  AbhaChallengeIssued,
  AbhaChallengeRequest,
  AbhaConfirmation,
  AbhaVerificationPort,
} from './abha-verification.port';

/**
 * ABHA verification over the wire (sp8-plan.md, T6).
 *
 * Thin on purpose: the correlation, the session and the headers are the
 * client's, and what is left here is the translation between this system's
 * words and ABDM's — plus turning the gateway's failures into answers a
 * person at a desk can act on, which is the part a caller must not be left to
 * guess at.
 */
@Injectable()
export class GatewayAbhaVerification implements AbhaVerificationPort {
  readonly mode: AbdmMode = 'gateway';

  constructor(private readonly client: GatewayClient) {}

  async requestChallenge(request: AbhaChallengeRequest): Promise<AbhaChallengeIssued> {
    const result = await throughGateway(() =>
      this.client.call<AbhaVerifyInitResult>('abha.verify.init', {
        abhaNumber: request.abhaNumber,
        abhaAddress: request.abhaAddress,
        method: request.method,
      }),
    );

    return {
      transactionId: result.transactionId,
      sentTo: result.sentTo ?? null,
      expiresAt: new Date(Date.now() + (result.expiresInSeconds ?? 300) * 1_000),
    };
  }

  async confirmChallenge(transactionId: string, code: string): Promise<AbhaConfirmation> {
    const result = await throughGateway(() =>
      this.client.call<AbhaVerifyConfirmResult>('abha.verify.confirm', { transactionId, code }),
    );

    return {
      abhaNumber: result.abhaNumber ?? null,
      abhaAddress: result.abhaAddress ?? null,
      method: result.method,
    };
  }

}
