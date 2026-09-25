import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type {
  Catalogue,
  CatalogueCategory,
  CatalogueItem,
  CatalogueItemInput,
  CatalogueQuery,
  RepriceItemInput,
  RetireItemInput,
} from '@health24/shared';
import { requireHospital, type Actor, type RequestMeta } from '../../common/actor';
import type { DbTransaction } from '../../db/client';
import { DatabaseService } from '../../db/database.service';
import { AuditService } from '../audit/audit.service';
import { blankToNull, istToday, violatedConstraint } from '../clinical/clinical-access';

type ItemRow = {
  id: string;
  code: string;
  name: string;
  category: CatalogueCategory;
  unit: string;
  price_paise: string | number;
  active_from: string;
  active_to: string | null;
};

const ITEM_SELECT = sql`
  SELECT i."id", i."code", i."name", i."category", i."unit", i."price_paise",
         to_char(i."active_from", 'YYYY-MM-DD') AS active_from,
         to_char(i."active_to", 'YYYY-MM-DD') AS active_to
    FROM "service_catalogue_item" i
`;

/**
 * The service catalogue (sp6-plan.md, Decision R1).
 *
 * A price is never overwritten. Repricing closes the row in force on the day
 * before the new price starts and opens another, so what a patient was charged
 * last month can still be read against the price that stood then. Retiring an
 * item closes the row and opens nothing.
 */
@Injectable()
export class CatalogueService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async add(actor: Actor, input: CatalogueItemInput, meta: RequestMeta): Promise<CatalogueItem> {
    const hospitalId = requireHospital(actor);
    const from = input.activeFrom ?? istToday();

    const row = await this.db.asTenant(hospitalId, async (tx) => {
      try {
        const [created] = await tx.execute<{ id: string }>(sql`
          INSERT INTO "service_catalogue_item"
            ("hospital_id", "code", "name", "category", "unit", "price_paise", "active_from",
             "created_by_staff_id")
          VALUES (${hospitalId}::uuid, ${input.code}, ${input.name},
                  ${input.category}::catalogue_category, ${input.unit}, ${input.pricePaise},
                  ${from}::date, ${actor.staffUserId}::uuid)
          RETURNING "id"
        `);

        return this.load(tx, created!.id);
      } catch (error) {
        throw this.translate(error);
      }
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'service_catalogue_item',
      resourceId: row.id,
      patientId: null,
      action: 'create',
      meta,
    });

