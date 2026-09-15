import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DatabaseService } from '../../db/database.service';
import { AuditService } from '../audit/audit.service';
import { SMS_SENDER, type SmsSender } from '../portal/sms';
import type { BreakGlassNotificationOutcome } from './notification-queue';

/** How far back the sweep looks for an emergency access whose patient was not told. */
const SWEEP_DAYS = 7;

const whenInIndia = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
});

/**
 * Tells a patient that a hospital took emergency access to their record
 * (sp5-plan.md, DF10): a text message to every phone with portal access to
 * the record, and `patient_notified_at` once the provider accepts one.
 *
 * The message names the hospital and the time, never the reason or anything
 * clinical: a text message is read by whoever holds the phone. The reason is
 * in the portal.
 *
 * Safe to run twice at once: the access is locked while its messages are sent,
 * and one already told is skipped. A failure part-way rolls back, so a retry may
 * send a second copy to a phone that already had one — better than none.
 */
@Injectable()
export class BreakGlassNotifier {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    @Inject(SMS_SENDER) private readonly sms: SmsSender,
  ) {}

  async notify(consentId: string): Promise<BreakGlassNotificationOutcome> {
    const result = await this.db.asSystem(async (tx) => {
      const [access] = await tx.execute<{
        patient_id: string;
        hospital_name: string | null;
        granted_at: string | Date;
      }>(sql`
        SELECT ca."patient_id", h."name" AS hospital_name, ca."granted_at"
          FROM "consent_artefact" ca
          LEFT JOIN "hospital_directory" h ON h."id" = ca."grantee_hospital_id"
         WHERE ca."id" = ${consentId}::uuid
           AND ca."capture_method"::text = 'break_glass'
           AND ca."patient_notified_at" IS NULL
           FOR UPDATE OF ca SKIP LOCKED
      `);

      if (!access) return { outcome: 'skipped' as const };

      const phones = await tx.execute<{ phone: string }>(sql`
        SELECT DISTINCT p."phone"
          FROM "patient_portal_access" p
         WHERE p."patient_id" = ANY (app.patient_record_ids(${access.patient_id}::uuid))
           AND p."revoked_at" IS NULL
           AND (p."ends_at" IS NULL OR p."ends_at" > now())
      `);

      if (phones.length === 0) return { outcome: 'no_phone' as const };

      const body =
        `Health24: ${access.hospital_name ?? 'A hospital'} opened your health record in an ` +
        `emergency on ${whenInIndia.format(new Date(access.granted_at))}. ` +
        'See who and why in the Health24 portal.';

      for (const { phone } of phones) {
        await this.sms.send({ to: phone, body, template: 'break_glass' });
      }

      await tx.execute(sql`
        UPDATE "consent_artefact" SET "patient_notified_at" = now()
         WHERE "id" = ${consentId}::uuid
      `);

      return { outcome: 'sent' as const, patientId: access.patient_id, messages: phones.length };
    });

    if (result.outcome === 'sent') {
      await this.audit.record({
        actorId: null,
        actorType: 'system',
        actorLabel: 'patient notification',
        hospitalId: null,
        patientId: result.patientId,
        resourceType: 'patient_notification',
        resourceId: consentId,
        action: 'create',
      });
    }

    return result.outcome;
  }

  /** Emergency accesses of the past week whose patient has not been told. */
  async pending(): Promise<string[]> {
    const rows = await this.db.asSystem((tx) =>
      tx.execute<{ id: string }>(sql`
        SELECT "id" FROM "consent_artefact"
         WHERE "capture_method"::text = 'break_glass'
           AND "patient_notified_at" IS NULL
           AND "granted_at" > now() - make_interval(days => ${SWEEP_DAYS})
      ORDER BY "granted_at"
      `),
    );

    return [...rows].map((row) => row.id);
  }
}
