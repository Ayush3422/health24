import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type {
  AbhaChallenge,
  AbhaIdentity,
  ConfirmAbhaVerificationInput,
  StartAbhaVerificationInput,
} from '@health24/shared';
import { requireHospital, type Actor, type RequestMeta } from '../../common/actor';
import { violatedConstraint } from '../../common/database-errors';
import { DatabaseService } from '../../db/database.service';
import { AuditService } from '../audit/audit.service';
import { ABHA_VERIFICATION, type AbhaVerificationPort } from './abha-verification.port';

interface AbhaRow extends Record<string, unknown> {
  abha_number: string | null;
  abha_address: string | null;
  /**
   * A raw query returns whatever the driver hands back, which for a
   * `timestamptz` is a string here and a `Date` elsewhere depending on how it
   * was asked for. Both are accepted rather than assumed.
   */
  abha_number_verified_at: Date | string | null;
  abha_address_verified_at: Date | string | null;
  abha_verification_method: AbhaIdentity['verificationMethod'];
}

const asIso = (value: Date | string | null): string | null => {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
};

/**
 * Confirming that an ABHA belongs to the patient at the desk
 * (sp8-plan.md, T2).
 *
 * Two steps, because a verification is a challenge and a response. The first
 * asks the registry to send a code; the second records the confirmation, and
 * only the second writes anything. A one-step "mark this ABHA verified" would
 * record a member of staff's assertion, and the whole reason these columns
 * exist is that an assertion is not what matching may treat as certainty.
 *
 * Neither step invents an identifier. Whatever the registry confirms is what
 * is written, through `app.record_abha_verification`, which stamps the time
 * itself so a verification cannot be back-dated.
 */
@Injectable()
export class AbhaService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    @Inject(ABHA_VERIFICATION) private readonly registry: AbhaVerificationPort,
  ) {}

  async startVerification(
    actor: Actor,
    patientId: string,
    input: StartAbhaVerificationInput,
    meta: RequestMeta,
  ): Promise<AbhaChallenge> {
    const hospitalId = requireHospital(actor);
    const current = await this.read(hospitalId, patientId);

    // A verified identifier is frozen by the database. Saying so here costs
    // one query and turns an unexplained refusal at the end of the flow into
    // a sentence before the patient is asked for a code.
    if (
      current.abha_number_verified_at &&
      input.abhaNumber &&
      input.abhaNumber !== current.abha_number
    ) {
      throw new ConflictException(
        'This patient already has a verified ABHA number, and a verified one cannot be replaced',
      );
    }

    if (
      current.abha_address_verified_at &&
      input.abhaAddress &&
      input.abhaAddress !== current.abha_address
    ) {
      throw new ConflictException(
        'This patient already has a verified ABHA address, and a verified one cannot be replaced',
      );
    }

    const challenge = await this.registry.requestChallenge({
      abhaNumber: input.abhaNumber ?? null,
      abhaAddress: input.abhaAddress ?? null,
      method: input.method,
    });

    // Asking the registry about a patient is a use of their identity, so it
    // is on the trail whether or not they go on to confirm. Recorded as a
    // read rather than an update, because at this point nothing has changed —
    // and an audit trail that says otherwise is not one.
    await this.audit.recordForActor(actor, {
      resourceType: 'patient',
      resourceId: patientId,
      patientId,
      action: 'read',
      meta,
    });

    return {
      transactionId: challenge.transactionId,
      sentTo: challenge.sentTo,
      expiresAt: challenge.expiresAt.toISOString(),
    };
  }

  async confirmVerification(
    actor: Actor,
    patientId: string,
    input: ConfirmAbhaVerificationInput,
    meta: RequestMeta,
  ): Promise<AbhaIdentity> {
    const hospitalId = requireHospital(actor);

    // Proves the patient is this hospital's to touch before anything is spent
    // on the registry.
    await this.read(hospitalId, patientId);

    const confirmed = await this.registry.confirmChallenge(input.transactionId, input.code);

    if (!confirmed.abhaNumber && !confirmed.abhaAddress) {
      throw new ServiceUnavailableException(
        'The registry confirmed the code but returned no ABHA. Nothing was recorded.',
      );
    }

    try {
      await this.db.asTenant(hospitalId, async (tx) => {
        await tx.execute(sql`
          SELECT app.record_abha_verification(
            ${patientId}::uuid,
            ${confirmed.abhaNumber}::text,
            ${confirmed.abhaAddress}::text,
            ${confirmed.method}::abha_verification_method,
            ${actor.staffUserId}::uuid
          )
        `);
      });
    } catch (error) {
      throw this.explain(error);
    }

    await this.audit.recordForActor(actor, {
      resourceType: 'patient',
      resourceId: patientId,
      patientId,
      action: 'update',
      meta,
    });

    return this.identity(await this.read(hospitalId, patientId));
  }

  /** The patient's ABHA as it stands, for the screen that shows it. */
  async currentIdentity(
    actor: Actor,
    patientId: string,
    meta: RequestMeta,
  ): Promise<AbhaIdentity> {
    const hospitalId = requireHospital(actor);
    const row = await this.read(hospitalId, patientId);

    await this.audit.recordForActor(actor, {
      resourceType: 'patient',
      resourceId: patientId,
      patientId,
      action: 'read',
      meta,
    });

    return this.identity(row);
  }

  private async read(hospitalId: string, patientId: string): Promise<AbhaRow> {
    const rows = await this.db.asTenant(hospitalId, async (tx) =>
      tx.execute<AbhaRow>(sql`
        SELECT "abha_number",
               "abha_address",
               "abha_number_verified_at",
               "abha_address_verified_at",
               "abha_verification_method"
          FROM "patient"
         WHERE "id" = ${patientId}::uuid
      `),
    );

    const row = rows[0];

    if (!row) {
      // The same answer a patient at another hospital gets, deliberately:
      // row-level security has already decided this caller cannot see them,
      // and "forbidden" would confirm the record exists.
      throw new NotFoundException('No patient found with that id');
    }

    return row;
  }

  private identity(row: AbhaRow): AbhaIdentity {
    return {
      abhaNumber: row.abha_number,
      abhaAddress: row.abha_address,
      numberVerifiedAt: asIso(row.abha_number_verified_at),
      addressVerifiedAt: asIso(row.abha_address_verified_at),
      verificationMethod: row.abha_verification_method,
      verified: Boolean(row.abha_number_verified_at ?? row.abha_address_verified_at),
    };
  }

  /**
   * The database's refusals, as sentences.
   *
   * The unique indexes are the interesting one: an ABHA already on another
   * record means either a duplicate patient or a mistake, and both are
   * somebody's decision rather than a 500.
   */
  private explain(error: unknown): unknown {
    const constraint = violatedConstraint(error);

    if (constraint === 'patient_abha_number_unique') {
      return new ConflictException(
        'Another patient record already holds that ABHA number. Resolve the duplicate first.',
      );
    }

    if (
      constraint === 'patient_abha_address_unique' ||
      constraint === 'patient_abha_address_lower_idx'
    ) {
      return new ConflictException(
        'Another patient record already holds that ABHA address. Resolve the duplicate first.',
      );
    }

    return error;
  }
}
