import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sql } from 'drizzle-orm';
import Redis from 'ioredis';
import { DatabaseService } from '../db/database.service';
import { StorageService } from '../modules/storage/storage.service';

/**
 * Whether this process can actually do its job (sp7-plan.md, T8, DF6).
 *
 * Liveness and readiness are different questions, and answering them with one
 * endpoint — as this API did until now — means a load balancer either keeps
 * traffic away from a process that is merely starting, or sends it to one that
 * cannot reach its database. So: `/health` says the process is alive, and this
 * says whether its dependencies are.
 *
 * Every check has a timeout. A readiness probe that hangs is worse than one
 * that fails: the probe times out too, and nothing says why.
 */

export type CheckState = 'up' | 'down' | 'not configured';

export interface Check {
  state: CheckState;
  /** Only when down, and never anything a patient would recognise. */
  detail?: string;
  ms: number;
}

export interface Readiness {
  ready: boolean;
  checks: Record<string, Check>;
}

const TIMEOUT_MS = 2_000;

@Injectable()
export class ReadinessService {
  private readonly logger = new Logger(ReadinessService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly storage: StorageService,
    private readonly config: ConfigService,
  ) {}

  async check(): Promise<Readiness> {
    const [database, migrations, redis, storage] = await Promise.all([
      this.timed(() => this.database()),
      this.timed(() => this.migrations()),
      this.timed(() => this.redis()),
      this.timed(() => this.storage_()),
    ]);

    const checks = { database, migrations, redis, storage };
    const ready = Object.values(checks).every((check) => check.state !== 'down');

    return { ready, checks };
  }

  /** Runs a check with a clock and a timeout around it. */
  private async timed(check: () => Promise<Omit<Check, 'ms'>>): Promise<Check> {
    const started = Date.now();

    try {
      const outcome = await Promise.race([
        check(),
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error(`did not answer within ${TIMEOUT_MS}ms`)), TIMEOUT_MS),
        ),
      ]);

      return { ...outcome, ms: Date.now() - started };
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : 'unknown failure';
      this.logger.warn(`Readiness check failed: ${detail}`);

      return { state: 'down', detail, ms: Date.now() - started };
    }
  }

  private async database(): Promise<Omit<Check, 'ms'>> {
    await this.db.raw.execute(sql`SELECT 1`);
    return { state: 'up' };
  }

  /**
   * That the database is at the schema this build expects.
   *
   * A process serving against a schema older than its code is the quiet half
   * of a bad deploy: most routes work, and the ones that touch the new column
   * fail one at a time. Better to stay out of the load balancer.
   */
  private async migrations(): Promise<Omit<Check, 'ms'>> {
    const expected = this.expectedMigrations();

    if (expected === null) return { state: 'not configured', detail: 'no journal in this build' };

    // Through a function rather than the table: the application role is kept
    // out of the migration history on purpose (migration 0066), so it asks how
    // many have been applied and learns nothing else.
    const [row] = await this.db.raw.execute<{ applied: number }>(
      sql`SELECT app.schema_version() AS applied`,
    );

    const applied = Number(row?.applied ?? 0);

    if (applied < expected) {
      return { state: 'down', detail: `${applied} of ${expected} migrations applied` };
    }

    // More applied than this build knows about is a rollback in progress: the
    // database is ahead, which is somebody else's deploy, not a fault here.
    return { state: 'up', detail: applied > expected ? `database is ahead (${applied})` : undefined };
  }

  /** How many migrations this build ships, from the journal beside them. */
  private expectedMigrations(): number | null {
    for (const candidate of [
      path.resolve(process.cwd(), 'drizzle', 'meta', '_journal.json'),
      path.resolve(__dirname, '..', '..', 'drizzle', 'meta', '_journal.json'),
      path.resolve(__dirname, '..', '..', '..', 'drizzle', 'meta', '_journal.json'),
    ]) {
      if (!existsSync(candidate)) continue;

      try {
        const journal = JSON.parse(readFileSync(candidate, 'utf8')) as { entries?: unknown[] };
        return journal.entries?.length ?? null;
      } catch {
        return null;
      }
    }

    return null;
  }

  private async redis(): Promise<Omit<Check, 'ms'>> {
    const url = this.config.get<string>('REDIS_URL');
    if (!url) return { state: 'not configured' };

    const client = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: TIMEOUT_MS,
      retryStrategy: () => null,
    });

    try {
      await client.connect();
      await client.ping();
      return { state: 'up' };
    } finally {
      client.disconnect();
    }
  }

  private async storage_(): Promise<Omit<Check, 'ms'>> {
    await this.storage.reachable();
    return { state: 'up' };
  }
}
