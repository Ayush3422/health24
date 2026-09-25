import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type {
  CaptureChargeInput,
  CatalogueCategory,
  Charge,
  ChargeSource,
  ChargeStatus,
  EncounterCharges,
  UnchargedItem,
  VoidChargeInput,
} from '@health24/shared';
import { requireHospital, type Actor, type RequestMeta } from '../../common/actor';
import type { DbTransaction } from '../../db/client';
import { DatabaseService } from '../../db/database.service';
import { AuditService } from '../audit/audit.service';
import { blankToNull, istToday, toIso, violatedConstraint } from '../clinical/clinical-access';
import { bedDaysOf } from '../wards/admissions.service';
import { CatalogueService } from './catalogue.service';

type ChargeRow = {
  id: string;
  encounter_id: string;
  patient_id: string;
  item_id: string;
  code: string;
  name: string;
  category: CatalogueCategory;
  unit: string;
  quantity: number;
  unit_price_paise: string | number;
  amount_paise: string | number;
  source: ChargeSource;
  source_id: string | null;
  note: string | null;
  status: ChargeStatus;
  captured_at: string | Date;
  captured_by_staff_id: string;
  captured_by_name: string | null;
  voided_reason: string | null;
  invoice_id: string | null;
};

const CHARGE_SELECT = sql`
  SELECT c."id", c."encounter_id", c."patient_id", c."item_id", i."code", i."name", i."category",
         i."unit", c."quantity", c."unit_price_paise", c."amount_paise", c."source", c."source_id",
         c."note", c."status", c."captured_at", c."captured_by_staff_id",
         s."name" AS captured_by_name, c."voided_reason", c."invoice_id"
    FROM "charge" c
    JOIN "service_catalogue_item" i ON i."id" = c."item_id"
    LEFT JOIN "staff_user" s ON s."id" = c."captured_by_staff_id"
`;

/**
 * What a patient is charged (sp6-plan.md, Decision R1).
 *
 * Nothing is charged automatically. The record knows a test was ordered, an
 * operation done, a bed occupied for three days; only the hospital knows what
 * it charges for each, so the desk chooses the catalogue item and the price is
 * copied from it at that moment.
 *
 * A charge is voided, never edited: a wrong one is voided with a reason and a
 * right one captured beside it. Once it is on an invoice it belongs to the
 * invoice (DF4).
 */
@Injectable()
export class ChargesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async capture(actor: Actor, input: CaptureChargeInput, meta: RequestMeta): Promise<Charge> {
    const hospitalId = requireHospital(actor);

    if (input.source !== 'manual' && !input.sourceId) {
      throw new BadRequestException('Say which order, procedure or stay this charge is for');
    }

    const row = await this.db.asTenant(hospitalId, async (tx) => {
      const encounter = await this.requireOwnEncounter(tx, hospitalId, input.encounterId);
      const { id: itemId, pricePaise } = await CatalogueService.priceInForce(
        tx,
        input.itemId,
        istToday(),
      );

      try {
        const [created] = await tx.execute<{ id: string }>(sql`
          INSERT INTO "charge"
            ("patient_id", "hospital_id", "encounter_id", "item_id", "quantity",
             "unit_price_paise", "amount_paise", "source", "source_id", "note",
             "captured_by_staff_id")
          VALUES (${encounter.patientId}::uuid, ${hospitalId}::uuid, ${input.encounterId}::uuid,
                  ${itemId}::uuid, ${input.quantity}, ${pricePaise},
                  ${pricePaise * input.quantity}, ${input.source}::charge_source,
                  ${input.sourceId ?? null}, ${blankToNull(input.note)},
                  ${actor.staffUserId}::uuid)
          RETURNING "id"
        `);

        return this.load(tx, created!.id);
      } catch (error) {
        throw this.translate(error);
      }
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'charge',
      resourceId: row.id,
      patientId: row.patient_id,
      action: 'create',
      meta,
    });

