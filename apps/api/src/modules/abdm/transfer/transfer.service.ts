import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { AbdmTransferStatus } from '@health24/shared';
import { DatabaseService } from '../../../db/database.service';
import { AuditService } from '../../audit/audit.service';
import { readExportRecord } from '../../exports/export-record';
import { GatewayClient } from '../gateway/gateway.client';
import { buildCareContextBundle } from './care-context-bundle';
import { agreeTransferKeys, encryptBundle, type TransferKeys } from './fidelius';

/**
 * Answering a request for a patient's records (sp8-plan.md, T23, T24, T25).
 *
 * One visit at a time, and that is not an implementation detail. Each care
 * context is assembled, encrypted and pushed on its own, and **the consent is
 * re-read before each one** — so a patient who withdraws their consent while
 * a transfer is running stops the rest of it. What has already gone cannot be
 * recalled, and the row this leaves behind says so rather than rounding the
 * outcome to "done" or "failed".
 *
 * Three things the database does rather than this code:
 *
 * - **Deciding what a bundle may contain.** Assembly runs in a context bound
 *   to one consent artefact (DF3), so a mistake here cannot widen a bundle —
 *   it can only ask for rows the policies have already decided it may see.
 * - **Refusing a withdrawn consent.** The check below is for stopping early
 *   and recording why; even without it, the context would return nothing.
 * - **Keeping the outcome honest.** The row's constraints refuse a transfer
 *   recorded as complete having sent nothing, or as refused having sent
 *   something.
 */

interface DataRequestRow extends Record<string, unknown> {
  id: string;
  consent_artefact_id: string;
  patient_id: string;
  hospital_id: string;
  abdm_transaction_id: string;
  data_push_url: string;
  requester_public_key: string;
  requester_nonce: string;
  status: AbdmTransferStatus;
  care_contexts_requested: number;
}

interface ArtefactRow extends Record<string, unknown> {
  in_force: boolean;
  care_context_ids: string[];
  grantee_abdm_hiu_id: string;
  grantee_abdm_hiu_name: string | null;
}

/** How long a push may take before it counts as a failure worth retrying. */
const PUSH_TIMEOUT_MS = 30_000;

@Injectable()
export class TransferService {
  private readonly logger = new Logger(TransferService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly gateway: GatewayClient,
  ) {}

  async transfer(dataRequestId: string): Promise<AbdmTransferStatus> {
    const request = await this.load(dataRequestId);

    if (!request) {
      this.logger.warn(`No data request with id ${dataRequestId}`);
      return 'failed';
    }

    if (request.status !== 'pending') {
      // Already settled. A queue that delivers twice must not transfer twice.
      return request.status;
    }

    const artefact = await this.artefact(request.consent_artefact_id);

    if (!artefact || !artefact.in_force) {
      return this.settle(request, 'refused', 0, 'The consent was not in force when the transfer began');
    }

    // One agreement for the whole transfer: the requester is told this
    // system's public key and nonce with every page, and the private half
    // never leaves `agreeTransferKeys` (DF7).
    const keys = agreeTransferKeys({
      publicKey: request.requester_public_key,
      nonce: request.requester_nonce,
    });

    const careContexts = artefact.care_context_ids;
    let sent = 0;
    let stoppedBecause: string | null = null;

    for (const [index, careContextReference] of careContexts.entries()) {
      // Re-read before every visit. This is the whole of T25.
      const stillInForce = await this.artefact(request.consent_artefact_id);

      if (!stillInForce?.in_force) {
        stoppedBecause = 'The consent was withdrawn while the transfer was running';
        this.logger.warn(
          `Stopping transfer ${request.id} after ${String(sent)} of ${String(careContexts.length)} visits: consent withdrawn`,
        );
        break;
      }

      const assembled = await this.assemble(request, careContextReference);

      if (!assembled) {
        // The consent admits nothing of this visit. Not an error, and not
        // something to tell the requester about: a bundle carrying only a
        // patient would say a visit exists and that they may see none of it.
        continue;
      }

      try {
        await this.push(request, keys, assembled.bundle, careContextReference, index + 1, careContexts.length);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);

        return sent > 0
          ? this.settle(request, 'partly_transferred', sent, `A push failed: ${reason}`)
          : this.settle(request, 'failed', 0, `A push failed: ${reason}`);
      }

      await this.recordWhatLeft(request, artefact, careContextReference, assembled.contents);
      sent += 1;
    }

    const status: AbdmTransferStatus = stoppedBecause
      ? sent > 0
        ? 'partly_transferred'
        : 'refused'
      : sent > 0
        ? 'transferred'
        : 'refused';

    const reason =
      stoppedBecause ?? (sent === 0 ? 'The consent admits nothing of these visits' : null);

    await this.notifyOutcome(request, status, sent);

