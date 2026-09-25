import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { APP_FILTER, HttpAdapterHost } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import pino from 'pino';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Options } from 'pino-http';
import { ErrorReporter, ErrorReportingFilter, NoopErrorReporter } from './error-reporter';
import { scrub, scrubText } from './scrub';

/**
 * Structured logs, with a scrubber between the application and every sink
 * (sp7-plan.md, T5, DF4).
 *
 * One JSON object per line, because a log is read by a machine first and a
 * person second; a request id on every line, because the question asked of a
 * log is almost always "what else happened while serving this?"; and nothing
 * that names a patient, because a log aggregator has none of the protections
 * the record has.
 *
 * The scrubbing is done in pino's `logMethod` hook rather than at the call
 * sites, on purpose. A rule that every caller has to remember is a rule that
 * is broken the first busy afternoon after somebody new joins; this one holds
 * whatever anybody writes.
 */

/** The request headers worth keeping. Everything else is dropped. */
const SAFE_HEADERS = ['user-agent', 'content-type', 'content-length', 'x-request-id'];

function safeHeaders(headers: IncomingMessage['headers']): Record<string, unknown> {
  const kept: Record<string, unknown> = {};

  for (const header of SAFE_HEADERS) {
    if (headers[header] !== undefined) kept[header] = headers[header];
  }

  return kept;
}

/**
 * The pino options the API and the worker share.
 *
 * Exported so that a test can build the very same logger over a stream it
 * controls, and prove that nothing gets past it.
 */
export function pinoOptions(level: string, pretty: boolean): Options {
  return {
    level,
    // Developers read logs on a terminal; everything else reads JSON.
    ...(pretty
      ? { transport: { target: 'pino-pretty', options: { singleLine: true, translateTime: true } } }
      : {}),

    // One id per request, taken from the edge when it set one, so a line here
    // can be lined up with a line from the load balancer.
    genReqId: (req: IncomingMessage, res: ServerResponse) => {
      const incoming = req.headers['x-request-id'];
      const id = (Array.isArray(incoming) ? incoming[0] : incoming) ?? randomUUID();
      res.setHeader('x-request-id', id);
      return id;
    },

    // A URL carries search terms — a patient's name, a phone number — so the
    // path is kept and the query string is not.
    serializers: {
      req: (req: IncomingMessage & { id?: unknown; url?: string; method?: string }) => ({
        id: req.id,
        method: req.method,
        path: (req.url ?? '').split('?')[0],
        headers: safeHeaders(req.headers),
      }),
      // pino-http hands the serializer its own wrapper, whose `raw` is the
      // response Node actually wrote; taking the status from the wrapper alone
      // logs null for every request.
      res: (res: ServerResponse & { raw?: ServerResponse }) => ({
        statusCode: res.raw?.statusCode ?? res.statusCode,
      }),
      err: (error: Error) => scrub(error),
    },

    /**
     * The last thing before a line is written. Every argument — the message,
     * the merged object, an error — goes through the scrubber, so a leak
     * cannot be introduced by a caller who did not know the rule.
     */
    hooks: {
      logMethod(args: unknown[], method) {
        const cleaned = args.map((argument) =>
          typeof argument === 'string' ? scrubText(argument) : scrub(argument),
        );

        method.apply(this, cleaned as Parameters<typeof method>);
      },
    },

    // A 404 is not a warning and a 500 is not an error until somebody decides
    // it is; this keeps the levels meaning what they say.
    customLogLevel: (_req, res, error) => {
      if (error || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },

    customSuccessMessage: (req: IncomingMessage & { method?: string }, res) =>
      `${req.method ?? 'GET'} ${String(res.statusCode)}`,

    // Health checks would otherwise be most of the log.
    autoLogging: {
      ignore: (req: IncomingMessage & { url?: string }) =>
        ['/health', '/ready', '/metrics'].includes((req.url ?? '').split('?')[0] ?? ''),
    },
  };
}

@Module({
  imports: [
    LoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const file = config.get<string>('LOG_FILE');

        // A file means no prettifier: the point of writing to one is to have
        // exactly what a collector would ingest.
        const options = pinoOptions(
          config.get<string>('LOG_LEVEL') ?? 'info',
          !file &&
            config.get<string>('NODE_ENV') !== 'production' &&
            config.get<string>('LOG_FORMAT') !== 'json',
        );

        return {
          pinoHttp: file
            ? ([options, pino.destination({ dest: file, sync: true, mkdir: true })] as const)
            : options,
        };
      },
    }),
  ],
  providers: [
    // Swapped for a transport that sends somewhere when there is one to send
    // to, and an agreement covering it (T7).
    { provide: ErrorReporter, useClass: NoopErrorReporter },
    {
      provide: APP_FILTER,
      // The adapter has to be handed over explicitly: without it the filter
      // catches an error and never writes a response, and the request hangs
      // until the client gives up.
      useFactory: (reporter: ErrorReporter, adapters: HttpAdapterHost) =>
        new ErrorReportingFilter(reporter, adapters),
      inject: [ErrorReporter, HttpAdapterHost],
    },
  ],
  exports: [LoggerModule, ErrorReporter],
})
export class AppLoggerModule {}
