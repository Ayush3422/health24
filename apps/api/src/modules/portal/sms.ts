import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { maskPhone } from '../../common/phone';

export const SMS_SENDER = Symbol('SMS_SENDER');

export interface SmsMessage {
  /** E.164. */
  to: string;
  body: string;
  /** Each maps to a DLT-registered template with a real provider (sp5-plan.md, DF2). */
  template: 'otp' | 'break_glass' | 'consent' | 'guardian_handover';
}

/** Sends one transactional SMS. */
export interface SmsSender {
  send(message: SmsMessage): Promise<void>;
}

/**
 * Development only: writes each message to the API log and keeps the last few
 * in memory, so a developer can sign in locally and the test suites can read a
 * code. Startup refuses it in production.
 */
@Injectable()
export class LogSmsSender implements SmsSender {
  private readonly logger = new Logger('SMS');
  private readonly sent: SmsMessage[] = [];

  async send(message: SmsMessage): Promise<void> {
    this.sent.push(message);
    if (this.sent.length > 200) this.sent.shift();

    this.logger.log(`[development SMS to ${maskPhone(message.to)}] ${message.body}`);
  }

  /** The latest message sent to a number. */
  lastTo(phone: string): SmsMessage | undefined {
    return [...this.sent].reverse().find((message) => message.to === phone);
  }
}

/**
 * Production with no provider configured: the API starts, and any attempt to
 * send says so — a code is never quietly written somewhere else instead.
 */
@Injectable()
export class NotConfiguredSmsSender implements SmsSender {
  async send(): Promise<void> {
    throw new ServiceUnavailableException('Text messages cannot be sent yet. Please try again later.');
  }
}
