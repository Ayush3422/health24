import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { SmsModule } from '../portal/sms.module';
import { BreakGlassNotifier } from './break-glass-notifier';
import { GuardianHandover } from './guardian-handover';
import { NotificationQueue } from './notification-queue';

/**
 * Messages to patients: the queue, for the API to add to, and what the worker
 * runs — telling a patient of emergency access (DF10), and handing a record
 * over at 18 (Decision M1).
 */
@Module({
  imports: [AuditModule, SmsModule],
  providers: [NotificationQueue, BreakGlassNotifier, GuardianHandover],
  exports: [NotificationQueue, BreakGlassNotifier, GuardianHandover],
})
export class NotificationsModule {}
