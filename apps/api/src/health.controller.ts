import { Controller, Get } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DatabaseService } from './db/database.service';
import { Public } from './common/decorators';

@Controller('health')
export class HealthController {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Liveness and readiness in one.
   *
   * Actually queries the database rather than returning a static OK — a health
   * check that cannot fail is not a health check.
   */
  @Public()
  @Get()
  async check(): Promise<{ status: string; database: string; timestamp: string }> {
    let database = 'down';

    try {
      await this.db.raw.execute(sql`select 1`);
      database = 'up';
    } catch {
      database = 'down';
    }

    return {
      status: database === 'up' ? 'ok' : 'degraded',
      database,
      timestamp: new Date().toISOString(),
    };
  }
}
