import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../../db/database.service';
import { staffUsers } from '../../db/schema';
import { SessionService } from '../../modules/auth/session.service';
import { IS_PUBLIC_KEY } from '../decorators';
import type { Actor } from '../actor';

/**
 * Authenticates the request and attaches the actor.
 *
 * Registered globally, so authentication is the default and `@Public()` is the
 * exception. Every request costs one session check and one staff lookup —
 * deliberate, because it is what makes "revoke this session now" and "suspend
 * this account now" take effect immediately rather than whenever the access
 * token happens to expire.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    private readonly db: DatabaseService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
      actor?: Actor;
    }>();

    const token = this.extractBearerToken(request.headers.authorization);

    if (!token) {
      throw new UnauthorizedException('Authentication required');
    }

    const payload = await this.sessions.verifyAccessToken(token);

    // The token is signed and unexpired; that is not the same as the session
    // still being live.
    await this.sessions.assertActive(payload.sid);

    const staff = await this.db.asSystem(async (tx) => {
      const [row] = await tx
        .select({
          id: staffUsers.id,
          name: staffUsers.name,
          email: staffUsers.email,
          role: staffUsers.role,
          hospitalId: staffUsers.hospitalId,
          status: staffUsers.status,
        })
        .from(staffUsers)
        .where(eq(staffUsers.id, payload.sub))
        .limit(1);

      return row;
    });

    if (!staff || staff.status !== 'active') {
      throw new UnauthorizedException('Account is not active');
    }

    // Role and hospital come from the database, never from the token. A token
    // minted before a demotion must not carry the old role.
    request.actor = {
      staffUserId: staff.id,
      role: staff.role,
      hospitalId: staff.hospitalId,
      sessionId: payload.sid,
      name: staff.name,
      email: staff.email,
    };

    return true;
  }

  private extractBearerToken(header: string | string[] | undefined): string | null {
    const value = Array.isArray(header) ? header[0] : header;

    if (!value?.startsWith('Bearer ')) {
      return null;
    }

    const token = value.slice('Bearer '.length).trim();
    return token.length > 0 ? token : null;
  }
}
