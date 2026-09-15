import { createHmac, randomInt } from 'node:crypto';
import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { OTP_TTL_SECONDS } from '@health24/shared';
import { safeEqual } from '../../common/crypto';
import type { DbTransaction } from '../../db/client';
import { DatabaseService } from '../../db/database.service';
import { otpChallenges } from '../../db/schema';
import { SMS_SENDER, type SmsSender } from './sms';

export const OTP_MAX_ATTEMPTS = 5;
export const OTP_REQUESTS_PER_WINDOW = 3;
export const OTP_WINDOW_MINUTES = 15;

/**
 * One-time sign-in codes for the patient portal (sp5-plan.md, DF1).
 *
 * A code is six digits, valid for five minutes and five attempts, and stored
 * only as a keyed hash: six digits hashed without a key would be recovered
 * from a leaked table in a second. Every request creates a challenge, whether
 * or not the number has portal access, and the SMS goes only to numbers that
 * do — so the answer, and the per-number limit, are the same for a patient's
 * number and a stranger's.
 */
@Injectable()
export class OtpService {
  private readonly key: string;

  constructor(
    private readonly db: DatabaseService,
    @Inject(SMS_SENDER) private readonly sms: SmsSender,
    config: ConfigService,
  ) {
    this.key = config.getOrThrow<string>('JWT_ACCESS_SECRET');
  }

  async request(phone: string, ipAddress: string | null): Promise<void> {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');

    // Pre-authentication: nothing identifies a patient yet.
    const deliver = await this.db.asSystem(async (tx) => {
      const [recent] = await tx.execute<{ count: number }>(sql`
        SELECT count(*)::int AS count FROM "otp_challenge"
         WHERE "phone" = ${phone}
           AND "created_at" > now() - make_interval(mins => ${OTP_WINDOW_MINUTES})
      `);

      if ((recent?.count ?? 0) >= OTP_REQUESTS_PER_WINDOW) {
        throw new HttpException(
          'Too many codes were requested for this number. Try again in a few minutes.',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      const id = uuidv7();
      await tx.insert(otpChallenges).values({
        id,
        phone,
        codeHash: this.hash(id, code),
        expiresAt: new Date(Date.now() + OTP_TTL_SECONDS * 1000),
        ipAddress,
      });

      return (await this.activeAccountId(tx, phone)) !== null;
    });

    if (deliver) {
      await this.sms.send({
        to: phone,
        template: 'otp',
        body: `${code} is your Health24 sign-in code. It expires in 5 minutes. Never share it with anyone.`,
      });
    }
  }

  /**
   * Spends the latest code for a number and returns the account it signs in
   * to. A wrong, expired or used code, and a number without access, get the
   * same refusal; a failed attempt counts even so.
   */
  async verify(phone: string, code: string): Promise<string> {
    const accountId = await this.db.asSystem(async (tx) => {
      const [challenge] = await tx.execute<{ id: string; code_hash: string; attempts: number }>(sql`
        SELECT "id", "code_hash", "attempts" FROM "otp_challenge"
         WHERE "phone" = ${phone} AND "consumed_at" IS NULL AND "expires_at" > now()
      ORDER BY "created_at" DESC
         LIMIT 1
           FOR UPDATE
      `);

      if (!challenge || challenge.attempts >= OTP_MAX_ATTEMPTS) return null;

      const matches = safeEqual(challenge.code_hash, this.hash(challenge.id, code));
      const spent = matches || challenge.attempts + 1 >= OTP_MAX_ATTEMPTS;

      await tx.execute(sql`
        UPDATE "otp_challenge"
           SET "attempts" = "attempts" + 1,
               "consumed_at" = ${spent ? sql`now()` : sql`NULL`}
         WHERE "id" = ${challenge.id}::uuid
      `);

      if (!matches) return null;

      const account = await this.activeAccountId(tx, phone);
      if (account) {
        await tx.execute(sql`
          UPDATE "patient_account" SET "last_login_at" = now() WHERE "id" = ${account}::uuid
        `);
      }

      return account;
    });

    if (!accountId) {
      throw new UnauthorizedException('That code is wrong or has expired. Request a new one.');
    }

    return accountId;
  }

  /** An active account with at least one patient it may act for now. */
  private async activeAccountId(tx: DbTransaction, phone: string): Promise<string | null> {
    const [account] = await tx.execute<{ id: string }>(sql`
      SELECT a."id" FROM "patient_account" a
       WHERE a."phone" = ${phone} AND a."status" = 'active'
         AND EXISTS (
           SELECT 1 FROM "patient_portal_access" p
            WHERE p."account_id" = a."id" AND p."revoked_at" IS NULL
              AND (p."ends_at" IS NULL OR p."ends_at" > now())
         )
    `);

    return account?.id ?? null;
  }

  private hash(challengeId: string, code: string): string {
    return createHmac('sha256', this.key).update(`otp:${challengeId}:${code}`).digest('base64url');
  }
}
