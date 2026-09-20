import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type {
  DecideErasureInput,
  ErasureOutcome,
  ErasureQueueItem,
  ErasureRequestSummary,
  RequestErasureInput,
} from '@health24/shared';
import type { Actor, PatientActor, RequestMeta } from '../../common/actor';
import { maskPhone } from '../../common/phone';
import type { DbTransaction } from '../../db/client';
import { DatabaseService } from '../../db/database.service';
import { erasureRequests } from '../../db/schema';
import { AuditService } from '../audit/audit.service';
import { toIso } from '../clinical/clinical-access';
import { SMS_SENDER, type SmsSender } from '../portal/sms';

/** What the patient is told when their request is decided, since an erasure ends their portal access. */
const OUTCOME_SAID: Record<ErasureOutcome, string> = {
  erased: 'has been carried out',
  partly_erased: 'has been carried out in part; some records are kept by law',
  refused: 'was refused',
};

type ErasureRow = {
  id: string;
  patient_id: string;
  reason: string | null;
  status: ErasureRequestSummary['status'];
  created_at: string | Date;
  decided_at: string | Date | null;
  decided_by_staff_id: string | null;
  outcome: ErasureOutcome | null;
  retention_note: string | null;
  erased_summary: string | null;
};

/** With who asked and who decided — readable only in system context, where the officer works. */
type ErasureOfficerRow = ErasureRow & {
  requested_by_phone: string;
  decided_by_name: string | null;
};

const REQUEST_COLUMNS = sql`
  e."id", e."patient_id", e."reason", e."status", e."created_at", e."decided_at",
  e."decided_by_staff_id", e."outcome", e."retention_note", e."erased_summary"
`;

/** What the patient reads of their own request: accounts and staff are not theirs to read. */
const ERASURE_SELECT = sql`SELECT ${REQUEST_COLUMNS} FROM "erasure_request" e`;

const OFFICER_SELECT = sql`
  SELECT ${REQUEST_COLUMNS}, a."phone" AS requested_by_phone, s."name" AS decided_by_name
    FROM "erasure_request" e
    JOIN "patient_account" a ON a."id" = e."requested_by_account_id"
    LEFT JOIN "staff_user" s ON s."id" = e."decided_by_staff_id"
`;

const ERASURE_REASON = 'Erasure decided under the DPDP Act';

/**
 * Erasure requests (sp5-plan.md, Decision N1).
 *
 * Clinical records are kept as law requires — they are never deleted, here or
 * anywhere (SP3 S3). What an erasure ends is everything around them that is
 * the patient's to end: the portal account and its sessions, the emergency
 * card, consents in force, and the contact details a hospital holds for
 * reaching them.
 *
 * Consent artefacts themselves are revoked rather than removed: an artefact is
 * the record of what was shared and when, and deleting it would erase the
 * patient's own evidence of it. The decision says so, and the patient reads it.
 *
 * Health24's data-protection officer decides, in system context — they belong
 * to no hospital, and they never read the record a request is about.
 */
@Injectable()
export class ErasureService {
  private readonly logger = new Logger(ErasureService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    @Inject(SMS_SENDER) private readonly sms: SmsSender,
  ) {}

  // ---------------------------------------------------------------------------
  // The patient, in the portal
  // ---------------------------------------------------------------------------

  async request(
    patient: PatientActor,
    input: RequestErasureInput,
    meta: RequestMeta,
  ): Promise<ErasureRequestSummary> {
    const row = await this.db.asPatient(patient.patientId, async (tx) => {
      const [pending] = await tx.execute<{ id: string }>(sql`
        SELECT "id" FROM "erasure_request"
         WHERE "patient_id" = ANY (app.patient_record_ids(${patient.patientId}::uuid))
           AND "status" = 'pending'
         LIMIT 1
      `);

      if (pending) {
        throw new ConflictException('Your request is already with the data-protection officer');
      }

      const [created] = await tx
        .insert(erasureRequests)
        .values({
          patientId: patient.patientId,
          requestedByAccountId: patient.accountId,
          reason: input.reason ?? null,
        })
        .returning({ id: erasureRequests.id });

      if (!created) throw new Error('Failed to record the request');

      return this.load(tx, created.id);
    });

    await this.audit.recordForPatient(patient, {
      resourceType: 'erasure_request',
      resourceId: row.id,
      action: 'create',
      meta,
    });

    return this.toSummary(row);
  }

