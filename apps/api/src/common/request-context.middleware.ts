import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import type { RequestMeta } from './actor';

/**
 * Attaches per-request metadata used by the audit trail.
 *
 * The request ID correlates every audit row written while serving one request,
 * which is what turns a flat log into something you can actually follow when
 * answering "what happened here?".
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: Request & { meta?: RequestMeta }, res: Response, next: NextFunction): void {
    const incoming = req.headers['x-request-id'];
    const requestId = (Array.isArray(incoming) ? incoming[0] : incoming) ?? randomUUID();

    req.meta = {
      requestId,
      ipAddress: this.clientIp(req),
      userAgent: req.headers['user-agent'] ?? null,
      route: `${req.method} ${req.originalUrl.split('?')[0]}`,
    };

    res.setHeader('x-request-id', requestId);
    next();
  }

  /**
   * Behind a load balancer the socket address is the balancer's. Express
   * populates `req.ip` from X-Forwarded-For only when `trust proxy` is set,
   * which `main.ts` does for deployed environments.
   */
  private clientIp(req: Request): string | null {
    return req.ip ?? req.socket.remoteAddress ?? null;
  }
}
