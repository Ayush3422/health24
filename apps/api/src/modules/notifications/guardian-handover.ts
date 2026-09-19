import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DatabaseService } from '../../db/database.service';
import { AuditService } from '../audit/audit.service';
import { SMS_SENDER, type SmsSender } from '../portal/sms';

/** How many hand-overs one run takes on; the next run takes the rest. */
const BATCH = 100;

export type HandoverOutcome = 'handed_over' | 'skipped';

/**
 * The hand-over at 18 (sp5-plan.md, Decision M1).
 *
 * A guardian's access ends by itself at the child's 18th birthday: sign-in and
 * every request check `ends_at`, so nothing waits on this job. What it does is
 * the rest — ends the guardian's sessions for that record, and tells the young
 * adult, once, on their own registered number, that they can now use the
 * portal themselves after activating it at a desk (Decision J1).
 *
 * Safe to run in several workers at once: each access is locked while it is
 * handed over, and one already handed over is skipped.
 */
@Injectable()
export class GuardianHandover {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    @Inject(SMS_SENDER) private readonly sms: SmsSender,
  ) {}

  /** Hands over every guardian access that has reached the child's 18th birthday. */
  async handOverDue(): Promise<number> {
    const due = await this.db.asSystem((tx) =>
      tx.execute<{ id: string }>(sql`
        SELECT "id" FROM "patient_portal_access"
         WHERE "relationship" = 'guardian' AND "ends_at" <= now()
           AND "handed_over_at" IS NULL AND "revoked_at" IS NULL
      ORDER BY "ends_at"
         LIMIT ${BATCH}
      `),
    );

    let handedOver = 0;

    for (const { id } of due) {
      if ((await this.handOver(id)) === 'handed_over') handedOver += 1;
    }

    return handedOver;
  }

  async handOver(accessId: string): Promise<HandoverOutcome> {
    const result = await this.db.asSystem(async (tx) => {
      const [access] = await tx.execute<{
        account_id: string;
        patient_id: string;
        patient_phone: string | null;
      }>(sql`
        SELECT p."account_id", p."patient_id", pt."phone" AS patient_phone
          FROM "patient_portal_access" p
          JOIN "patient" pt ON pt."id" = p."patient_id"
         WHERE p."id" = ${accessId}::uuid
           AND p."relationship" = 'guardian' AND p."ends_at" <= now()
           AND p."handed_over_at" IS NULL AND p."revoked_at" IS NULL
           FOR UPDATE OF p SKIP LOCKED
      `);

      if (!access) return null;

      await tx.execute(sql`
        UPDATE "patient_session"
           SET "revoked_at" = now(), "revoked_reason" = 'guardian access ended at 18'
         WHERE "account_id" = ${access.account_id}::uuid
           AND "patient_id" = ${access.patient_id}::uuid
           AND "revoked_at" IS NULL
      `);

      // Two parents are two guardian accesses: the young adult hears once.
      const [alreadyTold] = await tx.execute<{ id: string }>(sql`
        SELECT "id" FROM "patient_portal_access"
         WHERE "patient_id" = ${access.patient_id}::uuid AND "handed_over_at" IS NOT NULL
         LIMIT 1
      `);

      const told = Boolean(access.patient_phone) && !alreadyTold;

      if (told) {
        await this.sms.send({
          to: access.patient_phone!,
          body:
            'Health24: You are now 18, so your guardian can no longer open your health record ' +
            'in the Health24 portal. To use the portal yourself, ask at the front desk of a ' +
            'hospital where you are registered.',
          template: 'guardian_handover',
        });
      }

      await tx.execute(sql`
        UPDATE "patient_portal_access" SET "handed_over_at" = now()
         WHERE "id" = ${accessId}::uuid
      `);

      return { patientId: access.patient_id, told };
    });

    if (!result) return 'skipped';

    await this.audit.record({
      actorId: null,
      actorType: 'system',
      actorLabel: 'guardian hand-over at 18',
      hospitalId: null,
      patientId: result.patientId,
      resourceType: 'patient_portal_access',
      resourceId: accessId,
      action: 'update',
    });

    return 'handed_over';
  }
}
