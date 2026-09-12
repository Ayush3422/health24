import { BadRequestException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { eq } from 'drizzle-orm';
import type { AuthenticatedStaff } from '@health24/shared';
import { DatabaseService } from '../../db/database.service';
import { hospitals, staffUsers } from '../../db/schema';
import { hashToken } from '../../common/crypto';
import type { RequestMeta } from '../../common/actor';
import { AuditService } from '../audit/audit.service';
import { PasswordService } from './password.service';
import { lockedUntilFor, secondsRemaining } from './lockout';
import { SessionService, type SessionOrigin } from './session.service';
import { TotpService } from './totp.service';

/** Issued after correct credentials, spent on the second factor. Short-lived. */
interface ChallengePayload {
  sub: string;
  purpose: 'mfa_verify' | 'mfa_enrol';
}

export type LoginResult =
  | { status: 'mfa_required'; challengeToken: string }
  | {
      status: 'mfa_enrolment_required';
      challengeToken: string;
      otpauthUrl: string;
      secret: string;
    };

export interface AuthenticatedResult {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  staff: AuthenticatedStaff;
  /** Present only immediately after enrolment. Shown once, never again. */
  recoveryCodes?: string[];
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  private static readonly CHALLENGE_TTL = '5m';

  constructor(
    private readonly db: DatabaseService,
    private readonly passwords: PasswordService,
    private readonly totp: TotpService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Step one: verify the password.
   *
   * Never returns a session. Credentials alone do not open a patient record —
   * the second factor is mandatory, and a user who has not yet enrolled one is
   * routed into enrolment rather than being waved through.
   */
  async login(
    email: string,
    password: string,
    origin: SessionOrigin,
    meta: RequestMeta,
  ): Promise<LoginResult> {
    // Pre-authentication lookup: we do not yet know which hospital this is, so
    // it cannot be tenant-scoped.
    const staff = await this.db.asSystem(async (tx) => {
      const [row] = await tx.select().from(staffUsers).where(eq(staffUsers.email, email)).limit(1);

      return row;
    });

    if (!staff) {
      // Equalise timing so a missing account and a wrong password are
      // indistinguishable, and the endpoint cannot be used to enumerate staff.
      await this.passwords.fakeVerify();
      await this.auditFailure(null, email, meta);
      throw new UnauthorizedException('Invalid email or password');
    }

    if (staff.lockedUntil && staff.lockedUntil.getTime() > Date.now()) {
      const wait = secondsRemaining(staff.lockedUntil);
      await this.auditFailure(staff.id, email, meta, 'account_locked');

      // The wait is stated, because the alternative — a flat "account locked"
      // — sends a clinician to ring IT when they could have waited four
      // seconds.
      throw new UnauthorizedException(
        `Too many failed attempts. Try again in ${wait} second${wait === 1 ? '' : 's'}.`,
      );
    }

    if (staff.status === 'invited' || !staff.passwordHash) {
      await this.auditFailure(staff.id, email, meta, 'invite_not_accepted');
      throw new UnauthorizedException('Please accept your invitation before signing in');
    }

    if (staff.status !== 'active') {
      await this.auditFailure(staff.id, email, meta, 'account_inactive');
      throw new UnauthorizedException('Account is not active');
    }

    const correct = await this.passwords.verify(staff.passwordHash, password);

    if (!correct) {
      await this.registerFailedAttempt(staff.id, staff.failedLoginAttempts);
      await this.auditFailure(staff.id, email, meta, 'bad_password');
      throw new UnauthorizedException('Invalid email or password');
    }

    await this.clearFailedAttempts(staff.id);

    // Enrolled already: ask for the code.
    if (staff.totpEnrolledAt && staff.totpSecretEncrypted) {
      return {
        status: 'mfa_required',
        challengeToken: await this.signChallenge(staff.id, 'mfa_verify'),
      };
    }

    // Not enrolled: issue a fresh secret and require enrolment now.
    const enrolment = this.totp.createEnrolment(`${staff.email}`);

    await this.db.asSystem(async (tx) => {
      await tx
        .update(staffUsers)
        .set({ totpSecretEncrypted: enrolment.secretEncrypted, updatedAt: new Date() })
        .where(eq(staffUsers.id, staff.id));
    });

    return {
      status: 'mfa_enrolment_required',
      challengeToken: await this.signChallenge(staff.id, 'mfa_enrol'),
      otpauthUrl: enrolment.otpauthUrl,
      secret: enrolment.secretForDisplay,
    };
  }

  /** Step two, for an already-enrolled user. Accepts a TOTP or a recovery code. */
  async verifyMfa(
    challengeToken: string,
    code: string,
    origin: SessionOrigin,
    meta: RequestMeta,
  ): Promise<AuthenticatedResult> {
    const staffId = await this.consumeChallenge(challengeToken, 'mfa_verify');
    const staff = await this.loadStaff(staffId);

    if (!staff.totpSecretEncrypted || !staff.totpEnrolledAt) {
      throw new BadRequestException('No second factor is enrolled for this account');
    }

    const isSixDigit = /^\d{6}$/.test(code.trim());
    let accepted = false;

    if (isSixDigit) {
      accepted = this.totp.verify(staff.totpSecretEncrypted, code.trim());
    } else {
      const result = await this.totp.consumeRecoveryCode(staff.recoveryCodeHashes ?? [], code);

      if (result.matched) {
        accepted = true;
        await this.db.asSystem(async (tx) => {
          await tx
            .update(staffUsers)
            .set({ recoveryCodeHashes: result.remaining, updatedAt: new Date() })
            .where(eq(staffUsers.id, staff.id));
        });

        this.logger.warn(
          `Recovery code used for staff ${staff.id}; ${result.remaining.length} left`,
        );
      }
    }

    if (!accepted) {
      await this.registerFailedAttempt(staff.id, staff.failedLoginAttempts);
      await this.auditFailure(staff.id, staff.email, meta, 'bad_mfa_code');
      throw new UnauthorizedException('Incorrect code');
    }

    return this.completeLogin(staff.id, origin, meta);
  }

  /** Step two, for a user enrolling a second factor for the first time. */
  async enrolMfa(
    challengeToken: string,
    code: string,
    origin: SessionOrigin,
    meta: RequestMeta,
  ): Promise<AuthenticatedResult> {
    const staffId = await this.consumeChallenge(challengeToken, 'mfa_enrol');
    const staff = await this.loadStaff(staffId);

    if (!staff.totpSecretEncrypted) {
      throw new BadRequestException('Start enrolment by signing in again');
    }

    if (!this.totp.verify(staff.totpSecretEncrypted, code.trim())) {
      await this.auditFailure(staff.id, staff.email, meta, 'bad_enrolment_code');
      throw new UnauthorizedException('Incorrect code — check your authenticator app');
    }

    const recovery = await this.totp.createRecoveryCodes();

    await this.db.asSystem(async (tx) => {
      await tx
        .update(staffUsers)
        .set({
          totpEnrolledAt: new Date(),
          recoveryCodeHashes: recovery.hashes,
          updatedAt: new Date(),
        })
        .where(eq(staffUsers.id, staff.id));
    });

    const result = await this.completeLogin(staff.id, origin, meta);

    return { ...result, recoveryCodes: recovery.plaintext };
  }

  /** Accepts an invitation: sets the password and activates the account. */
  async acceptInvite(inviteToken: string, password: string): Promise<void> {
    const tokenHash = hashToken(inviteToken);

    const staff = await this.db.asSystem(async (tx) => {
      const [row] = await tx
        .select()
        .from(staffUsers)
        .where(eq(staffUsers.inviteTokenHash, tokenHash))
        .limit(1);

      return row;
    });

    if (!staff || !staff.inviteExpiresAt || staff.inviteExpiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException('This invitation is invalid or has expired');
    }

    const problems = this.passwords.validate(password, { email: staff.email, name: staff.name });

    if (problems.length > 0) {
      throw new BadRequestException({ message: 'Password is not acceptable', errors: problems });
    }

    const passwordHash = await this.passwords.hash(password);

    await this.db.asSystem(async (tx) => {
      await tx
        .update(staffUsers)
        .set({
          passwordHash,
          status: 'active',
          inviteTokenHash: null,
          inviteExpiresAt: null,
          updatedAt: new Date(),
        })
        .where(eq(staffUsers.id, staff.id));
    });

    await this.audit.record({
      actorId: staff.id,
      actorType: 'staff',
      actorLabel: `${staff.name} <${staff.email}>`,
      hospitalId: staff.hospitalId,
      resourceType: 'staff_user',
      resourceId: staff.id,
      action: 'update',
    });
  }

  async refresh(
    refreshToken: string,
    origin: SessionOrigin,
    meta: RequestMeta,
  ): Promise<AuthenticatedResult> {
    const issued = await this.sessions.rotate(refreshToken, origin);
    const staffId = await this.sessions.staffIdForSession(issued.sessionId);
    const staff = await this.loadStaff(staffId);

    await this.audit.record({
      actorId: staff.id,
      actorType: 'staff',
      actorLabel: `${staff.name} <${staff.email}>`,
      hospitalId: staff.hospitalId,
      resourceType: 'session',
      resourceId: issued.sessionId,
      action: 'login',
      meta,
    });

    return {
      accessToken: issued.accessToken,
      refreshToken: issued.refreshToken,
      expiresAt: issued.expiresAt.toISOString(),
      staff: await this.describeStaff(staff),
    };
  }

  private async completeLogin(
    staffId: string,
    origin: SessionOrigin,
    meta: RequestMeta,
  ): Promise<AuthenticatedResult> {
    const staff = await this.loadStaff(staffId);

    const issued = await this.sessions.issue(
      { id: staff.id, role: staff.role, hospitalId: staff.hospitalId },
      origin,
    );

    await this.db.asSystem(async (tx) => {
      await tx
        .update(staffUsers)
        .set({ lastLoginAt: new Date(), failedLoginAttempts: 0, lockedUntil: null })
        .where(eq(staffUsers.id, staff.id));
    });

    await this.audit.record({
      actorId: staff.id,
      actorType: 'staff',
      actorLabel: `${staff.name} <${staff.email}>`,
      hospitalId: staff.hospitalId,
      resourceType: 'session',
      resourceId: issued.sessionId,
      action: 'login',
      meta,
    });

    return {
      accessToken: issued.accessToken,
      refreshToken: issued.refreshToken,
      expiresAt: issued.expiresAt.toISOString(),
      staff: await this.describeStaff(staff),
    };
  }

  /** Loads and describes a staff member. Backs `GET /auth/me`. */
  async describeStaffById(staffId: string): Promise<AuthenticatedStaff> {
    return this.describeStaff(await this.loadStaff(staffId));
  }

  async describeStaff(staff: {
    id: string;
    name: string;
    email: string;
    role: AuthenticatedStaff['role'];
    hospitalId: string | null;
    systemOfMedicine: AuthenticatedStaff['systemOfMedicine'];
    totpEnrolledAt: Date | null;
  }): Promise<AuthenticatedStaff> {
    const hospitalName = staff.hospitalId
      ? await this.db.asSystem(async (tx) => {
          const [row] = await tx
            .select({ name: hospitals.name })
            .from(hospitals)
            .where(eq(hospitals.id, staff.hospitalId as string))
            .limit(1);

          return row?.name ?? null;
        })
      : null;

    return {
      id: staff.id,
      name: staff.name,
      email: staff.email,
      role: staff.role,
      hospitalId: staff.hospitalId,
      hospitalName,
      systemOfMedicine: staff.systemOfMedicine,
      mfaEnrolled: staff.totpEnrolledAt !== null,
    };
  }

  private async loadStaff(staffId: string) {
    const staff = await this.db.asSystem(async (tx) => {
      const [row] = await tx.select().from(staffUsers).where(eq(staffUsers.id, staffId)).limit(1);
      return row;
    });

    if (!staff) {
      throw new UnauthorizedException('Account not found');
    }

    return staff;
  }

  private async signChallenge(staffId: string, purpose: ChallengePayload['purpose']) {
    return this.jwt.signAsync({ sub: staffId, purpose } satisfies ChallengePayload, {
      expiresIn: AuthService.CHALLENGE_TTL,
    });
  }

  private async consumeChallenge(
    token: string,
    expected: ChallengePayload['purpose'],
  ): Promise<string> {
    let payload: ChallengePayload;

    try {
      payload = await this.jwt.verifyAsync<ChallengePayload>(token);
    } catch {
      throw new UnauthorizedException('Your sign-in attempt expired; please start again');
    }

    if (payload.purpose !== expected) {
      throw new UnauthorizedException('Invalid sign-in step');
    }

    return payload.sub;
  }

  /**
   * Records a failed attempt and applies backoff.
   *
   * The delay grows exponentially rather than jumping to a fixed lockout. See
   * `lockout.ts` for why: a hard lock on a known email address is a
   * denial-of-service against a named clinician, and in a hospital that has
   * consequences beyond annoyance.
   */
  private async registerFailedAttempt(staffId: string, current: number): Promise<void> {
    const attempts = current + 1;
    const lockedUntil = lockedUntilFor(attempts);

    await this.db.asSystem(async (tx) => {
      await tx
        .update(staffUsers)
        .set({ failedLoginAttempts: attempts, lockedUntil, updatedAt: new Date() })
        .where(eq(staffUsers.id, staffId));
    });

    if (lockedUntil) {
      this.logger.warn(
        `Staff ${staffId}: ${attempts} consecutive failures, backing off until ${lockedUntil.toISOString()}`,
      );
    }
  }

  private async clearFailedAttempts(staffId: string): Promise<void> {
    await this.db.asSystem(async (tx) => {
      await tx
        .update(staffUsers)
        .set({ failedLoginAttempts: 0, lockedUntil: null })
        .where(eq(staffUsers.id, staffId));
    });
  }

  private async auditFailure(
    staffId: string | null,
    email: string,
    meta: RequestMeta,
    reason = 'unknown_account',
  ): Promise<void> {
    await this.audit.record({
      actorId: staffId,
      actorType: 'staff',
      // The attempted identity matters even when no account matched.
      actorLabel: email,
      hospitalId: null,
      resourceType: 'session',
      resourceId: reason,
      action: 'login_failed',
      outcome: 'denied',
      meta,
    });
  }
}
