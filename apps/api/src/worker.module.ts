import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './config/env';
import { DatabaseModule } from './db/database.module';
import { AuditModule } from './modules/audit/audit.module';
import { DocumentCleanupTimer } from './modules/documents/document-cleanup.timer';
import { DocumentScanHandler } from './modules/documents/document-scan.handler';
import { DocumentsModule } from './modules/documents/documents.module';
import { ImportsModule } from './modules/imports/imports.module';
import { SCAN_JOB_HANDLER } from './modules/scanning/scan-queue';
import { ScanningModule } from './modules/scanning/scanning.module';
import { ScanWorker } from './modules/scanning/scan.worker';
import { StorageModule } from './modules/storage/storage.module';

/**
 * The background worker: scanning now; thumbnails, page counts and the
 * clean-up of abandoned uploads as SP4 adds them. No HTTP routes.
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
  ],
  providers: [
    ScanWorker,
    // Each scan's verdict is recorded against its document.
    { provide: SCAN_JOB_HANDLER, useExisting: DocumentScanHandler },
    DocumentCleanupTimer,
  ],
})
export class WorkerModule {}
