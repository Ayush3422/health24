import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AuditModule } from '../audit/audit.module';
import { OtpService } from './otp.service';
import { PortalAccessController } from './portal-access.controller';
import { PortalAccessService } from './portal-access.service';
import { PortalAuthController } from './portal-auth.controller';
import { PortalSessionService } from './portal-session.service';
import { LogSmsSender, NotConfiguredSmsSender, SMS_SENDER, type SmsSender } from './sms';

/** The patient portal (SP5): sign-in and sessions, and activation at the desk. */
@Module({
  imports: [
    AuditModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      }),
    }),
  ],
  controllers: [PortalAuthController, PortalAccessController],
  providers: [
    OtpService,
    PortalSessionService,
    PortalAccessService,
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
  // PortalSessionService is exported because the global AuthGuard depends on it.
  exports: [PortalSessionService, SMS_SENDER, LogSmsSender],
})
export class PortalModule {}
