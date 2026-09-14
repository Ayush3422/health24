import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './config/env';
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
    StorageModule,
    ScanningModule,
  ],
  providers: [ScanWorker],
})
export class WorkerModule {}
