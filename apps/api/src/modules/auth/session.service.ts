import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { and, eq, isNull, desc } from 'drizzle-orm';
import type { StaffRole } from '@health24/shared';
import { DatabaseService } from '../../db/database.service';
import { sessions, staffUsers } from '../../db/schema';
import { generateToken, hashToken } from '../../common/crypto';
import { jwtSecrets, verifyWithRotation } from '../../config/keys';

export interface IssuedSession {
  accessToken: string;
  refreshToken: string;
  sessionId: string;
  expiresAt: Date;
}

export interface AccessTokenPayload {
  sub: string;
  sid: string;
  role: StaffRole;
  hid: string | null;
}

export interface SessionOrigin {
  ipAddress: string | null;
  userAgent: string | null;
}

/** A staff access token's audience; the portal's is different (sp5-plan.md, DF3). */
export const STAFF_TOKEN_AUDIENCE = 'health24-staff';

/**
 * Session lifecycle.
 *
 * Access tokens are short-lived JWTs; refresh tokens are opaque, random, and
 * stored only as a hash. The reason for the split is revocation: a pure-JWT
 * design cannot revoke a session before the token expires, and "this device
 * was stolen, cut it off now" is not an optional feature in a system holding
 * patient records.
 */
@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);
  private readonly accessTtl: string;
  private readonly refreshTtlDays: number;

  constructor(
    private readonly db: DatabaseService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {
    this.accessTtl = config.get<string>('JWT_ACCESS_TTL') ?? '15m';
    this.refreshTtlDays = Number(config.get<number>('REFRESH_TOKEN_TTL_DAYS') ?? 30);
  }

  /**
   * Creates a session. Runs in system context because sessions are keyed to a
   * staff member, and the tenant context is derived from the session rather
   * than the other way round.
   */
  async issue(
    staffUser: { id: string; role: StaffRole; hospitalId: string | null },
    origin: SessionOrigin,
  ): Promise<IssuedSession> {
    const refreshToken = generateToken(32);
    const expiresAt = new Date(Date.now() + this.refreshTtlDays * 24 * 60 * 60 * 1000);

    const sessionId = await this.db.asSystem(async (tx) => {
      const [row] = await tx
        .insert(sessions)
        .values({
          staffUserId: staffUser.id,
          refreshTokenHash: hashToken(refreshToken),
          expiresAt,
          ipAddress: origin.ipAddress,
          userAgent: origin.userAgent,
        })
        .returning({ id: sessions.id });

      if (!row) {
        throw new Error('Failed to create session');
      }

      return row.id;
    });

    const accessToken = await this.signAccessToken({
      sub: staffUser.id,
      sid: sessionId,
      role: staffUser.role,
      hid: staffUser.hospitalId,
    });

    return { accessToken, refreshToken, sessionId, expiresAt };
  }

  private async signAccessToken(payload: AccessTokenPayload): Promise<string> {
    return this.jwt.signAsync(payload, { expiresIn: this.accessTtl, audience: STAFF_TOKEN_AUDIENCE });
  }

  async verifyAccessToken(token: string): Promise<AccessTokenPayload> {
    try {
      return await verifyWithRotation<AccessTokenPayload>(this.jwt, jwtSecrets(this.config), token, {
        audience: STAFF_TOKEN_AUDIENCE,
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }
  }

  /**
   * Exchanges a refresh token for a new pair, rotating the refresh token.
   *
   * Rotation means each refresh token is valid exactly once. Presenting one
   * that has already been used is the signature of a stolen token being
   * replayed — and since we cannot tell the thief from the victim, the safe
   * response is to revoke every session for that user and make them sign in
   * again.
   */
  async rotate(refreshToken: string, origin: SessionOrigin): Promise<IssuedSession> {
    const presentedHash = hashToken(refreshToken);

    // Reuse detection is handled AFTER the transaction, not inside it.
    //
    // Revoking sessions and then throwing from the same transaction rolls the
    // revocation back — the security response undone by its own error path.
    // So the transaction reports what it found, and the caller acts on it.
    let reuseByStaffId: string | null = null;

    const outcome = await this.db.asSystem(async (tx) => {
      const [existing] = await tx
        .select({
          id: sessions.id,
          staffUserId: sessions.staffUserId,
          expiresAt: sessions.expiresAt,
          revokedAt: sessions.revokedAt,
          role: staffUsers.role,
          hospitalId: staffUsers.hospitalId,
          userStatus: staffUsers.status,
        })
        .from(sessions)
        .innerJoin(staffUsers, eq(staffUsers.id, sessions.staffUserId))
        .where(eq(sessions.refreshTokenHash, presentedHash))
        .limit(1);

      if (!existing) {
        throw new UnauthorizedException('Invalid refresh token');
      }

      if (existing.revokedAt) {
        // Replay of an already-rotated token: either a stolen token being
        // used, or the legitimate user racing. We cannot tell which, so the
        // safe response is to cut off every session and make them sign in
        // again. Recorded here, executed once this transaction has committed.
        reuseByStaffId = existing.staffUserId;
        return null;
      }

      if (existing.expiresAt.getTime() <= Date.now()) {
        throw new UnauthorizedException('Session expired');
      }

      if (existing.userStatus !== 'active') {
        throw new UnauthorizedException('Account is not active');
      }

      // Retire the presented token and issue its successor.
      await tx
        .update(sessions)
        .set({ revokedAt: new Date(), revokedReason: 'rotated' })
        .where(eq(sessions.id, existing.id));

      const nextRefresh = generateToken(32);
      const expiresAt = new Date(Date.now() + this.refreshTtlDays * 24 * 60 * 60 * 1000);

      const [created] = await tx
        .insert(sessions)
        .values({
          staffUserId: existing.staffUserId,
          refreshTokenHash: hashToken(nextRefresh),
          expiresAt,
          ipAddress: origin.ipAddress,
          userAgent: origin.userAgent,
        })
        .returning({ id: sessions.id });

      if (!created) {
        throw new Error('Failed to rotate session');
      }

      const accessToken = await this.signAccessToken({
        sub: existing.staffUserId,
        sid: created.id,
        role: existing.role,
        hid: existing.hospitalId,
      });

      return { accessToken, refreshToken: nextRefresh, sessionId: created.id, expiresAt };
    });

    if (reuseByStaffId) {
      this.logger.warn(
        `Refresh token reuse detected for staff ${reuseByStaffId}; revoking all sessions`,
      );

      // Separate transaction, so it commits rather than being rolled back by
      // the rejection below.
      await this.revokeAllForStaff(reuseByStaffId, 'refresh_token_reuse');

      throw new UnauthorizedException('Session revoked; please sign in again');
    }

    if (!outcome) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    return outcome;
  }

  /** Confirms a session is still live. Called on every authenticated request. */
  async assertActive(sessionId: string): Promise<void> {
    const live = await this.db.asSystem(async (tx) => {
      const [row] = await tx
        .select({ id: sessions.id, expiresAt: sessions.expiresAt, revokedAt: sessions.revokedAt })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);

      return row;
    });

    if (!live || live.revokedAt || live.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException('Session is no longer valid');
    }
  }

  /** Which staff member a session belongs to. Used after a refresh rotation. */
  async staffIdForSession(sessionId: string): Promise<string> {
    const row = await this.db.asSystem(async (tx) => {
      const [found] = await tx
        .select({ staffUserId: sessions.staffUserId })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);

      return found;
    });

    if (!row) {
      throw new UnauthorizedException('Session not found');
    }

    return row.staffUserId;
  }

  async touch(sessionId: string): Promise<void> {
    await this.db.asSystem(async (tx) => {
      await tx.update(sessions).set({ lastUsedAt: new Date() }).where(eq(sessions.id, sessionId));
    });
  }

  async revoke(sessionId: string, reason = 'logout'): Promise<void> {
    await this.db.asSystem(async (tx) => {
      await tx
        .update(sessions)
        .set({ revokedAt: new Date(), revokedReason: reason })
        .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));
    });
  }

  async revokeAllForStaff(staffUserId: string, reason = 'logout_all'): Promise<void> {
    await this.db.asSystem(async (tx) => {
      await tx
        .update(sessions)
        .set({ revokedAt: new Date(), revokedReason: reason })
        .where(and(eq(sessions.staffUserId, staffUserId), isNull(sessions.revokedAt)));
    });
  }

  async listActive(staffUserId: string): Promise<
    Array<{
      id: string;
      createdAt: Date;
      lastUsedAt: Date;
      ipAddress: string | null;
      userAgent: string | null;
    }>
  > {
    return this.db.asSystem(async (tx) =>
      tx
        .select({
          id: sessions.id,
          createdAt: sessions.issuedAt,
          lastUsedAt: sessions.lastUsedAt,
          ipAddress: sessions.ipAddress,
          userAgent: sessions.userAgent,
        })
        .from(sessions)
        .where(and(eq(sessions.staffUserId, staffUserId), isNull(sessions.revokedAt)))
        .orderBy(desc(sessions.lastUsedAt)),
    );
  }
}
