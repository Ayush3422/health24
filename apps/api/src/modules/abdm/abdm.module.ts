import { Logger, Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AbdmConfig } from './abdm.config';
import { AbhaController } from './abha.controller';
import { AbhaService } from './abha.service';
import { GatewayAbhaVerification } from './abha-verification.gateway';
import { DisabledAbhaVerification, MockAbhaVerification } from './abha-verification.mock';
import { ABHA_VERIFICATION, type AbhaVerificationPort } from './abha-verification.port';
import { GatewayCallbackController } from './gateway/callback.controller';
import { PendingRequests } from './gateway/correlation';
import { GatewayClient } from './gateway/gateway.client';
import { GatewaySession } from './gateway/session';

/**
 * Everything this system does with ABDM (sp8-plan.md, Phases 1–2).
 *
 * One operation today — confirming a patient's ABHA — reached three ways,
 * and the three are the whole configuration surface: switched off, an
 * in-process stand-in, or the wire adapter pointed at a gateway. Care
 * contexts, consent notifications and the data push arrive in later phases
 * behind the same interface and through the same client, which is why both
 * exist before there is more than one caller (DF4).
 */
@Module({
  imports: [AuditModule],
  controllers: [AbhaController, GatewayCallbackController],
  providers: [
    AbhaService,
    AbdmConfig,
    PendingRequests,
    GatewaySession,
    GatewayClient,
    {
      provide: ABHA_VERIFICATION,
      inject: [AbdmConfig, GatewayClient],
      useFactory: (config: AbdmConfig, client: GatewayClient): AbhaVerificationPort => {
        const logger = new Logger('Abdm');

        if (config.mode === 'mock') {
          // Said out loud on every boot. A mocked national registry is the
          // sort of thing that should never be discovered by surprise.
          logger.warn(
            'ABHA verification is mocked (ABDM_MODE=mock). No code reaches a patient.',
          );

          return new MockAbhaVerification();
        }

        if (config.mode === 'gateway') {
          logger.log(`ABHA verification will use the gateway at ${config.gateway.baseUrl}`);
          return new GatewayAbhaVerification(client);
        }

        return new DisabledAbhaVerification();
      },
    },
  ],
  exports: [AbhaService, AbdmConfig, PendingRequests],
})
export class AbdmModule {}
