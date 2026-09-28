import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sql } from 'drizzle-orm';
import type { AbdmLinkInitiator } from '@health24/shared';
import { requireHospital, type Actor, type RequestMeta } from '../../../common/actor';
import { maskPhone } from '../../../common/phone';
import { DatabaseService } from '../../../db/database.service';
import { AuditService } from '../../audit/audit.service';
import { SMS_SENDER, type SmsSender } from '../../portal/sms';
import { AbdmConfig } from '../abdm.config';
import { throughGateway } from '../gateway/failures';
import { GatewayClient } from '../gateway/gateway.client';
import { careContextDisplay } from './care-context-display';

/**
 * Linking a patient's visits to their ABHA (sp8-plan.md, T12, T13).
 *
 * Two directions, and the difference between them is who sends the code:
 *
 * - **The desk offers.** A member of staff, with the patient in front of
 *   them, asks to link some visits. The gateway sends the patient a code and
 *   the desk enters what they read out.
 * - **The patient asks.** They find this hospital from their own health app,
 *   the network asks us what we hold (`DiscoveryService`), and then asks us
 *   to link what they chose. Here **this system** sends the code, to the
 *   number on the record, because there is no member of staff involved and
 *   nothing else proves the person in the app is the person in the record.
 *
 * In both, nothing is linked until a code comes back. A link exposes a
 * visit's existence to the national network, which is a decision that belongs
 * to the patient and to nobody else — least of all to whoever is at the
 * keyboard.
 */

/**
 * A uuid array, as a parameter Postgres will accept.
 *
 * Passing a JavaScript array straight into a template and casting it —
 * `${ids}::uuid[]` — binds something the driver will not turn into an array,
 * and the query fails at the database rather than in review. The literal form
 * is explicit, and the values are still bound rather than interpolated.
 */
function uuidArray(ids: string[]) {
  return sql`${`{${ids.join(',')}}`}::uuid[]`;
}

const LINK_CODE_TTL_MINUTES = 10;
const MAX_ATTEMPTS = 5;

export interface VisitLinkState {
  encounterId: string;
  startedAt: string;
  display: string;
  /** Null when the visit has never been linked. */
  careContextId: string | null;
  status: 'linked' | 'unlinked' | null;
  linkedAt: string | null;
}

interface PatientForLinking extends Record<string, unknown> {
  id: string;
  name: string;
  phone: string | null;
  abha_address: string | null;
  abha_address_verified_at: Date | string | null;
}

