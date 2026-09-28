import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DatabaseService } from '../../../db/database.service';

/**
 * Accepting a request for a patient's records (sp8-plan.md, T23).
 *
 * Deliberately small: it checks that the request rests on a consent this
 * system holds and that is in force, writes the row that will answer "what
 * left the building", and stops. The transfer itself is the worker's, because
 * assembling and encrypting a record is not work to do while a gateway waits.
 *
 * The key material is written down without ceremony because there is nothing
 * secret in it: a public key and a nonce. What encrypts a bundle is derived
 * from those and from this system's own ephemeral pair, in the worker, and is
 * never stored (DF7).
 */

export interface DataRequest {
  /** The facility the gateway named, from `X-HIP-ID`. */
  hipId: string;
  /** The gateway's id for this request. */
  transactionId: string;
  /** The consent manager's id for the artefact it rests on. */
  abdmConsentId: string;
  dataPushUrl: string;
  requesterPublicKey: string;
  requesterNonce: string;
}

@Injectable()
export class DataRequestService {
  private readonly logger = new Logger(DataRequestService.name);

  constructor(private readonly db: DatabaseService) {}

  async accept(request: DataRequest): Promise<{ dataRequestId: string; alreadyKnown: boolean }> {
    for (const [name, value] of Object.entries({
      transactionId: request.transactionId,
      dataPushUrl: request.dataPushUrl,
      requesterPublicKey: request.requesterPublicKey,
      requesterNonce: request.requesterNonce,
    })) {
      if (!value) throw new BadRequestException(`This data request has no ${name}`);
    }

    const hospital = await this.facility(request.hipId);
    const artefact = await this.artefact(request.abdmConsentId, hospital.id);

    if (!artefact.in_force) {
      // Refused outright rather than accepted and failed later: the requester
      // is told now, and nothing is written that suggests a transfer is
      // coming.
      throw new BadRequestException('That consent is not in force');
    }

    const rows = await this.db.asSystem(async (tx) =>
      tx.execute<{ id: string }>(sql`
        INSERT INTO "abdm_data_request"
          ("consent_artefact_id", "patient_id", "hospital_id", "abdm_transaction_id",
           "data_push_url", "requester_public_key", "requester_nonce",
           "care_contexts_requested")
        VALUES (
          ${artefact.id}::uuid, ${artefact.patient_id}::uuid, ${hospital.id}::uuid,
          ${request.transactionId}, ${request.dataPushUrl},
          ${request.requesterPublicKey}, ${request.requesterNonce},
          ${artefact.care_context_count}
        )
        ON CONFLICT ("abdm_transaction_id") DO NOTHING
        RETURNING "id"
      `),
    );

    const written = rows[0];

    if (written) return { dataRequestId: written.id, alreadyKnown: false };

    // Redelivered. The existing row is the answer, and the transfer it
    // already produced is not repeated.
    this.logger.log(`Data request ${request.transactionId} was already accepted`);

    const existing = await this.db.asSystem(async (tx) =>
      tx.execute<{ id: string }>(sql`
        SELECT "id" FROM "abdm_data_request"
         WHERE "abdm_transaction_id" = ${request.transactionId}
      `),
    );

    return { dataRequestId: existing[0]!.id, alreadyKnown: true };
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
   * The artefact, **at this facility**.
   *
   * A consent covering another hospital's visits is not this one's to answer
   * with, even though both are on this platform and the row is one query
   * away.
   */
  private async artefact(
    abdmConsentId: string,
    hospitalId: string,
  ): Promise<{ id: string; patient_id: string; in_force: boolean; care_context_count: number }> {
    const rows = await this.db.asSystem(async (tx) =>
      tx.execute<{
        id: string;
        patient_id: string;
        in_force: boolean;
        care_context_count: number;
      }>(sql`
        SELECT "id", "patient_id",
               ("status" = 'active' AND "expires_at" > now()) AS in_force,
               coalesce(array_length("abdm_care_context_ids", 1), 0) AS care_context_count
          FROM "consent_artefact"
         WHERE "abdm_consent_id" = ${abdmConsentId}
           AND "hip_hospital_id" = ${hospitalId}::uuid
      `),
    );

    const row = rows[0];
    if (!row) throw new NotFoundException('This facility holds no such consent');

    return { ...row, care_context_count: Number(row.care_context_count) };
  }
}
