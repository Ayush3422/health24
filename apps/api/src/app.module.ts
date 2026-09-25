import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { validateEnv } from './config/env';
import { DatabaseModule } from './db/database.module';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { HospitalsModule } from './modules/hospitals/hospitals.module';
import { PatientsModule } from './modules/patients/patients.module';
import { TerminologyModule } from './modules/terminology/terminology.module';
import { ClinicalModule } from './modules/clinical/clinical.module';
import { CorrectionsModule } from './modules/corrections/corrections.module';
import { PrivacyModule } from './modules/privacy/privacy.module';
import { ExportsModule } from './modules/exports/exports.module';
import { DocumentsModule } from './modules/documents/documents.module';
import { ImportsModule } from './modules/imports/imports.module';
import { BillingModule } from './modules/billing/billing.module';
import { DischargeModule } from './modules/discharge/discharge.module';
import { OrdersModule } from './modules/orders/orders.module';
import { PortalModule } from './modules/portal/portal.module';
import { WardsModule } from './modules/wards/wards.module';
import { ScanningModule } from './modules/scanning/scanning.module';
import { StorageModule } from './modules/storage/storage.module';
import { StaffModule } from './modules/staff/staff.module';
import { AuthGuard } from './common/guards/auth.guard';
import { PermissionsGuard } from './common/guards/permissions.guard';
import { RequestContextMiddleware } from './common/request-context.middleware';
import { HealthController } from './health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // The process refuses to start on invalid configuration.
      validate: validateEnv,
    }),
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 120 }]),
    DatabaseModule,
    AuditModule,
    AuthModule,
    HospitalsModule,
    StaffModule,
    PatientsModule,
    TerminologyModule,
    ClinicalModule,
    // Documents (SP4). Neither connects until used: the API starts without them.
    StorageModule,
    ScanningModule,
    DocumentsModule,
    ImportsModule,
    // The patient portal (SP5).
    OrdersModule,
    DischargeModule,
    BillingModule,
    PortalModule,
    WardsModule,
    ExportsModule,
    CorrectionsModule,
    PrivacyModule,
  ],
  controllers: [HealthController],
  providers: [
    // Order matters: rate limiting, then authentication, then authorisation.
    // Registering these globally means a new route is protected by default and
    // must opt out with @Public(), rather than being exposed by omission.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