@Injectable()
export class LinkingService {
  private readonly logger = new Logger(LinkingService.name);
  private readonly key: string;

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly config: AbdmConfig,
    private readonly gateway: GatewayClient,
    @Inject(SMS_SENDER) private readonly sms: SmsSender,
    env: ConfigService,
  ) {
    this.key = env.getOrThrow<string>('JWT_ACCESS_SECRET');
  }

  // --- What the hospital can see -------------------------------------------

  /** Every visit this hospital holds for the patient, and whether it is shared. */
  async listVisits(actor: Actor, patientId: string, meta: RequestMeta): Promise<VisitLinkState[]> {
    const hospitalId = requireHospital(actor);
    const hospitalName = await this.hospitalName(hospitalId);

    const rows = await this.db.asTenant(hospitalId, async (tx) =>
      tx.execute<{
        id: string;
        started_at: string;
        class: string;
        care_context_id: string | null;
        status: string | null;
        linked_at: string | null;
      }>(sql`
        SELECT e."id", e."started_at", e."class"::text AS class,
               c."id" AS care_context_id, c."status"::text AS status,
               c."linked_at"
          FROM "encounter" e
          LEFT JOIN "abdm_care_context" c ON c."encounter_id" = e."id"
         WHERE e."patient_id" = ANY (app.patient_record_ids(${patientId}::uuid))
           AND e."hospital_id" = ${hospitalId}
           AND e."status" <> 'cancelled'
      ORDER BY e."started_at" DESC
      `),
    );

    await this.audit.recordForActor(actor, {
      resourceType: 'abdm_care_context',
      patientId,
      action: 'read',
      meta,
    });

    return rows.map((row) => ({
      encounterId: row.id,
      startedAt: new Date(row.started_at).toISOString(),
      display: careContextDisplay({
        startedAt: row.started_at,
        class: row.class,
        hospitalName,
      }),
      careContextId: row.care_context_id,
      status: row.status as VisitLinkState['status'],
      linkedAt: row.linked_at ? new Date(row.linked_at).toISOString() : null,
    }));
  }

  // --- The desk offers ------------------------------------------------------

  async offerLink(
    actor: Actor,
    patientId: string,
    encounterIds: string[],
    meta: RequestMeta,
  ): Promise<{ linkRequestId: string; expiresAt: string; sentTo: string | null }> {
    const hospitalId = requireHospital(actor);
    const patient = await this.patientForLinking(hospitalId, patientId);
    const abhaAddress = this.requireVerifiedAbha(patient);

    await this.assertLinkable(hospitalId, patientId, encounterIds);

    const expiresAt = new Date(Date.now() + LINK_CODE_TTL_MINUTES * 60_000);

    const [request] = await this.db.asTenant(hospitalId, async (tx) =>
      tx.execute<{ id: string }>(sql`
        INSERT INTO "abdm_link_request"
          ("patient_id", "hospital_id", "abha_address", "initiated_by",
           "encounter_ids", "expires_at", "requested_by_staff_id")
        VALUES (${patientId}::uuid, ${hospitalId}::uuid, ${abhaAddress}, 'hospital',
                ${uuidArray(encounterIds)}, ${expiresAt.toISOString()},
                ${actor.staffUserId}::uuid)
        RETURNING "id"
      `),
    );

    if (!request) throw new Error('The linking request was not written');

    const careContexts = await this.displaysFor(hospitalId, encounterIds);

    // The gateway sends the code, and tells us what it sent it to. If this
    // throws, the request stays pending and expires on its own — nothing has
    // been linked and nothing needs undoing.
    const hipId = await this.hipIdFor(hospitalId);

    const answer = await throughGateway(() =>
      this.gateway.call<{ transactionId?: string; sentTo?: string }>(
        'care-context.link.init',
        {
          patient: {
            id: abhaAddress,
            referenceNumber: patientId,
            display: patient.name,
            careContexts,
          },
        },
        { hipId },
      ),
    );

    await this.db.asTenant(hospitalId, async (tx) => {
      await tx.execute(sql`
        UPDATE "abdm_link_request"
           SET "transaction_id" = ${answer.transactionId ?? null}
         WHERE "id" = ${request.id}::uuid
      `);
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'abdm_link_request',
      resourceId: request.id,
      patientId,
      action: 'create',
      meta,
    });

    return {
      linkRequestId: request.id,
      expiresAt: expiresAt.toISOString(),
      sentTo: answer.sentTo ?? null,
    };
  }

  async confirmOffer(
    actor: Actor,
    patientId: string,
    input: { linkRequestId: string; code: string },
    meta: RequestMeta,
  ): Promise<VisitLinkState[]> {
    const hospitalId = requireHospital(actor);
    const request = await this.pendingRequest(hospitalId, input.linkRequestId, patientId);

    // The gateway holds this challenge, so the code goes to it rather than
    // being checked here. A refusal comes back as its own exception.
    const hipId = await this.hipIdFor(hospitalId);

    await throughGateway(() =>
      this.gateway.call(
        'care-context.link.confirm',
        { confirmation: { linkRefNumber: request.transaction_id, token: input.code } },
        { hipId },
      ),
    );

    await this.completeRequest(hospitalId, request, 'hospital', actor.staffUserId);

    await this.audit.recordForActor(actor, {
      resourceType: 'abdm_link_request',
      resourceId: request.id,
      patientId,
      action: 'update',
      meta,
    });

    return this.listVisits(actor, patientId, meta);
  }

  // --- The patient asks, through their own app ------------------------------

  /**
   * The network asks us to link what the patient chose, so we send them a
   * code. Returns what the gateway should tell the app to expect.
   */
  async beginPatientLink(input: {
    hipId: string;
    patientReference: string;
    encounterIds: string[];
  }): Promise<{ linkRequestId: string; expiresAt: Date; hint: string | null }> {
    const hospital = await this.facility(input.hipId);
    const patient = await this.patientForLinking(hospital.id, input.patientReference);
    const abhaAddress = this.requireVerifiedAbha(patient);

    await this.assertLinkable(hospital.id, input.patientReference, input.encounterIds);

    if (!patient.phone) {
      // Nothing else in the record proves the person holding the app is the
      // person in it, so the link cannot be offered at all.
      throw new ConflictException('No mobile number on the record to send a code to');
    }

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const expiresAt = new Date(Date.now() + LINK_CODE_TTL_MINUTES * 60_000);

    const [request] = await this.db.asTenant(hospital.id, async (tx) =>
      tx.execute<{ id: string }>(sql`
        INSERT INTO "abdm_link_request"
          ("patient_id", "hospital_id", "abha_address", "initiated_by",
           "encounter_ids", "expires_at")
        VALUES (${input.patientReference}::uuid, ${hospital.id}::uuid, ${abhaAddress}, 'patient',
                ${uuidArray(input.encounterIds)}, ${expiresAt.toISOString()})
        RETURNING "id"
      `),
    );

    if (!request) throw new Error('The linking request was not written');

    await this.db.asTenant(hospital.id, async (tx) => {
      await tx.execute(sql`
        UPDATE "abdm_link_request" SET "code_hash" = ${this.hash(request.id, code)}
         WHERE "id" = ${request.id}::uuid
      `);
    });

    await this.sms.send({
      to: patient.phone,
      template: 'abdm_link',
      body: `${code} is your code to link your ${hospital.name} visits to your ABHA. It expires in ${String(LINK_CODE_TTL_MINUTES)} minutes.`,
    });

    return { linkRequestId: request.id, expiresAt, hint: maskPhone(patient.phone) };
  }

  /** The patient read the code back into their app. */
  async completePatientLink(input: {
    hipId: string;
    linkRequestId: string;
    code: string;
  }): Promise<{ patientReference: string; careContexts: Array<{ referenceNumber: string; display: string }> }> {
    const hospital = await this.facility(input.hipId);
    const request = await this.pendingRequest(hospital.id, input.linkRequestId);

    const attempts = request.attempts + 1;

    await this.db.asTenant(hospital.id, async (tx) => {
      await tx.execute(sql`
        UPDATE "abdm_link_request" SET "attempts" = ${attempts}
         WHERE "id" = ${request.id}::uuid
      `);
    });

    if (attempts > MAX_ATTEMPTS) {
      await this.failRequest(hospital.id, request.id, 'too many attempts');
      throw new BadRequestException('Too many attempts on that code');
    }

    if (!request.code_hash || !this.codeMatches(request.code_hash, request.id, input.code)) {
      throw new BadRequestException('That code is not correct');
    }

    const linked = await this.completeRequest(hospital.id, request, 'patient', null);

    return {
      patientReference: request.patient_id,
      careContexts: linked.map((visit) => ({
        referenceNumber: visit.encounterId,
        display: visit.display,
      })),
    };
  }

  // --- Withdrawing (T13) ----------------------------------------------------

  /**
   * A visit stops being offered to the network.
   *
   * What this does **not** do is reach into consents already granted over it.
   * A consent artefact is the patient's instrument, held by the consent
   * manager, and unlinking here does not revoke it — so the answer to "does
   * unlinking stop the sharing?" is: it stops new requests finding the visit,
   * and Phase 5 refuses to assemble anything for a care context that is no
   * longer linked. Both halves are needed, and saying only the first would be
   * a promise this cannot keep.
   */
  async unlink(
    actor: Actor,
    careContextId: string,
    reason: string,
    meta: RequestMeta,
  ): Promise<void> {
    const hospitalId = requireHospital(actor);

    const rows = await this.db.asTenant(hospitalId, async (tx) =>
      tx.execute<{ id: string; patient_id: string }>(sql`
        UPDATE "abdm_care_context"
           SET "status" = 'unlinked', "unlinked_at" = now(), "unlinked_reason" = ${reason}
         WHERE "id" = ${careContextId}::uuid AND "status" = 'linked'
        RETURNING "id", "patient_id"
      `),
    );

    const row = rows[0];
    if (!row) throw new NotFoundException('No linked care context with that id');

    await this.audit.recordForActor(actor, {
      resourceType: 'abdm_care_context',
      resourceId: row.id,
      patientId: row.patient_id,
      action: 'update',
      meta,
    });
  }

  // --- The parts both directions share --------------------------------------

  private async completeRequest(
    hospitalId: string,
    request: { id: string; patient_id: string; encounter_ids: string[] },
    initiatedBy: AbdmLinkInitiator,
    staffId: string | null,
  ): Promise<VisitLinkState[]> {
    const hospitalName = await this.hospitalName(hospitalId);
    const visits = await this.visitsFor(hospitalId, request.encounter_ids);

    await this.db.asTenant(hospitalId, async (tx) => {
      for (const visit of visits) {
        await tx.execute(sql`
          INSERT INTO "abdm_care_context"
            ("patient_id", "hospital_id", "encounter_id", "reference", "display",
             "initiated_by", "linked_by_staff_id")
          VALUES (${request.patient_id}::uuid, ${hospitalId}::uuid, ${visit.id}::uuid,
                  ${visit.id}, ${careContextDisplay({ startedAt: visit.started_at, class: visit.class, hospitalName })},
                  ${initiatedBy}, ${staffId}::uuid)
        `);
      }

      await tx.execute(sql`
        UPDATE "abdm_link_request"
           SET "status" = 'confirmed', "confirmed_at" = now()
         WHERE "id" = ${request.id}::uuid
      `);
    });

    return visits.map((visit) => ({
      encounterId: visit.id,
      startedAt: new Date(visit.started_at).toISOString(),
      display: careContextDisplay({
        startedAt: visit.started_at,
        class: visit.class,
        hospitalName,
      }),
      careContextId: null,
      status: 'linked',
      linkedAt: new Date().toISOString(),
    }));
  }

  private async failRequest(hospitalId: string, id: string, reason: string): Promise<void> {
    await this.db.asTenant(hospitalId, async (tx) => {
      await tx.execute(sql`
        UPDATE "abdm_link_request"
           SET "status" = 'failed', "failure_reason" = ${reason}
         WHERE "id" = ${id}::uuid AND "status" = 'pending'
      `);
    });
  }

  private async pendingRequest(
    hospitalId: string,
    id: string,
    patientId?: string,
  ): Promise<{
    id: string;
    patient_id: string;
    encounter_ids: string[];
    transaction_id: string | null;
    code_hash: string | null;
    attempts: number;
  }> {
    const rows = await this.db.asTenant(hospitalId, async (tx) =>
      tx.execute<{
        id: string;
        patient_id: string;
        encounter_ids: string[];
        transaction_id: string | null;
        code_hash: string | null;
        attempts: number;
      }>(sql`
        SELECT "id", "patient_id", "encounter_ids", "transaction_id", "code_hash", "attempts"
          FROM "abdm_link_request"
         WHERE "id" = ${id}::uuid
           AND "status" = 'pending'
           AND "expires_at" > now()
           AND (${patientId ?? null}::uuid IS NULL OR "patient_id" = ${patientId ?? null}::uuid)
      `),
    );

    const row = rows[0];
    if (!row) throw new NotFoundException('No linking request is waiting with that id');

    return { ...row, attempts: Number(row.attempts) };
  }

  /**
   * Refuses a link that would be meaningless or a duplicate.
   *
   * The visits must be this hospital's, this patient's, and not already
   * offered — a second care context for one visit would put the same record
   * on the network under two references and make unlinking a guess.
   */
  private async assertLinkable(
    hospitalId: string,
    patientId: string,
    encounterIds: string[],
  ): Promise<void> {
    if (encounterIds.length === 0) {
      throw new BadRequestException('Choose at least one visit to link');
    }

    const rows = await this.db.asTenant(hospitalId, async (tx) =>
      tx.execute<{ id: string; already: boolean }>(sql`
        SELECT e."id",
               EXISTS (
                 SELECT 1 FROM "abdm_care_context" c
                  WHERE c."encounter_id" = e."id" AND c."status" = 'linked'
               ) AS already
          FROM "encounter" e
         WHERE e."id" = ANY (${uuidArray(encounterIds)})
           AND e."hospital_id" = ${hospitalId}
           AND e."patient_id" = ANY (app.patient_record_ids(${patientId}::uuid))
           AND e."status" <> 'cancelled'
      `),
    );

    if (rows.length !== encounterIds.length) {
      throw new NotFoundException('One of those visits does not belong to this patient here');
    }

    if (rows.some((row) => row.already)) {
      throw new ConflictException('One of those visits is already shared with ABDM');
    }
  }

  private async visitsFor(
    hospitalId: string,
    encounterIds: string[],
  ): Promise<Array<{ id: string; started_at: string; class: string }>> {
    return this.db.asTenant(hospitalId, async (tx) =>
      tx.execute<{ id: string; started_at: string; class: string }>(sql`
        SELECT "id", "started_at", "class"::text AS class
          FROM "encounter"
         WHERE "id" = ANY (${uuidArray(encounterIds)}) AND "hospital_id" = ${hospitalId}
      ORDER BY "started_at" DESC
      `),
    );
  }

  private async displaysFor(
    hospitalId: string,
    encounterIds: string[],
  ): Promise<Array<{ referenceNumber: string; display: string }>> {
    const hospitalName = await this.hospitalName(hospitalId);
    const visits = await this.visitsFor(hospitalId, encounterIds);

    return visits.map((visit) => ({
      referenceNumber: visit.id,
      display: careContextDisplay({
        startedAt: visit.started_at,
        class: visit.class,
        hospitalName,
      }),
    }));
  }

  private async patientForLinking(
    hospitalId: string,
    patientId: string,
  ): Promise<PatientForLinking> {
    const rows = await this.db.asTenant(hospitalId, async (tx) =>
      tx.execute<PatientForLinking>(sql`
        SELECT "id", "name", "phone", "abha_address", "abha_address_verified_at"
          FROM "patient" WHERE "id" = ${patientId}::uuid
      `),
    );

    const row = rows[0];
    if (!row) throw new NotFoundException('No patient found with that id');

    return row;
  }

  /**
   * Linking rests on the ABHA being the patient's, and a typed one has been
   * confirmed by nobody (T2). Offering another hospital's network a link to
   * an unverified identifier would attach this patient's visits to whoever
   * really owns it.
   */
  private requireVerifiedAbha(patient: PatientForLinking): string {
    if (!patient.abha_address || !patient.abha_address_verified_at) {
      throw new ConflictException(
        'This patient has no verified ABHA address. Verify it before linking any visits.',
      );
    }

    return patient.abha_address;
  }

  private async facility(hipId: string): Promise<{ id: string; name: string }> {
    const rows = await this.db.asSystem(async (tx) =>
      tx.execute<{ id: string; name: string }>(sql`
        SELECT "id", "name" FROM "hospital" WHERE "hfr_id" = ${hipId} AND "status" = 'active'
      `),
    );

    const row = rows[0];
    if (!row) throw new NotFoundException('No facility is registered under that id');

    return row;
  }

  /**
   * The facility id to put on an outbound call.
   *
   * Phase 2 read this from the environment, which is right for a deployment
   * serving one facility and wrong for this one: ABDM registers a facility,
   * and this platform hosts many. The hospital's own registry id wins; the
   * configured value remains as the default for a single-facility install.
   */
  private async hipIdFor(hospitalId: string): Promise<string> {
    const rows = await this.db.asSystem(async (tx) =>
      tx.execute<{ hfr_id: string | null }>(sql`
        SELECT "hfr_id" FROM "hospital" WHERE "id" = ${hospitalId}::uuid
      `),
    );

    const registered = rows[0]?.hfr_id ?? this.config.gateway.hipId;

    if (!registered) {
      throw new ConflictException(
        'This hospital has no Health Facility Registry id, so it cannot talk to ABDM',
      );
    }

    return registered;
  }

  private async hospitalName(hospitalId: string): Promise<string> {
    const rows = await this.db.asSystem(async (tx) =>
      tx.execute<{ name: string }>(sql`
        SELECT "name" FROM "hospital" WHERE "id" = ${hospitalId}::uuid
      `),
    );

    return rows[0]?.name ?? 'this hospital';
  }

  private hash(requestId: string, code: string): string {
    // Hex, because the table refuses anything that is not 64 hex characters —
    // which is how a code written in clear would be caught.
    return createHmac('sha256', this.key).update(`abdm-link:${requestId}:${code}`).digest('hex');
  }

  private codeMatches(stored: string, requestId: string, given: string): boolean {
    const expected = Buffer.from(stored);
    const actual = Buffer.from(this.hash(requestId, given));

    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }
}
