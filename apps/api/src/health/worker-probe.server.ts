import { createServer, type Server } from 'node:http';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ScanQueue } from '../modules/scanning/scan-queue';
import { NotificationQueue } from '../modules/notifications/notification-queue';
import { MetricsService } from './metrics.service';

/**
 * The worker's own liveness and metrics (sp7-plan.md, T9, T14).
 *
 * The worker has no API, which for a long time meant it also had no way to say
 * whether it was alive or how deep its queues were — and a queue nobody is
 * draining is exactly the failure that goes unnoticed for a day. So it listens
 * on a port of its own, serving two paths and nothing else: a liveness probe
 * for the orchestrator, and the metrics a scraper collects.
 *
 * Deliberately not the Nest HTTP platform: a worker that can serve a route can
 * be given one, and the moment it has a route somebody will put a clinical
 * endpoint on it. Twenty lines of `node:http` cannot grow that way.
 */
@Injectable()
export class WorkerProbeServer implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(WorkerProbeServer.name);
  private server: Server | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly metrics: MetricsService,
    private readonly scans: ScanQueue,
    private readonly notifications: NotificationQueue,
  ) {}

  onApplicationBootstrap(): void {
    this.registerGauges();

    const port = Number(this.config.get<string>('WORKER_PORT') ?? 3100);

    this.server = createServer((request, response) => {
      const path = (request.url ?? '/').split('?')[0];

      if (request.method !== 'GET') {
        response.writeHead(405).end();
        return;
      }

      if (path === '/health') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ status: 'ok' }));
        return;
      }

      if (path === '/metrics') {
        void this.metrics
          .scrape()
          .then((body) => {
            response.writeHead(200, {
              'content-type': 'text/plain; version=0.0.4; charset=utf-8',
            });
            response.end(body);
          })
          .catch(() => response.writeHead(500).end());
        return;
      }

      response.writeHead(404).end();
    });

    this.server.listen(port, () => {
      this.logger.log(`Worker probes on port ${String(port)}`);
    });

    // Never a reason to keep the process alive on its own account.
    this.server.unref();
  }

  onApplicationShutdown(): void {
    this.server?.close();
  }

  /**
   * How much work is waiting, read when somebody asks.
   *
   * Read at scrape time rather than counted as jobs pass: a counter kept in
   * memory says what this process has seen, and the question worth asking is
   * what is left for anybody to do.
   */
  private registerGauges(): void {
    for (const [name, queue] of [
      ['scan', this.scans],
      ['notification', this.notifications],
    ] as const) {
      this.metrics.gauge(
        `${name}_queue_waiting`,
        `Jobs waiting in the ${name} queue.`,
        () => queue.depth().then((counts) => counts.waiting),
      );

      this.metrics.gauge(
        `${name}_queue_failed`,
        `Jobs in the ${name} queue that have failed every attempt.`,
        () => queue.depth().then((counts) => counts.failed),
      );
    }
  }
}
