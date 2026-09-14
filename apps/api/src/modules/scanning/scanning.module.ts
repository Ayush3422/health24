import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { ScanQueue } from './scan-queue';
import { ScanProcessor } from './scan.processor';

/** The queue, for the API to add to, and the processor, for the worker to run. */
@Module({
  imports: [StorageModule],
  providers: [ScanQueue, ScanProcessor],
  exports: [ScanQueue, ScanProcessor],
})
export class ScanningModule {}
