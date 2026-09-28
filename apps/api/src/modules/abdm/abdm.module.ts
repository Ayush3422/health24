import { Logger, Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { SmsModule } from '../portal/sms.module';
import { CareContextController } from './care-contexts/care-context.controller';
import { DiscoveryService } from './care-contexts/discovery.service';
import { LinkingService } from './care-contexts/linking.service';
import { AbdmConsentService } from './consent/abdm-consent.service';
import { AbdmConfig } from './abdm.config';
import { AbhaController } from './abha.controller';
import { AbhaService } from './abha.service';
import { GatewayAbhaVerification } from './abha-verification.gateway';
import { DisabledAbhaVerification, MockAbhaVerification } from './abha-verification.mock';
import { ABHA_VERIFICATION, type AbhaVerificationPort } from './abha-verification.port';
import { GatewayCallbackController } from './gateway/callback.controller';
import { GatewayInboundController } from './gateway/inbound.controller';
import { PendingRequests } from './gateway/correlation';
import { GatewayClient } from './gateway/gateway.client';
import { GatewaySession } from './gateway/session';

/**
 * Everything this system does with ABDM (sp8-plan.md, Phases 1–3).
 *
 * Three configurations and nothing else: switched off, an in-process
 * stand-in, or the wire adapter pointed at a gateway. Everything that talks
 * to ABDM goes through one client — confirming an ABHA, offering to link a
 * patient's visits, and answering the network when a patient goes looking for
 * this hospital from their own app. Consent notification and the data push
 * arrive in later phases through the same client, which is why it exists
 * rather than each flow growing its own (DF4).
 */
@Module({
  imports: [AuditModule, SmsModule],
  controllers: [
    AbhaController,
    CareContextController,
    GatewayCallbackController,
    GatewayInboundController,
  ],
  providers: [
    AbhaService,
    DiscoveryService,
    LinkingService,
    AbdmConsentService,
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
  exports: [AbhaService, AbdmConfig, PendingRequests, LinkingService, AbdmConsentService],
})
export class AbdmModule {}
