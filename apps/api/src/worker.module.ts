import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './config/env';
import { DatabaseModule } from './db/database.module';
import { AuditModule } from './modules/audit/audit.module';
import { DocumentCleanupTimer } from './modules/documents/document-cleanup.timer';
import { DocumentScanHandler } from './modules/documents/document-scan.handler';
import { DocumentsModule } from './modules/documents/documents.module';
import { ExportWorker } from './modules/exports/export.worker';
import { ExportsModule } from './modules/exports/exports.module';
import { ImportsModule } from './modules/imports/imports.module';
import { GuardianHandoverTimer } from './modules/notifications/guardian-handover.timer';
import { NotificationSweepTimer } from './modules/notifications/notification-sweep.timer';
import { NotificationWorker } from './modules/notifications/notification.worker';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { DailySummaryTimer } from './modules/reports/daily-summary.timer';
import { ReportsModule } from './modules/reports/reports.module';
import { SCAN_JOB_HANDLER } from './modules/scanning/scan-queue';
import { ScanningModule } from './modules/scanning/scanning.module';
import { ScanWorker } from './modules/scanning/scan.worker';
import { StorageModule } from './modules/storage/storage.module';

/**
 * The background worker: scanning uploads and cleaning up abandoned ones
 * (SP4), and telling patients of emergency access to their record (SP5). No
 * HTTP routes.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    DatabaseModule,
    AuditModule,
    StorageModule,
    ScanningModule,
    DocumentsModule,
    ImportsModule,
    NotificationsModule,
    ExportsModule,
    ReportsModule,
  ],
  providers: [
    ScanWorker,
    // Each scan's verdict is recorded against its document.
    { provide: SCAN_JOB_HANDLER, useExisting: DocumentScanHandler },
    DocumentCleanupTimer,
    NotificationWorker,
    NotificationSweepTimer,
    GuardianHandoverTimer,
    ExportWorker,
    // Counts yesterday for every hospital, so a year's report is cheap.
    DailySummaryTimer,
  ],
})
export class WorkerModule {}
