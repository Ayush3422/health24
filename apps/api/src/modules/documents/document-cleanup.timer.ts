import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ImportsService } from '../imports/imports.service';
import { DocumentsService } from './documents.service';

const EVERY_HOUR_MS = 60 * 60 * 1000;

/**
 * Abandons uploads never completed, once an hour, in the worker. Safe to run
 * in several workers at once: each step only moves a document that is still
 * pending, and removing an object twice is harmless.
 */
@Injectable()
export class DocumentCleanupTimer implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(DocumentCleanupTimer.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly documents: DocumentsService,
    private readonly imports: ImportsService,
  ) {}

  onApplicationBootstrap(): void {
    const run = () =>
      void Promise.all([this.documents.abandonStale(), this.imports.abandonStale()]).catch(
        (error: unknown) =>
          this.logger.error(`Clean-up of abandoned uploads failed: ${String(error)}`),
      );

    this.timer = setInterval(run, EVERY_HOUR_MS);
    this.timer.unref();
    run();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