  async mine(patient: PatientActor, meta: RequestMeta): Promise<ErasureRequestSummary[]> {
    const rows = await this.db.asPatient(patient.patientId, async (tx) => [
      ...(await tx.execute<ErasureRow>(sql`
        ${ERASURE_SELECT}
         WHERE e."patient_id" = ANY (app.patient_record_ids(${patient.patientId}::uuid))
      ORDER BY e."created_at" DESC
      `)),
    ]);

    await this.audit.recordForPatient(patient, {
      resourceType: 'erasure_request',
      action: 'search',
      meta,
    });

    return rows.map((row) => this.toSummary(row));
  }

  // ---------------------------------------------------------------------------
  // The data-protection officer
  // ---------------------------------------------------------------------------

  async queue(actor: Actor, meta: RequestMeta): Promise<ErasureQueueItem[]> {
    const rows = await this.db.asSystem(async (tx) => [
      ...(await tx.execute<ErasureOfficerRow>(sql`
        ${OFFICER_SELECT}
         WHERE e."status" = 'pending' OR e."decided_at" > now() - interval '90 days'
      ORDER BY e."status" <> 'pending', e."created_at"
         LIMIT 200
      `)),
    ]);

    await this.audit.recordForActor(actor, {
      resourceType: 'erasure_request',
      action: 'search',
      meta,
    });

    return rows.map((row) => this.toQueueItem(row));
  }

  /**
   * Records the decision and, unless it is a refusal, carries out the erasure:
   * the portal account, its sessions, the emergency card, consents in force
   * and the contact details held for reaching the patient.
   */
  async decide(
    actor: Actor,
    requestId: string,
    input: DecideErasureInput,
    meta: RequestMeta,
  ): Promise<ErasureQueueItem> {
    const row = await this.db.asSystem(async (tx) => {
      const current = await this.loadForOfficer(tx, requestId);

      if (current.status !== 'pending') {
        throw new ConflictException('This request has already been decided');
      }

      const summary =
        input.outcome === 'refused' ? null : await this.erase(tx, current.patient_id, actor);

      const updated = await tx.execute<{ id: string }>(sql`
        UPDATE "erasure_request"
           SET "status" = 'decided', "decided_at" = now(),
               "decided_by_staff_id" = ${actor.staffUserId}::uuid,
               "outcome" = ${input.outcome}, "retention_note" = ${input.retentionNote},
               "erased_summary" = ${summary}
         WHERE "id" = ${requestId}::uuid AND "status" = 'pending'
     RETURNING "id"
      `);

      if ([...updated].length === 0) {
        throw new ConflictException('This request was decided a moment ago');
      }

      return this.loadForOfficer(tx, requestId);
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'erasure_request',
      resourceId: requestId,
      patientId: row.patient_id,
      action: 'update',
      meta,
    });

    // An erasure ends the portal account, so the decision cannot wait there to
    // be read: the patient is told on the number that asked.
    await this.sms
      .send({
        to: row.requested_by_phone,
        body:
          `Health24: your request to erase your data ${OUTCOME_SAID[input.outcome]}. ` +
          'Ask at the front desk of a hospital where you are registered for the full decision.',
        template: 'erasure',
      })
      .catch((error: unknown) =>
        this.logger.error(`Could not tell the patient of erasure ${requestId}: ${String(error)}`),
      );

    return this.toQueueItem(row);
  }

