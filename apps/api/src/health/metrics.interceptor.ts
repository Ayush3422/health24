import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';
import { MetricsService } from './metrics.service';

/**
 * How many requests, how long they took, and how they ended (sp7-plan.md, T9).
 *
 * The route is recorded as its pattern rather than its path, so
 * `/patients/01a0…/timeline` is counted as `/patients/:id/timeline`. That
 * keeps the number of time series bounded — the reason every metrics system
 * asks for it — and, here, also keeps a patient's id out of a dashboard that
 * is kept for a year and has none of the record's protections.
 */
@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {
    metrics.describe('http_requests_total', 'Requests served, by route, method and status class.');
    metrics.describe('http_request_duration_seconds', 'How long requests took, by route.');
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const http = context.switchToHttp();
    const request = http.getRequest<Request & { route?: { path?: string } }>();
    const started = process.hrtime.bigint();

    const record = () => {
      const response = http.getResponse<Response>();
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;

      // Express fills `route.path` with the pattern the handler was declared
      // with; an unmatched request has none, and is counted as `unmatched`
      // rather than by whatever path was tried.
      const labels = {
        route: request.route?.path ?? 'unmatched',
        method: request.method,
        status: `${String(Math.floor(response.statusCode / 100))}xx`,
      };

      this.metrics.count('http_requests_total', labels);
      this.metrics.observe('http_request_duration_seconds', seconds, {
        route: labels.route,
        method: labels.method,
      });
    };

    return next.handle().pipe(tap({ next: record, error: record }));
  }
}
