import { Module } from '@nestjs/common';
import { ScanningModule } from '../scanning/scanning.module';
import { StorageModule } from '../storage/storage.module';
import { ImportScanHandler } from './import-scan.handler';
import { ImportsController } from './imports.controller';
import { ImportsService } from './imports.service';

@Module({
  imports: [StorageModule, ScanningModule],
  controllers: [ImportsController],
  providers: [ImportsService, ImportScanHandler],
  exports: [ImportsService, ImportScanHandler],
})
export class ImportsModule {}
