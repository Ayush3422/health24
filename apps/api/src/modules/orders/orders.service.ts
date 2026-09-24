import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type {
  AdvanceOrderInput,
  CancelOrderInput,
  OrderList,
  OrderSummary,
  PlaceOrderInput,
  ServiceRequestCategory,
  ServiceRequestPriority,
  ServiceRequestStatus,
  Worklist,
  WorklistEntry,
  WorklistQuery,
} from '@health24/shared';
import { requireHospital, type Actor, type RequestMeta } from '../../common/actor';
import type { DbTransaction } from '../../db/client';
import { DatabaseService } from '../../db/database.service';
import { AuditService } from '../audit/audit.service';
import {
  blankToNull,
  requireLinkedPatient,
  requireWritableEncounter,
  resolveAttribution,
  toIso,
} from '../clinical/clinical-access';

type OrderRow = {
  id: string;
  patient_id: string;
  encounter_id: string;
  hospital_id: string;
  hospital_name: string | null;
  category: ServiceRequestCategory;
  requested_display: string;
  requested_code_system: string | null;
  requested_code: string | null;
  priority: ServiceRequestPriority;
  clinical_note: string | null;
  status: ServiceRequestStatus;
  reference: string | null;
  ordered_at: string | Date;
  ordered_by_staff_id: string;
  ordered_by_name: string | null;
  entry_source: 'direct' | 'transcribed';
  recorded_by_staff_id: string;
  entered_by_name: string | null;
  collected_at: string | Date | null;
  in_progress_at: string | Date | null;
  resulted_at: string | Date | null;
  cancelled_at: string | Date | null;
  cancelled_reason: string | null;
  result_count: number;
};

type WorklistRow = OrderRow & {
  patient_name: string;
  mrn: string | null;
  waiting_hours: number;
};

/**
 * An order's results: typed values and scanned reports alike, counted
 * together, because an order is answered by whichever arrives.
 */
const RESULT_COUNT = sql`(
  SELECT count(*)::int
    FROM (
      SELECT o."id" FROM "observation" o
       WHERE o."service_request_id" = r."id" AND o."version_status" = 'current'
       UNION ALL
      SELECT d."id" FROM "document_reference" d
       WHERE d."service_request_id" = r."id" AND d."version_status" = 'current'
    ) AS answered
)`;

const ORDER_SELECT = sql`
  SELECT r."id", r."patient_id", r."encounter_id", r."hospital_id", h."name" AS hospital_name,
         r."category", r."requested_display", r."requested_code_system", r."requested_code",
         r."priority", r."clinical_note", r."status", r."reference", r."ordered_at",
         r."ordered_by_staff_id", ob."name" AS ordered_by_name, r."entry_source",
         r."recorded_by_staff_id", eb."name" AS entered_by_name,
         r."collected_at", r."in_progress_at", r."resulted_at", r."cancelled_at",
         r."cancelled_reason", ${RESULT_COUNT} AS result_count
    FROM "service_request" r
    LEFT JOIN "hospital_directory" h ON h."id" = r."hospital_id"
    LEFT JOIN "staff_user" ob ON ob."id" = r."ordered_by_staff_id"
    LEFT JOIN "staff_user" eb ON eb."id" = r."recorded_by_staff_id"
`;

/**
 * Orders (sp6-plan.md, Decision O1).
 *
 * What a hospital asked for, and how far the work has got. Results point back
 * at the order, so a lab can be asked what is still outstanding and a
 * clinician can be told what came back.
 *
 * An order is the hospital's own operational record: row-level security admits
 * the hospital that placed it and nobody else, and no consent widens that.
 * What the work produced — the observation, the report — travels under the
 * consent rules it always did.
 */
@Injectable()
export class OrdersService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async place(actor: Actor, input: PlaceOrderInput, meta: RequestMeta): Promise<OrderSummary> {
    const hospitalId = requireHospital(actor);

    const row = await this.db.asTenant(hospitalId, async (tx) => {
      const encounter = await requireWritableEncounter(
        tx,
        hospitalId,
        input.encounterId,
        'An order is',
      );
      const attribution = await resolveAttribution(
        tx,
        actor,
        hospitalId,
        input.onBehalfOfClinicianId,
      );

      const [placed] = await tx.execute<{ id: string }>(sql`
        INSERT INTO "service_request"
          ("patient_id", "hospital_id", "encounter_id", "category", "requested_display",
           "requested_code_system", "requested_code", "priority", "clinical_note",
           "ordered_by_staff_id", "recorded_by_staff_id", "entry_source")
        VALUES (${encounter.patientId}::uuid, ${hospitalId}::uuid, ${input.encounterId}::uuid,
                ${input.category}::service_request_category, ${input.requestedDisplay},
                ${blankToNull(input.requestedCodeSystem)}, ${blankToNull(input.requestedCode)},
                ${input.priority}::service_request_priority, ${blankToNull(input.clinicalNote)},
                ${attribution.clinicianId}::uuid, ${actor.staffUserId}::uuid,
                ${attribution.entrySource}::entry_source)
        RETURNING "id"
      `);

      return this.load(tx, placed!.id);
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'service_request',
      resourceId: row.id,
      patientId: row.patient_id,
      action: 'create',
      meta,
    });