    return this.settle(request, status, sent, reason);
  }

  /**
   * One visit, read under the consent and nothing else.
   *
   * The patient is read in the same context, which the assembly policy admits
   * for exactly the person the artefact is about.
   */
  private async assemble(request: DataRequestRow, careContextReference: string) {
    return this.db.asAbdmConsent(request.consent_artefact_id, async (tx) => {
      const record = await readExportRecord(tx, request.patient_id, {
        encounterId: careContextReference,
      });

      const visits = await tx.execute<{ class: string }>(sql`
        SELECT "class"::text AS class FROM "encounter" WHERE "id" = ${careContextReference}::uuid
      `);

      return buildCareContextBundle(
        record,
        careContextReference,
        // The encounter itself may be outside the consent's categories even
        // when its contents are not, so its kind is not always knowable here.
        visits[0]?.class ?? 'outpatient',
        new Date(),
      );
    });
  }

  /**
   * The push itself, straight to the requester's endpoint.
   *
   * Not through the gateway: ABDM has the data go directly, encrypted, and
   * the gateway is told only that it happened.
   */
  private async push(
    request: DataRequestRow,
    keys: TransferKeys,
    bundle: unknown,
    careContextReference: string,
    pageNumber: number,
    pageCount: number,
  ): Promise<void> {
    const content = encryptBundle(keys, bundle);

    const response = await fetch(request.data_push_url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
      body: JSON.stringify({
        pageNumber,
        pageCount,
        transactionId: request.abdm_transaction_id,
        entries: [
          {
            content,
            media: 'application/fhir+json',
            // ABDM's transport checksum, not a security control — what makes
            // the content unforgeable is the authentication tag inside it.
            checksum: createHash('md5').update(content).digest('hex'),
            careContextReference,
          },
        ],
        keyMaterial: {
          cryptoAlg: 'ECDH',
          curve: 'Curve25519',
          dhPublicKey: { keyValue: keys.ours.publicKey, parameters: 'Curve25519/32byte random key' },
          nonce: keys.ours.nonce,
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`the requester answered HTTP ${String(response.status)}`);
    }
  }

  /**
   * Every row that left, on the patient's trail (DF5).
   *
   * Attributed to the requester rather than to this system, and carrying the
   * artefact it rested on — so a patient asking "who has seen this" gets the
   * same kind of answer for a national requester as for a hospital.
   */
  private async recordWhatLeft(
    request: DataRequestRow,
    artefact: ArtefactRow,
    careContextReference: string,
    contents: Array<{ resourceType: string; id: string }>,
  ): Promise<void> {
    const label = `ABDM requester ${artefact.grantee_abdm_hiu_name ?? artefact.grantee_abdm_hiu_id}`;

    await this.audit.recordMany([
      {
        actorId: null,
        actorType: 'system',
        actorLabel: label,
        hospitalId: request.hospital_id,
        patientId: request.patient_id,
        resourceType: 'abdm_care_context',
        resourceId: careContextReference,
        consentArtefactId: request.consent_artefact_id,
        action: 'export',
      },
      ...contents.map((entry) => ({
        actorId: null,
        actorType: 'system' as const,
        actorLabel: label,
        hospitalId: request.hospital_id,
        patientId: request.patient_id,
        // The FHIR name, because that is what the requester received it as.
        resourceType: entry.resourceType,
        resourceId: entry.id,
        consentArtefactId: request.consent_artefact_id,
        action: 'read' as const,
      })),
    ]);
  }

  private async notifyOutcome(
    request: DataRequestRow,
    status: AbdmTransferStatus,
    sent: number,
  ): Promise<void> {
    await this.gateway.notify('health-information.notify', {
      notification: {
        consentId: request.consent_artefact_id,
        transactionId: request.abdm_transaction_id,
        doneAt: new Date().toISOString(),
        notifier: { type: 'HIP', id: request.hospital_id },
        statusNotification: {
          sessionStatus: status === 'transferred' ? 'TRANSFERRED' : 'PARTIALLY_TRANSFERRED',
          hipId: request.hospital_id,
          statusResponses: [{ careContextReference: null, hiStatus: 'OK', description: String(sent) }],
        },
      },
    });
  }

  private async settle(
    request: DataRequestRow,
    status: AbdmTransferStatus,
    sent: number,
    reason: string | null,
  ): Promise<AbdmTransferStatus> {
    await this.db.asSystem(async (tx) => {
      await tx.execute(sql`
        UPDATE "abdm_data_request"
           SET "status" = ${status}::abdm_transfer_status,
               "care_contexts_sent" = ${sent},
               "completed_at" = now(),
               "failure_reason" = ${reason}
         WHERE "id" = ${request.id}::uuid AND "status" = 'pending'
      `);
    });

    return status;
  }

  /**
   * Requests still pending long enough that nothing is coming for them.
   *
   * The sweep behind the queue (DF8). A lost job leaves a requester waiting
   * for records that will never arrive and nothing to say so, which is worse
   * than a transfer made late.
   */
  async stranded(olderThanMinutes = 5): Promise<string[]> {
    const rows = await this.db.asSystem(async (tx) =>
      tx.execute<{ id: string }>(sql`
        SELECT "id" FROM "abdm_data_request"
         WHERE "status" = 'pending'
           AND "created_at" < now() - make_interval(mins => ${olderThanMinutes})
      ORDER BY "created_at"
         LIMIT 50
      `),
    );

    return rows.map((row) => row.id);
  }

  private async load(id: string): Promise<DataRequestRow | null> {
    const rows = await this.db.asSystem(async (tx) =>
      tx.execute<DataRequestRow>(sql`
        SELECT "id", "consent_artefact_id", "patient_id", "hospital_id",
               "abdm_transaction_id", "data_push_url", "requester_public_key",
               "requester_nonce", "status"::text AS status, "care_contexts_requested"
          FROM "abdm_data_request" WHERE "id" = ${id}::uuid
      `),
    );

    return rows[0] ?? null;
  }

  /** The artefact as it stands **now**, which is the point of re-reading it. */
  private async artefact(id: string): Promise<ArtefactRow | null> {
    const rows = await this.db.asSystem(async (tx) =>
      tx.execute<ArtefactRow>(sql`
        SELECT ("status" = 'active' AND "expires_at" > now()) AS in_force,
               "abdm_care_context_ids" AS care_context_ids,
               "grantee_abdm_hiu_id", "grantee_abdm_hiu_name"
          FROM "consent_artefact" WHERE "id" = ${id}::uuid
      `),
    );

    return rows[0] ?? null;
  }
}
