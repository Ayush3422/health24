import { ArgumentsHost, Catch, HttpException, Injectable, Logger } from '@nestjs/common';
import { BaseExceptionFilter, HttpAdapterHost, type AbstractHttpAdapter } from '@nestjs/core';
import type { Request } from 'express';
import type { Actor, RequestMeta } from '../actor';
import { scrub, scrubText } from './scrub';

/**
 * Where an unhandled error goes (sp7-plan.md, T7).
 *
 * Behind an interface, and off unless something is configured, because the
 * obvious implementation — an error-tracking service — is a third party that
 * would receive whatever the error carried. Ours carry patient data often
 * enough: a failed insert quotes the row, a validation error quotes the value.
 * So everything reported goes through the same scrubber as the logs, and what
 * is sent is the shape of the failure and the identifiers needed to find it
 * in the record, never the record.
 *
 * A Sentry or Rollbar transport is added by implementing `ErrorReporter` and
 * providing it in `AppLoggerModule` — the rest of the application does not
 * change, and the scrubbing is not something that transport can skip.
 */

export interface ReportedContext {
  requestId?: string;
  route?: string;
  /** Who was acting: ids only, never a name. */
  staffUserId?: string | null;
  hospitalId?: string | null;
  patientId?: string | null;
  statusCode?: number;
}

export abstract class ErrorReporter {
  abstract report(error: unknown, context: ReportedContext): void;
}

/**
 * The default: nothing leaves the process.
 *
 * Errors are still logged — the logger writes them, scrubbed — so this is not
 * "errors are lost", it is "errors are not sent to a third party nobody has
 * signed an agreement with".
 */
@Injectable()
export class NoopErrorReporter extends ErrorReporter {
  report(): void {
    // Deliberately nothing.
  }
}

/**
 * Turns an unhandled error into one scrubbed log line and one report.
 *
 * Nest's default filter logs the error itself, which for a database error
 * includes the failing statement and its parameters — a patient's name, an
 * MRN, a diagnosis. This replaces that with a line carrying the identifiers
 * and the shape of the failure, and lets the response fall through unchanged.
 */
@Catch()
export class ErrorReportingFilter extends BaseExceptionFilter {
  private readonly logger = new Logger('UnhandledError');

  constructor(
    private readonly reporter: ErrorReporter,
    private readonly adapters: HttpAdapterHost,
  ) {
    super();
  }

  override catch(exception: unknown, host: ArgumentsHost): void {
    // Resolved here rather than in the constructor: a global filter is built
    // while the module is compiled, which is before the HTTP adapter exists.
    // Without it the base filter catches an error and writes no response, and
    // every refused request hangs until the client gives up.
    // `applicationRef` is declared readonly for callers who pass it to the
    // constructor, which is the case this one cannot use.
    const base = this as unknown as { applicationRef?: AbstractHttpAdapter };
    base.applicationRef ??= this.adapters.httpAdapter;

    if (host.getType() === 'http') {
      const request = host
        .switchToHttp()
        .getRequest<Request & { meta?: RequestMeta; actor?: Actor }>();

      const status = exception instanceof HttpException ? exception.getStatus() : 500;

      // A 4xx is the caller being told no, which the request log already says.
      if (status >= 500) {
        const context: ReportedContext = {
          requestId: request.meta?.requestId,
          route: request.meta?.route ?? undefined,
          staffUserId: request.actor?.staffUserId ?? null,
          hospitalId: request.actor?.hospitalId ?? null,
          statusCode: status,
        };

        this.logger.error({
          ...context,
          error: scrub(exception),
          message: scrubText(exception instanceof Error ? exception.message : 'Unhandled error'),
        });

        this.reporter.report(exception, context);
      }
    }

    super.catch(exception, host);
  }
}
