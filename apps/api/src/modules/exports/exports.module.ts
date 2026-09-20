import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { StorageModule } from '../storage/storage.module';
import { ExportBuilder } from './export-builder';
import { ExportQueue } from './export-queue';
import { PortalExportsController } from './exports.controller';
import { ExportsService } from './exports.service';

/**
 * The patient's copy of their own record (SP5, Decision N1): the API records
 * and queues the request, the worker builds the files.
 */
@Module({
  imports: [AuditModule, StorageModule],
  controllers: [PortalExportsController],
  providers: [ExportQueue, ExportsService, ExportBuilder],
  exports: [ExportQueue, ExportsService, ExportBuilder],
})
export class ExportsModule {}
