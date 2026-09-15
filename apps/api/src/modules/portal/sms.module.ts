import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LogSmsSender, NotConfiguredSmsSender, SMS_SENDER, type SmsSender } from './sms';

/**
 * Text messages to patients: sign-in codes in the API, emergency-access alerts
 * in the worker (SP5). One sender, wherever it is needed.
 */
@Module({
  providers: [
    LogSmsSender,
    // The log outside production; in production, only a configured provider —
    // none exists until one is chosen before the pilot (sp5-plan.md, DF2).
    {
      provide: SMS_SENDER,
      inject: [ConfigService, LogSmsSender],
      useFactory: (config: ConfigService, log: LogSmsSender): SmsSender => {
        const provider =
          config.get<string>('SMS_PROVIDER') ??
          (config.get<string>('NODE_ENV') === 'production' ? undefined : 'log');

        return provider === 'log' ? log : new NotConfiguredSmsSender();
      },
    },
  ],
  exports: [SMS_SENDER, LogSmsSender],
})
export class SmsModule {}
