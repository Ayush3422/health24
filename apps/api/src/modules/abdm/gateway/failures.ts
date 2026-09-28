import { GatewayTimeoutException, HttpException, HttpStatus } from '@nestjs/common';
import { GatewayRefusedError, GatewayTimeoutError } from './correlation';

/**
 * The gateway's failures, as this system's answers (sp8-plan.md, T6).
 *
 * This lived inside the ABHA adapter until linking became the second caller
 * and every refusal it made — a wrong code, an expired request — arrived as a
 * 500. The translation is not the business of whichever flow happens to call
 * first, so it lives here, and a third caller gets it by using this rather
 * than by remembering to.
 *
 * The distinction it draws is the one a person at a desk needs:
 *
 * - a **refusal** is the registry's judgement about what was sent, and
 *   belongs in front of whoever sent it;
 * - a **timeout** is nobody's fault, and 504 says so rather than blaming the
 *   request — with the one thing the caller most needs to know, which is that
 *   nothing was recorded.
 */
export async function throughGateway<T>(call: () => Promise<T>): Promise<T> {
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
