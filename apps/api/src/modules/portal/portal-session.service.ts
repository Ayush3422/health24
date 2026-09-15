import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type {
  PortalPatientOption,
  PortalRelationship,
  PortalSessionIssued,
  PortalSessionSummary,
} from '@health24/shared';
import type { PatientActor } from '../../common/actor';
import { generateToken, hashToken } from '../../common/crypto';
import { toIso } from '../clinical/clinical-access';
import type { DbTransaction } from '../../db/client';
import { DatabaseService } from '../../db/database.service';
import { patientSessions } from '../../db/schema';

/** A portal access token's audience: no staff route accepts it (sp5-plan.md, DF3). */
export const PORTAL_TOKEN_AUDIENCE = 'health24-portal';
const SELECTION_AUDIENCE = 'health24-portal-selection';

interface PortalAccessPayload {
  /** The account. */
  sub: string;
  sid: string;
  pid: string;
}

interface SelectionPayload {
  sub: string;
  purpose: 'select_patient';
}

export interface SessionOrigin {
  ipAddress: string | null;
  userAgent: string | null;
}

/**
 * Portal sessions (SP5 Phase 1).
 *
 * As for staff: a short-lived access token, and an opaque refresh token stored
 * as a hash, rotated on every use, with a replayed token revoking every session
 * of the account. A session acts for one patient; switching patient issues a
 * new one. Sign-in and session checks run in system context, as staff sign-in
 * does — nothing identifies the caller until they succeed.
 */
@Injectable()
export class PortalSessionService {
  private readonly logger = new Logger(PortalSessionService.name);
  private readonly accessTtl: string;
  private readonly refreshTtlDays: number;

  constructor(
    private readonly db: DatabaseService,
    private readonly jwt: JwtService,
    config: ConfigService,
  ) {
    this.accessTtl = config.get<string>('JWT_ACCESS_TTL') ?? '15m';
    this.refreshTtlDays = Number(config.get<number>('REFRESH_TOKEN_TTL_DAYS') ?? 30);
  }

  // ---------------------------------------------------------------------------
  // Choosing a patient
  // ---------------------------------------------------------------------------

  signSelection(accountId: string): Promise<string> {
    return this.jwt.signAsync(
      { sub: accountId, purpose: 'select_patient' } satisfies SelectionPayload,
      { audience: SELECTION_AUDIENCE, expiresIn: '5m' },
    );
  }

  async verifySelection(token: string): Promise<string> {
    try {
      const payload = await this.jwt.verifyAsync<SelectionPayload>(token, {
        audience: SELECTION_AUDIENCE,
      });
      if (payload.purpose !== 'select_patient') throw new Error('wrong purpose');
      return payload.sub;
    } catch {
      throw new UnauthorizedException('Sign in again');
    }
  }

  patientOptions(accountId: string): Promise<PortalPatientOption[]> {
    return this.db.asSystem((tx) => this.patientsFor(tx, accountId));
  }

  // ---------------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------------

  async issue(
    accountId: string,
    patientId: string,
    origin: SessionOrigin,
  ): Promise<PortalSessionIssued & { sessionId: string }> {
    const refreshToken = generateToken(32);
    const expiresAt = new Date(Date.now() + this.refreshTtlDays * 86_400_000);

    const { sessionId, patient } = await this.db.asSystem(async (tx) => {
      const chosen = (await this.patientsFor(tx, accountId)).find(
        (option) => option.id === patientId.toLowerCase(),
      );

      if (!chosen) {
        throw new ForbiddenException('This phone has no portal access for that patient');
      }

      const id = uuidv7();
      await tx.insert(patientSessions).values({
        id,
        accountId,
        patientId: chosen.id,
        refreshTokenHash: hashToken(refreshToken),
        expiresAt,
        ipAddress: origin.ipAddress,
        userAgent: origin.userAgent,
      });

      return { sessionId: id, patient: chosen };
    });

    return {
      accessToken: await this.signAccess({ sub: accountId, sid: sessionId, pid: patient.id }),
      refreshToken,
      expiresAt: expiresAt.toISOString(),
      patient,
      sessionId,
    };
  }

