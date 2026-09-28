import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditModule } from '../audit/audit.module';
import { AbhaController } from './abha.controller';
import { AbhaService } from './abha.service';
import { DisabledAbhaVerification, MockAbhaVerification } from './abha-verification.mock';
import { ABHA_VERIFICATION, type AbdmMode, type AbhaVerificationPort } from './abha-verification.port';

/**
 * Everything this system does with ABDM (sp8-plan.md, Phase 1).
 *
 * Today that is one thing: confirming a patient's ABHA. The care contexts,
 * the consent notifications and the data push arrive in later phases behind
 * the same interface, which is why the interface exists before there is more
 * than one implementation of it (DF4).
 */
@Module({
  imports: [AuditModule],
  controllers: [AbhaController],
  providers: [
    AbhaService,
    {
      provide: ABHA_VERIFICATION,
      inject: [ConfigService],
      useFactory: (config: ConfigService): AbhaVerificationPort => {
        // Unset means the mock outside production and nothing at all in it:
        // the real gateway is Phase 2, and a deployment must not silently
        // believe it has one.
        const configured = config.get<AbdmMode | undefined>('ABDM_MODE');
        const production = config.get<string>('NODE_ENV') === 'production';
        const mode: AbdmMode = configured ?? (production ? 'off' : 'mock');

        if (mode === 'mock') {
          // Said out loud on every boot. A mocked national registry is the
          // sort of thing that should never be discovered by surprise.
          new Logger('Abdm').warn(
            'ABHA verification is mocked (ABDM_MODE=mock). No code reaches a patient.',
          );

          return new MockAbhaVerification();
        }

        return new DisabledAbhaVerification();
      },
    },
  ],
  exports: [AbhaService],
})
export class AbdmModule {}
