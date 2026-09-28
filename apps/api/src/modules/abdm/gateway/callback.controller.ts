import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Public } from '../../../common/decorators';
import { AbdmConfig } from '../abdm.config';
import { CALLBACK_REFUSED, refuseCallback } from './callback-auth';
import { PendingRequests } from './correlation';
import type { GatewayCallback } from './operations';

/**
 * Where the gateway's answers arrive (sp8-plan.md, T6, T8).
 *
 * Public in the sense that no member of staff is signed in — and not public
 * in any other sense: `callback-auth.ts` decides whether the request may be
 * processed, and its second check is that the answer quotes a question this
 * process asked and is still waiting on.
 *
 * One route rather than one per operation. ABDM calls back to paths on a
 * registered bridge URL, and which path it used is data, not code: the
 * operation is in the URL, the correlation is in the body, and the waiting
 * caller is what knows how to read the payload.
 */
@Controller('abdm/callbacks')
export class GatewayCallbackController {
  private readonly logger = new Logger(GatewayCallbackController.name);

  constructor(
    private readonly config: AbdmConfig,
    private readonly pending: PendingRequests,
    private readonly env: ConfigService,
  ) {}

  @Public()
  @Post(':operation')
  @HttpCode(HttpStatus.ACCEPTED)
  receive(
    @Param('operation') operation: string,
    @Body() body: GatewayCallback,
    @Headers('x-abdm-callback-secret') secret?: string,
  ): { accepted: true } {
    const production = this.env.get<string>('NODE_ENV') === 'production';
    const settings = this.config.mode === 'gateway' ? this.config.gateway : null;

    const refusal = refuseCallback(body ?? {}, secret, {
      expectedSecret: settings?.callbackSecret ?? null,
      secretRequired: production,
      maxSkewMs: settings?.callbackSkewMs ?? 300_000,
      isWaitingFor: (requestId) => this.pending.isWaitingFor(requestId),
    });

    if (refusal) {
      // The reason is logged and not returned: telling a caller that their
      // correlation id was unknown tells them how to find one that is not.
      this.logger.warn(`Refused an ABDM callback for ${operation}: ${refusal}`);
      throw new UnauthorizedException(CALLBACK_REFUSED);
    }

    const correlation = body.resp!.requestId!;

    if (body.error) {
      this.pending.fail(
        correlation,
        body.error.message ?? 'The gateway refused the request',
        body.error.code,
      );
    } else {
      this.pending.settle(correlation, body.payload ?? {});
    }

    // 202 whatever the answer said. The gateway is being told that its
    // callback arrived, not what this system made of it.
    return { accepted: true };
  }
}