  /** Exchanges a refresh token for a new pair, rotating it; a replay ends every session. */
  async rotate(refreshToken: string, origin: SessionOrigin): Promise<PortalSessionIssued> {
    let replayedBy: string | null = null;

    const outcome = await this.db.asSystem(async (tx) => {
      const [existing] = await tx.execute<{
        id: string;
        account_id: string;
        patient_id: string;
        expires_at: string | Date;
        revoked_at: string | Date | null;
        account_status: string;
      }>(sql`
        SELECT s."id", s."account_id", s."patient_id", s."expires_at", s."revoked_at",
               a."status" AS account_status
          FROM "patient_session" s
          JOIN "patient_account" a ON a."id" = s."account_id"
         WHERE s."refresh_token_hash" = ${hashToken(refreshToken)}
      `);

      if (!existing) throw new UnauthorizedException('Invalid refresh token');

      if (existing.revoked_at) {
        replayedBy = existing.account_id;
        return null;
      }

      if (new Date(existing.expires_at).getTime() <= Date.now()) {
        throw new UnauthorizedException('Session expired');
      }

      const patient = (await this.patientsFor(tx, existing.account_id)).find(
        (option) => option.id === existing.patient_id,
      );

      if (existing.account_status !== 'active' || !patient) {
        throw new UnauthorizedException('Portal access has ended');
      }

      await tx.execute(sql`
        UPDATE "patient_session" SET "revoked_at" = now(), "revoked_reason" = 'rotated'
         WHERE "id" = ${existing.id}::uuid
      `);

      const nextRefresh = generateToken(32);
      const expiresAt = new Date(Date.now() + this.refreshTtlDays * 86_400_000);
      const id = uuidv7();

      await tx.insert(patientSessions).values({
        id,
        accountId: existing.account_id,
        patientId: patient.id,
        refreshTokenHash: hashToken(nextRefresh),
        expiresAt,
        ipAddress: origin.ipAddress,
        userAgent: origin.userAgent,
      });

      return {
        accessToken: await this.signAccess({ sub: existing.account_id, sid: id, pid: patient.id }),
        refreshToken: nextRefresh,
        expiresAt: expiresAt.toISOString(),
        patient,
      };
    });

    if (replayedBy) {
      this.logger.warn(`Portal refresh token reuse for account ${replayedBy}; revoking all sessions`);
      await this.revokeAccount(replayedBy, 'refresh token reuse');
      throw new UnauthorizedException('Session revoked. Sign in again.');
    }

    return outcome!;
  }

