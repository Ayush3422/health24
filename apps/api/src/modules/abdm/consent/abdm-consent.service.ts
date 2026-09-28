import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DatabaseService } from '../../../db/database.service';
import { AuditService } from '../../audit/audit.service';
import { mapHiTypes } from './hi-type-mapping';

/**
 * A consent granted in the patient's own ABHA app, landing in the consent
 * model this system already has (sp8-plan.md, T17, T18, Decision Y1).
 *
 * The whole of Y1 is here: what arrives becomes a row in `consent_artefact`,
 * and from that moment `app.consent_permits` is the only thing that decides
 * what it reveals. Nothing in this file grants access; it writes down what
 * the patient agreed to, and the database does the rest.
 *
 * Three refusals, each of which is a way a consent could otherwise be wider
 * than the patient meant:
 *
 * - **A visit that is not linked here.** A consent naming care contexts this
 *   hospital never put on the network is either a mistake or somebody else's
 *   consent, and there is no version of it worth honouring.
 * - **Types that map to nothing.** Storing an artefact that grants nothing
 *   would leave the patient believing their records were flowing.
 * - **No expiry.** Expiry is a timestamp here rather than a status precisely
 *   so that nobody has to remember to end a consent; one without a date could
 *   never end.
 *
 * Redelivery is free: the consent manager's own id is unique on the table, so
 * the second notification writes nothing and answers the same way.
 */

export type ConsentNotificationStatus = 'GRANTED' | 'REVOKED' | 'EXPIRED';

export interface ConsentNotification {
  /** The facility the gateway named, from `X-HIP-ID`. */
  hipId: string;
  status: ConsentNotificationStatus;
  /** The consent manager's id for the artefact. */
  consentId: string;
  requester?: { id?: string; name?: string };
  careContextReferences?: string[];
  hiTypes?: string[];
  dateRange?: { from?: string; to?: string };
  /** When the requester must erase what it received: this artefact's end. */
  dataEraseAt?: string;
}

export type ConsentOutcome =
  | { written: true; consentArtefactId: string; narrowed: string[] }
  | { written: false; reason: 'already-known' };

