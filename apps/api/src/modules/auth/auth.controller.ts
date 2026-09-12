import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  acceptInviteSchema,
  enrolTotpSchema,
  loginSchema,
  refreshSchema,
  verifyTotpSchema,
  type AcceptInviteInput,
  type EnrolTotpInput,
  type LoginInput,
  type RefreshInput,
  type SessionSummary,
  type VerifyTotpInput,
} from '@health24/shared';
import type { Request } from 'express';
import { CurrentActor, CurrentMeta, Public } from '../../common/decorators';
import { zodBody } from '../../common/zod-validation.pipe';
import type { Actor, RequestMeta } from '../../common/actor';
import { AuthService } from './auth.service';
import { SessionService } from './session.service';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
  ) {}

  /**
   * Step one of sign-in. Returns a challenge, never a session — credentials
   * alone are not enough to reach a patient record.
   */
  @Public()
  @Post('login')
  @HttpCode(200)
  /**
   * The rate limit is keyed by IP, and an entire hospital sits behind one NAT
   * address. At ten per minute, a morning shift change would lock staff out of
   * their own system — so this is set high enough to survive normal use and
   * only stops floods.
   *
   * Brute-force protection against a specific account does not live here: it
   * lives in the per-account failure counter and lockout in AuthService, which
   * is unaffected by how many colleagues are signing in at the same time.
   */
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async login(
    @Body(zodBody(loginSchema)) body: LoginInput,
    @CurrentMeta() meta: RequestMeta,
    @Req() req: Request,
  ) {
    return this.auth.login(body.email, body.password, this.origin(req), meta);
  }

  /** Step two, for an enrolled account. Accepts a TOTP or a recovery code. */
  @Public()
  @Post('mfa/verify')
  @HttpCode(200)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async verifyMfa(
    @Body(zodBody(verifyTotpSchema)) body: VerifyTotpInput,
    @CurrentMeta() meta: RequestMeta,
    @Req() req: Request,
  ) {
    return this.auth.verifyMfa(body.challengeToken, body.code, this.origin(req), meta);
  }

  /** Step two, first time: confirms the authenticator app is working. */
  @Public()
  @Post('mfa/enrol')
  @HttpCode(200)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async enrolMfa(
    @Body(zodBody(enrolTotpSchema)) body: EnrolTotpInput,
    @CurrentMeta() meta: RequestMeta,
    @Req() req: Request,
  ) {
    return this.auth.enrolMfa(body.challengeToken, body.code, this.origin(req), meta);
  }

  @Public()
  @Post('invite/accept')
  @HttpCode(204)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async acceptInvite(@Body(zodBody(acceptInviteSchema)) body: AcceptInviteInput): Promise<void> {
    await this.auth.acceptInvite(body.inviteToken, body.password);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Body(zodBody(refreshSchema)) body: RefreshInput,
    @CurrentMeta() meta: RequestMeta,
    @Req() req: Request,
  ) {
    return this.auth.refresh(body.refreshToken, this.origin(req), meta);
  }

  /** The authenticated caller. Used by the client to restore session state. */
  @Get('me')
  async me(@CurrentActor() actor: Actor) {
    return this.auth.describeStaffById(actor.staffUserId);
  }

  @Get('sessions')
  async listSessions(@CurrentActor() actor: Actor): Promise<SessionSummary[]> {
    const rows = await this.sessions.listActive(actor.staffUserId);

    return rows.map((row) => ({
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      lastUsedAt: row.lastUsedAt.toISOString(),
      ipAddress: row.ipAddress,
      userAgent: row.userAgent,
      isCurrent: row.id === actor.sessionId,
    }));
  }

  /** Signs out one device. A staff member can always revoke their own. */
  @Delete('sessions/:id')
  @HttpCode(204)
  async revokeSession(@CurrentActor() actor: Actor, @Param('id') id: string): Promise<void> {
    const own = await this.sessions.listActive(actor.staffUserId);

    if (!own.some((session) => session.id === id)) {
      // Do not confirm whether someone else's session id exists.
      return;
    }

    await this.sessions.revoke(id, 'revoked_by_user');
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@CurrentActor() actor: Actor): Promise<void> {
    await this.sessions.revoke(actor.sessionId, 'logout');
  }

  /** "Sign out everywhere" — what a clinician needs after losing a phone. */
  @Post('logout-all')
  @HttpCode(204)
  async logoutAll(@CurrentActor() actor: Actor): Promise<void> {
    await this.sessions.revokeAllForStaff(actor.staffUserId, 'logout_all');
  }

  private origin(req: Request) {
    return {
      ipAddress: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    };
  }
}