  /**
   * Resolves a portal access token to the signed-in patient: the session still
   * live, the account active, and the access still in force — so a revoked
   * access or a lost phone takes effect at once, not when the token expires.
   */
  async authenticate(token: string): Promise<PatientActor> {
    let payload: PortalAccessPayload;

    try {
      payload = await this.jwt.verifyAsync<PortalAccessPayload>(token, {
        audience: PORTAL_TOKEN_AUDIENCE,
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }

    return this.db.asSystem(async (tx) => {
      const [session] = await tx.execute<{
        id: string;
        account_id: string;
        patient_id: string;
        expires_at: string | Date;
        revoked_at: string | Date | null;
        phone: string;
        account_status: string;
      }>(sql`
        SELECT s."id", s."account_id", s."patient_id", s."expires_at", s."revoked_at",
               a."phone", a."status" AS account_status
          FROM "patient_session" s
          JOIN "patient_account" a ON a."id" = s."account_id"
         WHERE s."id" = ${payload.sid}::uuid
      `);

      if (
        !session ||
        session.revoked_at ||
        new Date(session.expires_at).getTime() <= Date.now() ||
        session.account_id !== payload.sub ||
        session.patient_id !== payload.pid ||
        session.account_status !== 'active'
      ) {
        throw new UnauthorizedException('Session is no longer active');
      }

      const patient = (await this.patientsFor(tx, session.account_id)).find(
        (option) => option.id === session.patient_id,
      );

      if (!patient) throw new UnauthorizedException('Portal access has ended');

      await tx.execute(sql`
        UPDATE "patient_session" SET "last_used_at" = now()
         WHERE "id" = ${session.id}::uuid AND "last_used_at" < now() - interval '1 minute'
      `);

      return {
        accountId: session.account_id,
        patientId: session.patient_id,
        sessionId: session.id,
        relationship: patient.relationship,
        phone: session.phone,
      };
    });
  }

  async list(actor: PatientActor): Promise<PortalSessionSummary[]> {
    const rows = await this.db.asSystem((tx) =>
      tx.execute<{
        id: string;
        patient_name: string | null;
        issued_at: string | Date;
        last_used_at: string | Date;
        ip_address: string | null;
        user_agent: string | null;
      }>(sql`
        SELECT s."id", p."name" AS patient_name, s."issued_at", s."last_used_at",
               s."ip_address", s."user_agent"
          FROM "patient_session" s
          LEFT JOIN "patient" p ON p."id" = s."patient_id"
         WHERE s."account_id" = ${actor.accountId}::uuid
           AND s."revoked_at" IS NULL AND s."expires_at" > now()
      ORDER BY s."last_used_at" DESC
      `),
    );

    return [...rows].map((row) => ({
      id: row.id,
      patientName: row.patient_name,
      createdAt: toIso(row.issued_at),
      lastUsedAt: toIso(row.last_used_at),
      ipAddress: row.ip_address,
      userAgent: row.user_agent,
      current: row.id === actor.sessionId,
    }));
  }

  async revoke(actor: PatientActor, sessionId: string, reason: string): Promise<void> {
    const revoked = await this.db.asSystem((tx) =>
      tx.execute<{ id: string }>(sql`
        UPDATE "patient_session" SET "revoked_at" = now(), "revoked_reason" = ${reason}
         WHERE "id" = ${sessionId}::uuid AND "account_id" = ${actor.accountId}::uuid
           AND "revoked_at" IS NULL
     RETURNING "id"
      `),
    );

    if ([...revoked].length === 0) throw new NotFoundException('Session not found');
  }

  /** Ends every session acting for a patient on an account, when the desk revokes that access. */
  async revokeForAccess(accountId: string, patientId: string, reason: string): Promise<void> {
    await this.db.asSystem((tx) =>
      tx.execute(sql`
        UPDATE "patient_session" SET "revoked_at" = now(), "revoked_reason" = ${reason}
         WHERE "account_id" = ${accountId}::uuid AND "revoked_at" IS NULL
           AND "patient_id" = app.canonical_patient_id(${patientId}::uuid)
      `),
    );
  }

  private async revokeAccount(accountId: string, reason: string): Promise<void> {
    await this.db.asSystem((tx) =>
      tx.execute(sql`
        UPDATE "patient_session" SET "revoked_at" = now(), "revoked_reason" = ${reason}
         WHERE "account_id" = ${accountId}::uuid AND "revoked_at" IS NULL
      `),
    );
  }

  /** The patients an account may act for now, by their current record after any merge. */
  private async patientsFor(tx: DbTransaction, accountId: string): Promise<PortalPatientOption[]> {
    const rows = await tx.execute<{ id: string; name: string; relationship: PortalRelationship }>(sql`
      SELECT DISTINCT ON (c."id") c."id", c."name", p."relationship"
        FROM "patient_portal_access" p
        JOIN "patient" c ON c."id" = app.canonical_patient_id(p."patient_id")
       WHERE p."account_id" = ${accountId}::uuid AND p."revoked_at" IS NULL
         AND (p."ends_at" IS NULL OR p."ends_at" > now())
    ORDER BY c."id", p."relationship"
    `);

    return [...rows]
      .map((row) => ({ id: row.id, name: row.name, relationship: row.relationship }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private signAccess(payload: PortalAccessPayload): Promise<string> {
    return this.jwt.signAsync(payload, { audience: PORTAL_TOKEN_AUDIENCE, expiresIn: this.accessTtl });
  }
}
