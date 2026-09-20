import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { SmsModule } from '../portal/sms.module';
import { ErasureQueueController, PortalErasureController } from './erasure.controller';
import { ErasureService } from './erasure.service';

/** The patient's right to erasure, and the officer who decides it (SP5, Decision N1). */
@Module({
  imports: [AuditModule, SmsModule],
  controllers: [PortalErasureController, ErasureQueueController],
  providers: [ErasureService],
  exports: [ErasureService],
})
export class PrivacyModule {}
