import { appendFile } from 'node:fs/promises';
import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { maskPhone } from '../../common/phone';

export const SMS_SENDER = Symbol('SMS_SENDER');

export interface SmsMessage {
  /** E.164. */
  to: string;
  body: string;
  /** Each maps to a DLT-registered template with a real provider (sp5-plan.md, DF2). */
  template: 'otp' | 'break_glass' | 'consent' | 'guardian_handover' | 'erasure';
}

/** Sends one transactional SMS. */
export interface SmsSender {
  send(message: SmsMessage): Promise<void>;
}

/**
 * Development only: writes each message to the API log and keeps the last few
 * in memory, so a developer can sign in locally and the test suites can read a
 * code. Startup refuses it in production.
 *
 * With `SMS_LOG_FILE` set it also appends each message to that file, one JSON
 * object per line. The portal's browser tests run against an API in another
 * process and cannot reach this object; the file is how they stand in for the
 * patient's phone (sp5-plan.md, T23). A failed write is reported and swallowed
 * — a test fixture must never be the reason a message is not sent.
 */
@Injectable()
export class LogSmsSender implements SmsSender {
  private readonly logger = new Logger('SMS');
  private readonly sent: SmsMessage[] = [];
  private readonly file: string | undefined;

  constructor(config: ConfigService) {
    this.file = config.get<string>('SMS_LOG_FILE');
  }

  async send(message: SmsMessage): Promise<void> {
    this.sent.push(message);
    if (this.sent.length > 200) this.sent.shift();

    this.logger.log(`[development SMS to ${maskPhone(message.to)}] ${message.body}`);

    if (this.file) {
      try {
        await appendFile(
          this.file,
          `${JSON.stringify({ ...message, at: new Date().toISOString() })}\n`,
        );
      } catch (error: unknown) {
        this.logger.warn(`Could not write ${this.file}: ${String(error)}`);
      }
    }
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
    throw new ServiceUnavailableException(
      'Text messages cannot be sent yet. Please try again later.',
    );
  }
}
