import { Controller, Get, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { Public } from '../common/decorators';
import { ReadinessService, type Readiness } from './readiness.service';

/**
 * The three questions an operator asks a process (sp7-plan.md, T8, DF6).
 *
 * `/health` — are you alive? Answered without touching anything else, because
 * a process that is up but whose database is down must not be restarted for
 * it: restarting will not fix the database and will lose what is in flight.
 *
 * `/ready` — may I send you traffic? Answered by asking every dependency, and
 * with a 503 when any of them is down, which is what a load balancer reads.
 *
 * `/version` — what is running? The single most useful line during an
 * incident, and the one most often missing.
 *
 * All three are public and hold nothing about a patient.
 */
@Controller()
export class HealthController {
  private readonly startedAt = Date.now();

  constructor(
    private readonly readiness: ReadinessService,
    private readonly config: ConfigService,
  ) {}

  @Public()
  @Get('health')
  live(): { status: 'ok'; uptimeSeconds: number } {
    return { status: 'ok', uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000) };
  }

  @Public()
  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response): Promise<Readiness> {
    const readiness = await this.readiness.check();

    // 503 rather than 200-with-a-flag: a load balancer reads the status code.
    if (!readiness.ready) res.status(503);

    return readiness;
  }

  @Public()
  @Get('version')
  version(): { version: string; commit: string; builtAt: string; environment: string } {
    return {
      version: process.env.npm_package_version ?? '0.1.0',
      commit: this.config.get<string>('BUILD_SHA') ?? 'unknown',
      builtAt: this.config.get<string>('BUILD_TIME') ?? 'unknown',
      environment: this.config.get<string>('NODE_ENV') ?? 'development',
    };
  }
}
