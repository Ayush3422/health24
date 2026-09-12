import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createDb,
  withSystemContext,
  withTenant,
  type Db,
  type DbHandle,
  type DbTransaction,
} from './client';

export const DB_HANDLE = Symbol('DB_HANDLE');

/**
 * The only way application code reaches the database.
 *
 * There is no method here that runs an unscoped query by accident: callers
 * either name a hospital, or explicitly ask for system context. That is the
 * whole design — making the safe path the short one.
 */
@Injectable()
export class DatabaseService implements OnModuleDestroy {
  constructor(@Inject(DB_HANDLE) private readonly handle: DbHandle) {}

  /**
   * Escape hatch for tests and for the few places that need the raw pool.
   * Queries issued through this are still subject to row-level security, so a
   * mistake here returns nothing rather than everything.
   */
  get raw(): Db {
    return this.handle.db;
  }

  /** Runs a unit of work scoped to one hospital. */
  async asTenant<T>(hospitalId: string, fn: (tx: DbTransaction) => Promise<T>): Promise<T> {
    return withTenant(this.handle.db, hospitalId, fn);
  }

  /**
   * Runs a unit of work outside tenant scoping. See `withSystemContext` for
   * the four cases where this is legitimate.
   */
  async asSystem<T>(fn: (tx: DbTransaction) => Promise<T>): Promise<T> {
    return withSystemContext(this.handle.db, fn);
  }

  async onModuleDestroy(): Promise<void> {
    await this.handle.close();
  }
}

export const databaseProviders = [
  {
    provide: DB_HANDLE,
    inject: [ConfigService],
    useFactory: (config: ConfigService): DbHandle => {
      const url = config.getOrThrow<string>('DATABASE_URL');
      return createDb(url);
    },
  },
  DatabaseService,
];
