import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AuditModule } from '../audit/audit.module';
import { OtpService } from './otp.service';
import { PortalAccessController } from './portal-access.controller';
import { PortalAccessService } from './portal-access.service';
import { ClinicalModule } from '../clinical/clinical.module';
import { DocumentsModule } from '../documents/documents.module';
import { PortalAuthController } from './portal-auth.controller';
import { PortalConsentController } from './portal-consent.controller';
import { PortalRecordController } from './portal-record.controller';
import { PortalRecordService } from './portal-record.service';
import { PortalSessionService } from './portal-session.service';
import { AccessHistoryService } from './access-history.service';
import { PortalActivityController } from './portal-activity.controller';
import { SmsModule } from './sms.module';

/** The patient portal (SP5): sign-in and sessions, and activation at the desk. */
@Module({
  imports: [
    AuditModule,
    SmsModule,
    // The patient's own record, read through the services staff use.
    ClinicalModule,
    DocumentsModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      }),
    }),
  ],
  controllers: [
    PortalAuthController,
    PortalAccessController,
    PortalRecordController,
    PortalConsentController,
    PortalActivityController,
  ],
  providers: [
    OtpService,
    PortalSessionService,
    PortalAccessService,
    PortalRecordService,
    AccessHistoryService,
  ],
  // PortalSessionService is exported because the global AuthGuard depends on it.
  exports: [PortalSessionService, SmsModule],
})
export class PortalModule {}
