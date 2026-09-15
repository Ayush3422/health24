import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { SmsModule } from '../portal/sms.module';
import { BreakGlassNotifier } from './break-glass-notifier';
import { NotificationQueue } from './notification-queue';

/**
 * Messages to patients: the queue, for the API to add to, and the notifier,
 * for the worker to run (SP5, DF10).
 */
@Module({
  imports: [AuditModule, SmsModule],
  providers: [NotificationQueue, BreakGlassNotifier],
  exports: [NotificationQueue, BreakGlassNotifier],
})
export class NotificationsModule {}
