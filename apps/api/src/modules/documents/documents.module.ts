import { Module } from '@nestjs/common';
import { ScanningModule } from '../scanning/scanning.module';
import { StorageModule } from '../storage/storage.module';
import { DocumentScanHandler } from './document-scan.handler';
import { ImportsModule } from '../imports/imports.module';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';

@Module({
  imports: [StorageModule, ScanningModule, ImportsModule],
  controllers: [DocumentsController],
  providers: [DocumentsService, DocumentScanHandler],
  exports: [DocumentsService, DocumentScanHandler],
})
export class DocumentsModule {}