    return this.toItem(row);
  }

  /** A new price for the same code, from a day the hospital chooses. */
  async reprice(
    actor: Actor,
    itemId: string,
    input: RepriceItemInput,
    meta: RequestMeta,
  ): Promise<CatalogueItem> {
    const hospitalId = requireHospital(actor);
    const from = input.activeFrom ?? istToday();

    const row = await this.db.asTenant(hospitalId, async (tx) => {
      const current = await this.load(tx, itemId);

      if (current.active_to !== null) {
        throw new ConflictException('That price has already been closed; reprice the one in force');
      }

      if (from <= current.active_from) {
        throw new BadRequestException('A new price starts after the one it replaces');
      }

      // The old price stands until the day before the new one starts.
      await tx.execute(sql`
        UPDATE "service_catalogue_item"
           SET "active_to" = (${from}::date - 1)
         WHERE "id" = ${itemId}::uuid
      `);

      const [created] = await tx.execute<{ id: string }>(sql`
        INSERT INTO "service_catalogue_item"
          ("hospital_id", "code", "name", "category", "unit", "price_paise", "active_from",
           "created_by_staff_id")
        VALUES (${hospitalId}::uuid, ${current.code}, ${current.name},
                ${current.category}::catalogue_category, ${current.unit}, ${input.pricePaise},
                ${from}::date, ${actor.staffUserId}::uuid)
        RETURNING "id"
      `);

      return this.load(tx, created!.id);
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'service_catalogue_item',
      resourceId: row.id,
      patientId: null,
      action: 'update',
      meta,
    });

    return this.toItem(row);
  }

  /** Not chargeable after this day. The row stays, for the invoices that used it. */
  async retire(
    actor: Actor,
    itemId: string,
    input: RetireItemInput,
    meta: RequestMeta,
  ): Promise<CatalogueItem> {
    const hospitalId = requireHospital(actor);
    const to = input.activeTo ?? istToday();

    const row = await this.db.asTenant(hospitalId, async (tx) => {
      const current = await this.load(tx, itemId);

      if (current.active_to !== null) throw new ConflictException('That price is already closed');
      if (to < current.active_from) {
        throw new BadRequestException('An item cannot stop being charged before it started');
      }

      await tx.execute(sql`
        UPDATE "service_catalogue_item" SET "active_to" = ${to}::date
         WHERE "id" = ${itemId}::uuid
      `);

      return this.load(tx, itemId);
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'service_catalogue_item',
      resourceId: itemId,
      patientId: null,
      action: 'update',
      meta,
    });

    return this.toItem(row);
  }

  async list(actor: Actor, query: CatalogueQuery, meta: RequestMeta): Promise<Catalogue> {
    const hospitalId = requireHospital(actor);
    const today = istToday();
    const like = blankToNull(query.q) ? `%${query.q!.trim()}%` : null;

    const rows = await this.db.asTenant(hospitalId, (tx) =>
      tx.execute<ItemRow>(sql`
        ${ITEM_SELECT}
         WHERE i."hospital_id" = ${hospitalId}::uuid
           ${
             query.history
               ? sql``
               : sql`AND i."active_from" <= ${today}::date
                     AND (i."active_to" IS NULL OR i."active_to" >= ${today}::date)`
           }
           ${query.category ? sql`AND i."category" = ${query.category}::catalogue_category` : sql``}
           ${like ? sql`AND (i."name" ILIKE ${like} OR i."code" ILIKE ${like})` : sql``}
      ORDER BY i."category", i."name", i."active_from" DESC
      `),
    );

    await this.audit.recordForActor(actor, {
      resourceType: 'service_catalogue_item',
      resourceId: null,
      patientId: null,
      action: 'search',
      meta,
    });

    return { items: [...rows].map((row) => this.toItem(row)) };
  }

  /**
   * The price to charge today.
   *
   * Looked up once, at capture, and copied onto the charge — what somebody was
   * charged is a fact about that day.
   */
  static async priceInForce(
    tx: DbTransaction,
    itemId: string,
    on: string,
  ): Promise<{ id: string; pricePaise: number }> {
    const [item] = await tx.execute<{ id: string; price_paise: string | number }>(sql`
      SELECT "id", "price_paise" FROM "service_catalogue_item"
       WHERE "id" = ${itemId}::uuid
         AND "active_from" <= ${on}::date
         AND ("active_to" IS NULL OR "active_to" >= ${on}::date)
    `);

    if (!item) {
      throw new BadRequestException('That item is not in the catalogue, or is not priced today');
    }

    return { id: item.id, pricePaise: Number(item.price_paise) };
  }

  private async load(tx: DbTransaction, itemId: string): Promise<ItemRow> {
    const [row] = await tx.execute<ItemRow>(sql`${ITEM_SELECT} WHERE i."id" = ${itemId}::uuid`);

    if (!row) throw new NotFoundException('Catalogue item not found');

    return row;
  }

  private toItem(row: ItemRow): CatalogueItem {
    const today = istToday();

    return {
      id: row.id,
      code: row.code,
      name: row.name,
      category: row.category,
      unit: row.unit,
      pricePaise: Number(row.price_paise),
      activeFrom: row.active_from,
      activeTo: row.active_to,
      inForce: row.active_from <= today && (row.active_to === null || row.active_to >= today),
    };
  }

  private translate(error: unknown): unknown {
    const constraint = violatedConstraint(error);

    if (
      constraint === 'service_catalogue_item_one_in_force' ||
      constraint === 'service_catalogue_item_price_period'
    ) {
      return new BadRequestException('That code is already in the catalogue; reprice it instead');
    }

    return error;
  }
}