  /** Ends everything around the clinical record, and says what was ended. */
  private async erase(tx: DbTransaction, patientId: string, actor: Actor): Promise<string> {
    const ids = sql`app.patient_record_ids(${patientId}::uuid)`;

    const accesses = await tx.execute<{ account_id: string }>(sql`
      UPDATE "patient_portal_access"
         SET "revoked_at" = now(), "revoked_by_staff_id" = ${actor.staffUserId}::uuid,
             "revoked_reason" = ${ERASURE_REASON}
       WHERE "patient_id" = ANY (${ids}) AND "revoked_at" IS NULL
   RETURNING "account_id"
    `);

    const sessions = await tx.execute<{ id: string }>(sql`
      UPDATE "patient_session"
         SET "revoked_at" = now(), "revoked_reason" = ${ERASURE_REASON}
       WHERE "patient_id" = ANY (${ids}) AND "revoked_at" IS NULL
   RETURNING "id"
    `);

    // An account with no access left to any patient is of no further use.
    const accountIds = [...new Set([...accesses].map((row) => row.account_id))];

    if (accountIds.length > 0) {
      await tx.execute(sql`
        UPDATE "patient_account" SET "status" = 'deactivated'
         WHERE "id" IN (${sql.join(
           accountIds.map((id) => sql`${id}::uuid`),
           sql`, `,
         )})
           AND NOT EXISTS (
             SELECT 1 FROM "patient_portal_access" p
              WHERE p."account_id" = "patient_account"."id" AND p."revoked_at" IS NULL
           )
      `);
    }

    const cards = await tx.execute<{ id: string }>(sql`
      UPDATE "emergency_card" c
         SET "revoked_at" = now(), "revoked_by_account_id" = c."created_by_account_id"
       WHERE c."patient_id" = ANY (${ids}) AND c."revoked_at" IS NULL
   RETURNING c."id"
    `);

    const consents = await tx.execute<{ id: string }>(sql`
      UPDATE "consent_artefact"
         SET "status" = 'revoked', "revoked_at" = now(), "revocation_reason" = ${ERASURE_REASON}
       WHERE "patient_id" = ANY (${ids}) AND "status" = 'active'
         AND "capture_method"::text <> 'break_glass'
   RETURNING "id"
    `);

    const [before] = await tx.execute<{
      phone: string | null;
      emergency_contact_name: string | null;
      emergency_contact_phone: string | null;
      address: string | null;
    }>(sql`
      SELECT "phone", "emergency_contact_name", "emergency_contact_phone", "address"::text AS address
        FROM "patient" WHERE "id" = ${patientId}::uuid
    `);

    await tx.execute(sql`
      UPDATE "patient"
         SET "phone" = NULL, "address" = NULL, "emergency_contact_name" = NULL,
             "emergency_contact_phone" = NULL, "updated_at" = now()
       WHERE "id" = ${patientId}::uuid
    `);

    // The change history keeps what changed, as every demographic correction does.
    for (const [field, value] of [
      ['phone', before?.phone ?? null],
      ['address', before?.address ?? null],
      ['emergency_contact_name', before?.emergency_contact_name ?? null],
      ['emergency_contact_phone', before?.emergency_contact_phone ?? null],
    ] as const) {
      if (value === null) continue;

      await tx.execute(sql`
        INSERT INTO "patient_demographic_change"
          ("patient_id", "changed_by_staff_id", "hospital_id", "field", "old_value", "new_value", "reason")
        VALUES (${patientId}::uuid, ${actor.staffUserId}::uuid, NULL, ${field}, ${value}, NULL, ${ERASURE_REASON})
      `);
    }

    return [
      `Portal access ended: ${[...accesses].length}`,
      `portal sessions ended: ${[...sessions].length}`,
      `emergency cards turned off: ${[...cards].length}`,
      `consents in force revoked: ${[...consents].length}`,
      'contact details cleared from the patient record',
      'clinical records kept, as law requires; consent artefacts kept as the record of what was shared',
    ].join('; ');
  }

  private async load(tx: DbTransaction, requestId: string): Promise<ErasureRow> {
    const [row] = await tx.execute<ErasureRow>(sql`
      ${ERASURE_SELECT} WHERE e."id" = ${requestId}::uuid
    `);

    if (!row) throw new NotFoundException('Erasure request not found');

    return row;
  }

  private async loadForOfficer(tx: DbTransaction, requestId: string): Promise<ErasureOfficerRow> {
    const [row] = await tx.execute<ErasureOfficerRow>(sql`
      ${OFFICER_SELECT} WHERE e."id" = ${requestId}::uuid
    `);

    if (!row) throw new NotFoundException('Erasure request not found');

    return row;
  }

  private toSummary(row: ErasureRow): ErasureRequestSummary {
    return {
      id: row.id,
      status: row.status,
      reason: row.reason,
      createdAt: toIso(row.created_at),
      decidedAt: row.decided_at ? toIso(row.decided_at) : null,
      outcome: row.outcome,
      retentionNote: row.retention_note,
      erasedSummary: row.erased_summary,
    };
  }

  private toQueueItem(row: ErasureOfficerRow): ErasureQueueItem {
    return {
      ...this.toSummary(row),
      patientId: row.patient_id,
      requestedByPhone: maskPhone(row.requested_by_phone),
      decidedBy: row.decided_by_staff_id
        ? { id: row.decided_by_staff_id, name: row.decided_by_name }
        : null,
    };
  }
}