    return this.toSummary(row, hospitalId);
  }

  /** The sample is taken, or the work has begun. */
  async advance(
    actor: Actor,
    orderId: string,
    input: AdvanceOrderInput,
    meta: RequestMeta,
  ): Promise<OrderSummary> {
    const hospitalId = requireHospital(actor);

    const row = await this.db.asTenant(hospitalId, async (tx) => {
      const current = await this.load(tx, orderId);
      this.refuseBackwards(current, input.status);

      const step =
        input.status === 'collected'
          ? sql`"collected_at" = now(), "collected_by_staff_id" = ${actor.staffUserId}::uuid`
          : sql`"in_progress_at" = now(), "in_progress_by_staff_id" = ${actor.staffUserId}::uuid`;

      await tx.execute(sql`
        UPDATE "service_request"
           SET "status" = ${input.status}::service_request_status, ${step},
               "reference" = coalesce("reference", ${blankToNull(input.reference)})
         WHERE "id" = ${orderId}::uuid
      `);

      return this.load(tx, orderId);
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'service_request',
      resourceId: orderId,
      patientId: row.patient_id,
      action: 'update',
      meta,
    });

    return this.toSummary(row, hospitalId);
  }

  async cancel(
    actor: Actor,
    orderId: string,
    input: CancelOrderInput,
    meta: RequestMeta,
  ): Promise<OrderSummary> {
    const hospitalId = requireHospital(actor);

    const row = await this.db.asTenant(hospitalId, async (tx) => {
      const current = await this.load(tx, orderId);
      this.refuseBackwards(current, 'cancelled');

      await tx.execute(sql`
        UPDATE "service_request"
           SET "status" = 'cancelled', "cancelled_at" = now(),
               "cancelled_by_staff_id" = ${actor.staffUserId}::uuid,
               "cancelled_reason" = ${input.reason}
         WHERE "id" = ${orderId}::uuid
      `);

      return this.load(tx, orderId);
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'service_request',
      resourceId: orderId,
      patientId: row.patient_id,
      action: 'update',
      meta,
    });

    return this.toSummary(row, hospitalId);
  }

  async forEncounter(
    actor: Actor,
    encounterId: string,
    meta: RequestMeta,
  ): Promise<OrderSummary[]> {
    const hospitalId = requireHospital(actor);

    const rows = await this.db.asTenant(hospitalId, (tx) =>
      this.query(
        tx,
        sql`WHERE r."encounter_id" = ${encounterId}::uuid ORDER BY r."ordered_at" DESC`,
      ),
    );

    if (rows[0]) {
      await this.audit.recordForActor(actor, {
        resourceType: 'service_request',
        resourceId: encounterId,
        patientId: rows[0].patient_id,
        action: 'read',
        meta,
      });
    }

    return rows.map((row) => this.toSummary(row, hospitalId));
  }

  async forPatient(actor: Actor, patientId: string, meta: RequestMeta): Promise<OrderList> {
    const hospitalId = requireHospital(actor);

    const rows = await this.db.asTenant(hospitalId, async (tx) => {
      await requireLinkedPatient(tx, hospitalId, patientId);

      return this.query(
        tx,
        sql`WHERE r."patient_id" = ANY (app.patient_record_ids(${patientId}::uuid))
         ORDER BY r."ordered_at" DESC`,
      );
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'service_request',
      resourceId: patientId,
      patientId,
      action: 'search',
      meta,
    });

    return {
      orders: rows.map((row) => this.toSummary(row, hospitalId)),
      // An order is never shared: every row here is the caller's own (DF5).
      sharedFromOtherHospitals: false,
    };
  }

  /**
   * The worklist: what the hospital still owes somebody, oldest first, with
   * urgent work ahead of routine. Outstanding unless a status is asked for,
   * because a finished order is of no use to the person working the list.
   */
  async worklist(actor: Actor, query: WorklistQuery, meta: RequestMeta): Promise<Worklist> {
    const hospitalId = requireHospital(actor);

    const where = sql`
      WHERE ${
        query.status
          ? sql`r."status" = ${query.status}::service_request_status`
          : sql`r."status" IN ('ordered', 'collected', 'in_progress')`
      }
        ${
          query.category
            ? sql`AND r."category" = ${query.category}::service_request_category`
            : sql``
        }
        ${query.patientId ? sql`AND r."patient_id" = ${query.patientId}::uuid` : sql``}
    `;

    const rows = await this.db.asTenant(hospitalId, (tx) =>
      tx.execute<WorklistRow>(sql`
        SELECT o.*, p."name" AS patient_name, l."mrn",
               floor(extract(epoch FROM now() - o."ordered_at") / 3600)::int AS waiting_hours
          FROM (${ORDER_SELECT} ${where}) o
          JOIN "patient" p ON p."id" = o."patient_id"
          LEFT JOIN "patient_hospital_link" l
            ON l."patient_id" = o."patient_id" AND l."hospital_id" = o."hospital_id"
      ORDER BY o."priority" DESC, o."ordered_at" ASC
         LIMIT ${query.limit}
      `),
    );

    await this.audit.recordForActor(actor, {
      resourceType: 'service_request',
      resourceId: null,
      patientId: null,
      action: 'search',
      meta,
    });

    return {
      entries: [...rows].map((row) => ({
        ...this.toSummary(row, hospitalId),
        patient: { id: row.patient_id, name: row.patient_name, mrn: row.mrn },
        waitingHours: Number(row.waiting_hours),
      })) satisfies WorklistEntry[],
    };
  }

  /**
   * Marks an order answered, from wherever a result was recorded.
   *
   * Called inside the writer's own transaction, so a result and the order it
   * closes are one act: if the result is rolled back, so is the closure.
   */
  static async markResulted(tx: DbTransaction, orderId: string): Promise<void> {
    await tx.execute(sql`
      UPDATE "service_request"
         SET "status" = 'resulted', "resulted_at" = now()
       WHERE "id" = ${orderId}::uuid AND "status" <> 'resulted'
    `);
  }

  /**
   * The order a result may be recorded against: the caller's own hospital's,
   * for this patient, and not cancelled.
   */
  static async requireOpenOrder(
    tx: DbTransaction,
    orderId: string,
    patientId: string,
  ): Promise<void> {
    const [order] = await tx.execute<{ status: ServiceRequestStatus; patient_id: string }>(sql`
      SELECT "status", "patient_id" FROM "service_request" WHERE "id" = ${orderId}::uuid
    `);

    if (!order || order.patient_id !== patientId) {
      throw new NotFoundException('Order not found for this patient');
    }

    if (order.status === 'cancelled') {
      throw new ConflictException('That order was cancelled; place a new one');
    }
  }

  /**
   * An order moves forward or it is cancelled — never back to a step it has
   * already passed. The database says the same thing; this says it in words a
   * person can act on, before the trigger says it in words they cannot.
   */
  private refuseBackwards(order: OrderRow, to: ServiceRequestStatus): void {
    const said = (status: ServiceRequestStatus) => status.replace('_', ' ');

    if (order.status === 'cancelled') {
      throw new ConflictException('That order was cancelled');
    }

    if (order.status === 'resulted') {
      throw new ConflictException('That order already has its result');
    }

    if (to === 'cancelled') return;

    const steps: ServiceRequestStatus[] = ['ordered', 'collected', 'in_progress'];

    if (steps.indexOf(to) <= steps.indexOf(order.status)) {
      throw new ConflictException(
        order.status === to
          ? `That order is already ${said(to)}`
          : `That order is ${said(order.status)}; it cannot go back to ${said(to)}`,
      );
    }
  }

  private async load(tx: DbTransaction, orderId: string): Promise<OrderRow> {
    const [row] = await this.query(tx, sql`WHERE r."id" = ${orderId}::uuid`);

    if (!row) throw new NotFoundException('Order not found');

    return row;
  }

  private async query(tx: DbTransaction, where: ReturnType<typeof sql>): Promise<OrderRow[]> {
    return [...(await tx.execute<OrderRow>(sql`${ORDER_SELECT} ${where}`))];
  }

  private toSummary(row: OrderRow, hospitalId: string): OrderSummary {
    const isOwn = row.hospital_id === hospitalId;

    return {
      id: row.id,
      patientId: row.patient_id,
      encounterId: row.encounter_id,
      hospital: { id: row.hospital_id, name: row.hospital_name ?? '', isOwn },
      category: row.category,
      requestedDisplay: row.requested_display,
      requestedCodeSystem: row.requested_code_system,
      requestedCode: row.requested_code,
      priority: row.priority,
      clinicalNote: row.clinical_note,
      status: row.status,
      reference: row.reference,
      orderedAt: toIso(row.ordered_at),
      orderedBy: { id: row.ordered_by_staff_id, name: row.ordered_by_name },
      entry: {
        source: row.entry_source,
        enteredBy: { id: row.recorded_by_staff_id, name: row.entered_by_name },
      },
      collectedAt: row.collected_at ? toIso(row.collected_at) : null,
      inProgressAt: row.in_progress_at ? toIso(row.in_progress_at) : null,
      resultedAt: row.resulted_at ? toIso(row.resulted_at) : null,
      cancelledAt: row.cancelled_at ? toIso(row.cancelled_at) : null,
      cancelledReason: row.cancelled_reason,
      resultCount: Number(row.result_count),
    };
  }
}