    return this.toCharge(row);
  }

  async void(
    actor: Actor,
    chargeId: string,
    input: VoidChargeInput,
    meta: RequestMeta,
  ): Promise<Charge> {
    const hospitalId = requireHospital(actor);

    const row = await this.db.asTenant(hospitalId, async (tx) => {
      const current = await this.load(tx, chargeId);

      if (current.status === 'voided') throw new ConflictException('That charge is already voided');
      if (current.status === 'invoiced') {
        throw new ConflictException(
          'That charge is on an invoice; correct it with a credit note instead',
        );
      }

      await tx.execute(sql`
        UPDATE "charge"
           SET "status" = 'voided', "voided_at" = now(),
               "voided_by_staff_id" = ${actor.staffUserId}::uuid,
               "voided_reason" = ${input.reason}
         WHERE "id" = ${chargeId}::uuid
      `);

      return this.load(tx, chargeId);
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'charge',
      resourceId: chargeId,
      patientId: row.patient_id,
      action: 'update',
      meta,
    });

    return this.toCharge(row);
  }

  /** What has been charged on an encounter, and what the record says has not. */
  async forEncounter(
    actor: Actor,
    encounterId: string,
    meta: RequestMeta,
  ): Promise<EncounterCharges> {
    const hospitalId = requireHospital(actor);

    const { rows, uncharged, patientId } = await this.db.asTenant(hospitalId, async (tx) => {
      const encounter = await this.requireOwnEncounter(tx, hospitalId, encounterId);

      return {
        rows: await this.query(
          tx,
          sql`WHERE c."encounter_id" = ${encounterId}::uuid ORDER BY c."captured_at" ASC`,
        ),
        uncharged: await this.uncharged(tx, encounterId),
        patientId: encounter.patientId,
      };
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'charge',
      resourceId: encounterId,
      patientId,
      action: 'read',
      meta,
    });

    const live = rows.filter((row) => row.status !== 'voided');

    return {
      charges: rows.map((row) => this.toCharge(row)),
      totalPaise: live.reduce((total, row) => total + Number(row.amount_paise), 0),
      invoicedPaise: live
        .filter((row) => row.status === 'invoiced')
        .reduce((total, row) => total + Number(row.amount_paise), 0),
      uncharged,
    };
  }

  /**
   * Chargeable things the record holds that nobody has charged for yet.
   *
   * A suggestion, not a charge: it says a liver panel was resulted and a bed
   * was occupied for three days, and leaves it to the desk to say what those
   * cost here.
   */
  private async uncharged(tx: DbTransaction, encounterId: string): Promise<UnchargedItem[]> {
    const orders = await tx.execute<{
      id: string;
      requested_display: string;
      category: string;
      resulted_at: string | Date | null;
      ordered_at: string | Date;
    }>(sql`
      SELECT r."id", r."requested_display", r."category"::text AS category, r."resulted_at",
             r."ordered_at"
        FROM "service_request" r
       WHERE r."encounter_id" = ${encounterId}::uuid
         AND r."status" <> 'cancelled'
         AND NOT EXISTS (
           SELECT 1 FROM "charge" c
            WHERE c."source_id" = r."id" AND c."status" <> 'voided'
         )
    `);

    const procedures = await tx.execute<{
      id: string;
      name: string;
      performed_at: string | Date;
    }>(sql`
      SELECT p."id", p."name", p."performed_at"
        FROM "procedure" p
       WHERE p."encounter_id" = ${encounterId}::uuid AND p."version_status" = 'current'
         AND NOT EXISTS (
           SELECT 1 FROM "charge" c
            WHERE c."source_id" = p."id" AND c."status" <> 'voided'
         )
    `);

    const stays = await tx.execute<{
      id: string;
      ward: string;
      bed: string;
      started_at: string | Date;
      ended_at: string | Date | null;
    }>(sql`
      SELECT st."id", w."name" AS ward, b."label" AS bed, st."started_at", st."ended_at"
        FROM "bed_stay" st
        JOIN "bed" b ON b."id" = st."bed_id"
        JOIN "ward" w ON w."id" = b."ward_id"
       WHERE st."encounter_id" = ${encounterId}::uuid
         AND NOT EXISTS (
           SELECT 1 FROM "charge" c
            WHERE c."source_id" = st."id" AND c."status" <> 'voided'
         )
    `);

    return [
      ...[...orders].map((order) => ({
        source: 'order' as const,
        sourceId: order.id,
        description: order.requested_display,
        quantity: 1,
        at: toIso(order.resulted_at ?? order.ordered_at),
        suggestedCategory: (order.category === 'imaging'
          ? 'imaging'
          : order.category === 'procedure'
            ? 'procedure'
            : 'laboratory') as CatalogueCategory,
      })),
      ...[...procedures].map((procedure) => ({
        source: 'procedure' as const,
        sourceId: procedure.id,
        description: procedure.name,
        quantity: 1,
        at: toIso(procedure.performed_at),
        suggestedCategory: 'procedure' as CatalogueCategory,
      })),
      ...[...stays].map((stay) => ({
        source: 'bed_day' as const,
        sourceId: stay.id,
        description: `${stay.ward} · ${stay.bed}`,
        quantity: bedDaysOf(stay.started_at, stay.ended_at),
        at: toIso(stay.started_at),
        suggestedCategory: 'bed' as CatalogueCategory,
      })),
    ].sort((one, other) => one.at.localeCompare(other.at));
  }

  private async requireOwnEncounter(
    tx: DbTransaction,
    hospitalId: string,
    encounterId: string,
  ): Promise<{ patientId: string }> {
    const [encounter] = await tx.execute<{
      patient_id: string;
      hospital_id: string;
      status: string;
    }>(sql`
      SELECT "patient_id", "hospital_id", "status"::text AS status FROM "encounter"
       WHERE "id" = ${encounterId}::uuid
    `);

    if (!encounter || encounter.hospital_id !== hospitalId) {
      throw new NotFoundException('Encounter not found');
    }

    if (encounter.status === 'cancelled') {
      throw new ConflictException('That encounter was cancelled; nothing is charged against it');
    }

    return { patientId: encounter.patient_id };
  }

  private async load(tx: DbTransaction, chargeId: string): Promise<ChargeRow> {
    const [row] = await this.query(tx, sql`WHERE c."id" = ${chargeId}::uuid`);

    if (!row) throw new NotFoundException('Charge not found');

    return row;
  }

  private async query(tx: DbTransaction, tail: ReturnType<typeof sql>): Promise<ChargeRow[]> {
    const rows = await tx.execute<ChargeRow>(sql`${CHARGE_SELECT} ${tail}`);
    return [...rows];
  }

  private toCharge(row: ChargeRow): Charge {
    return {
      id: row.id,
      encounterId: row.encounter_id,
      patientId: row.patient_id,
      itemId: row.item_id,
      code: row.code,
      name: row.name,
      category: row.category,
      unit: row.unit,
      quantity: row.quantity,
      unitPricePaise: Number(row.unit_price_paise),
      amountPaise: Number(row.amount_paise),
      source: row.source,
      sourceId: row.source_id,
      note: row.note,
      status: row.status,
      capturedAt: toIso(row.captured_at),
      capturedBy: { id: row.captured_by_staff_id, name: row.captured_by_name },
      voidedReason: row.voided_reason,
      invoiceId: row.invoice_id,
    };
  }

  private translate(error: unknown): unknown {
    if (violatedConstraint(error) === 'charge_source_once') {
      return new ConflictException('That has already been charged for');
    }

    return error;
  }
}
