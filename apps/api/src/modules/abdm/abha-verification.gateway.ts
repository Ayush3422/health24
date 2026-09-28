import { GatewayTimeoutException, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { GatewayRefusedError, GatewayTimeoutError } from './gateway/correlation';
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
    const result = await this.translate(() =>
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
    const result = await this.translate(() =>
      this.client.call<AbhaVerifyConfirmResult>('abha.verify.confirm', { transactionId, code }),
    );

    return {
      abhaNumber: result.abhaNumber ?? null,
      abhaAddress: result.abhaAddress ?? null,
      method: result.method,
    };
  }

  /**
   * The gateway's failures, as this system's answers.
   *
   * A refusal is the registry's judgement — a wrong code, an expired
   * transaction — and belongs in front of the person who typed it. A timeout
   * is not: nobody did anything wrong, and 504 says so rather than blaming
   * the request.
   */
  private async translate<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof GatewayTimeoutError) {
        throw new GatewayTimeoutException(
          'The national registry did not answer in time. Nothing was recorded; try again.',
        );
      }

      if (error instanceof GatewayRefusedError) {
        throw new HttpException(error.message, HttpStatus.UNAUTHORIZED);
      }

      throw error;
    }
  }
}