@Injectable()
export class AbdmConsentService {
  private readonly logger = new Logger(AbdmConsentService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async notified(notification: ConsentNotification): Promise<ConsentOutcome | { withdrawn: true }> {
    if (notification.status === 'GRANTED') return this.grant(notification);

    // An expiry at the consent manager and a revocation are the same fact
    // here: the artefact is no longer in force. `expires_at` cannot move —
    // the guard freezes it, and rightly, since it is the evidence of what was
    // agreed — so both are recorded as a revocation with the reason given.
    return this.withdraw(
      notification.consentId,
      notification.status === 'EXPIRED'
        ? 'Expired at the consent manager'
        : 'Revoked at the consent manager',
    );
  }

  private async grant(notification: ConsentNotification): Promise<ConsentOutcome> {
    const hospital = await this.facility(notification.hipId);
    const { patientId, careContextIds } = await this.linkedVisits(
      hospital.id,
      notification.careContextReferences ?? [],
    );

    const mapped = mapHiTypes(notification.hiTypes ?? []);

    if (mapped.categories.length === 0) {
      throw new BadRequestException(
        'This consent asks only for information this system does not hold',
      );
    }

    if (!notification.dataEraseAt) {
      throw new BadRequestException('This consent has no end date');
    }

    const requester = notification.requester;

    if (!requester?.id) {
      throw new BadRequestException('This consent names no requester');
    }

    if (mapped.unmapped.length > 0) {
      // Not a refusal — the rest of the consent stands — but somebody has to
      // be able to see that it is narrower than what was asked for.
      this.logger.warn(
        `ABDM consent ${notification.consentId} asked for ${mapped.unmapped.join(', ')}, which this system does not hold`,
      );
    }

    // System context: the row names no grantee hospital, so there is no
    // tenant whose write this is. Migration 0036 admits system inserts for
    // exactly this kind of case, and nothing here is chosen by the caller —
    // every value below has been checked above.
    const rows = await this.db.asSystem(async (tx) =>
      tx.execute<{ id: string }>(sql`
        INSERT INTO "consent_artefact"
          ("patient_id", "source", "abdm_consent_id",
           "grantee_abdm_hiu_id", "grantee_abdm_hiu_name", "hip_hospital_id",
           "abdm_care_context_ids", "abdm_unmapped_types",
           "data_categories", "date_range_from", "date_range_to",
           "expires_at", "capture_method")
        VALUES (
          ${patientId}::uuid, 'abdm', ${notification.consentId},
          ${requester.id}, ${requester.name ?? null},
          ${hospital.id}::uuid,
          ${`{${careContextIds.join(',')}}`}::uuid[],
          ${mapped.unmapped.length > 0 ? `{${mapped.unmapped.map((type) => `"${type}"`).join(',')}}` : null}::text[],
          ${`{${mapped.categories.join(',')}}`}::clinical_data_category[],
          ${this.istDate(notification.dateRange?.from) ?? null}::date,
          ${this.istDate(notification.dateRange?.to) ?? null}::date,
          ${notification.dataEraseAt}::timestamptz,
          'abdm'
        )
        ON CONFLICT ("abdm_consent_id") DO NOTHING
        RETURNING "id"
      `),
    );

    const written = rows[0];

    if (!written) {
      // Redelivered. The specification allows it and networks guarantee it.
      this.logger.log(`ABDM consent ${notification.consentId} was already recorded`);
      return { written: false, reason: 'already-known' };
    }

    await this.audit.record({
      actorId: null,
      actorType: 'system',
      actorLabel: `ABDM consent manager (${requester.name ?? requester.id})`,
      hospitalId: hospital.id,
      patientId,
      resourceType: 'consent_artefact',
      resourceId: written.id,
      consentArtefactId: written.id,
      action: 'create',
    });

    return { written: true, consentArtefactId: written.id, narrowed: mapped.unmapped };
  }

  private async withdraw(consentId: string, reason: string): Promise<{ withdrawn: true }> {
    const rows = await this.db.asSystem(async (tx) =>
      tx.execute<{ id: string; patient_id: string; hip_hospital_id: string | null }>(sql`
        UPDATE "consent_artefact"
           SET "status" = 'revoked', "revoked_at" = now(), "revocation_reason" = ${reason}
         WHERE "abdm_consent_id" = ${consentId} AND "status" = 'active'
        RETURNING "id", "patient_id", "hip_hospital_id"
      `),
    );

    const row = rows[0];

    if (!row) {
      // Either already withdrawn — redelivery again — or a consent this
      // system never held. Both are answered the same way and neither is an
      // error worth failing the notification over.
      this.logger.log(`Nothing active to withdraw for ABDM consent ${consentId}`);
      return { withdrawn: true };
    }

    await this.audit.record({
      actorId: null,
      actorType: 'system',
      actorLabel: 'ABDM consent manager',
      hospitalId: row.hip_hospital_id,
      patientId: row.patient_id,
      resourceType: 'consent_artefact',
      resourceId: row.id,
      consentArtefactId: row.id,
      action: 'update',
    });

    return { withdrawn: true };
  }

  /**
   * The visits the consent names, and the one patient they belong to.
   *
   * Every reference must be a care context this facility currently has
   * linked. A consent over a visit that was never offered to the network, or
   * has since been withdrawn, is not a consent this system can act on.
   */
  private async linkedVisits(
    hospitalId: string,
    references: string[],
  ): Promise<{ patientId: string; careContextIds: string[] }> {
    if (references.length === 0) {
      throw new BadRequestException('This consent names no care contexts');
    }

    const rows = await this.db.asTenant(hospitalId, async (tx) =>
      tx.execute<{ encounter_id: string; patient_id: string }>(sql`
        SELECT "encounter_id", "patient_id"
          FROM "abdm_care_context"
         WHERE "encounter_id" = ANY (${`{${references.join(',')}}`}::uuid[])
           AND "hospital_id" = ${hospitalId}::uuid
           AND "status" = 'linked'
      `),
    );

    if (rows.length !== references.length) {
      throw new BadRequestException(
        'This consent names a visit that is not shared with ABDM by this facility',
      );
    }

    const patients = new Set(rows.map((row) => row.patient_id));

    if (patients.size !== 1) {
      // One artefact, one person. Anything else is a mistake on a scale that
      // must not be written down as though it were consent.
      throw new BadRequestException('This consent names visits of more than one patient');
    }

    return {
      patientId: [...patients][0]!,
      careContextIds: rows.map((row) => row.encounter_id),
    };
  }

  private async facility(hipId: string): Promise<{ id: string }> {
    const rows = await this.db.asSystem(async (tx) =>
      tx.execute<{ id: string }>(sql`
        SELECT "id" FROM "hospital" WHERE "hfr_id" = ${hipId} AND "status" = 'active'
      `),
    );

    const row = rows[0];
    if (!row) throw new NotFoundException('No facility is registered under that id');

    return row;
  }

  /**
   * The day an instant falls on, in India.
   *
   * The consent's range is compared against clinical dates, which this system
   * keeps in India Standard Time (S4). Taking the UTC date instead would move
   * the boundary by five and a half hours and quietly include or exclude a
   * day at each end.
   */
  private istDate(value: string | undefined): string | null {
    if (!value) return null;

    const at = new Date(value);
    if (Number.isNaN(at.getTime())) return null;

    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(at);
  }
}
