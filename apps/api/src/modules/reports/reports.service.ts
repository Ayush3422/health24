import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  CATALOGUE_CATEGORY_LABELS,
  ENCOUNTER_CLASSES,
  PAYMENT_METHOD_LABELS,
  type CountRow,
  type DataQualityReport,
  type DiagnosisReport,
  type FootfallQuery,
  type FootfallReport,
  type PrescriptionReport,
  type ReportRange,
  type RevenueReport,
} from '@health24/shared';
import { requireHospital, type Actor, type RequestMeta } from '../../common/actor';
import type { DbTransaction } from '../../db/client';
import { DatabaseService } from '../../db/database.service';
import { AuditService } from '../audit/audit.service';
import { istToday } from '../clinical/clinical-access';

/** Metrics kept per finished day. Today is never among them (Decision S1). */
const DAILY_METRICS = {
  encounters: 'encounters',
  invoiced: 'invoiced_paise',
} as const;

const humanise = (value: string): string =>
  value.replace(/_/g, ' ').replace(/^./, (first) => first.toUpperCase());

/**
 * The hospital's own numbers (sp6-plan.md, Decision S1).
 *
 * Counted from the operational tables under the hospital's own row-level
 * security, so a report cannot show another hospital's figures and can never
 * disagree with the record it counted.
 *
 * Days that are over are counted once and kept; today is counted afresh every
 * time, because it is still happening. A day missing from the summary is
 * counted and written on the spot, so a report never has a hole in it whether
 * or not the nightly job has run.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async footfall(actor: Actor, query: FootfallQuery, meta: RequestMeta): Promise<FootfallReport> {
    const hospitalId = requireHospital(actor);

    const report = await this.db.asTenant(hospitalId, async (tx) => {
      const byDay = await this.dailySeries(tx, hospitalId, query, DAILY_METRICS.encounters);

      const breakdown = await tx.execute<{ key: string; count: number }>(sql`
        SELECT ${this.footfallDimension(query.by)} AS key, count(*)::int AS count
          FROM "encounter" e
          LEFT JOIN "staff_user" s ON s."id" = e."attending_staff_id"
         WHERE e."hospital_id" = ${hospitalId}::uuid
           AND e."status" <> 'cancelled'
           AND app.ist_date(e."started_at") BETWEEN ${query.from}::date AND ${query.to}::date
      GROUP BY 1
      ORDER BY count DESC
      `);

      return {
        byDay,
        breakdown: [...breakdown].map((row) => ({
          key: row.key,
          label: humanise(row.key),
          count: Number(row.count),
        })),
      };
    });

    await this.recordRead(actor, 'footfall', meta);

    return {
      total: report.byDay.reduce((sum, day) => sum + day.count, 0),
      byDay: report.byDay,
      breakdown: report.breakdown,
    };
  }

  /** Every diagnosis coded in the period, commonest first (T20). */
  async diagnoses(actor: Actor, range: ReportRange, meta: RequestMeta): Promise<DiagnosisReport> {
    const hospitalId = requireHospital(actor);

    const rows = await this.db.asTenant(hospitalId, (tx) =>
      tx.execute<{
        code: string;
        display: string;
        system: string;
        icd11_code: string | null;
        icd11_display: string | null;
        count: number;
      }>(sql`
        SELECT primary_coding."code", primary_coding."display", primary_coding."code_system_key" AS system,
               icd."code" AS icd11_code, icd."display" AS icd11_display,
               count(*)::int AS count
          FROM "condition" c
          JOIN LATERAL (
            SELECT cc."code", cc."display", cc."code_system_key"
              FROM "condition_coding" cc
             WHERE cc."condition_id" = c."id" AND cc."role" = 'primary'
             LIMIT 1
          ) AS primary_coding ON true
          LEFT JOIN LATERAL (
            SELECT cc."code", cc."display"
              FROM "condition_coding" cc
             WHERE cc."condition_id" = c."id" AND cc."code_system_key" ILIKE 'ICD%'
             LIMIT 1
          ) AS icd ON true
         WHERE c."hospital_id" = ${hospitalId}::uuid
           AND c."version_status" = 'current'
           AND app.ist_date(c."recorded_at") BETWEEN ${range.from}::date AND ${range.to}::date
      GROUP BY primary_coding."code", primary_coding."display", primary_coding."code_system_key",
               icd."code", icd."display"
      ORDER BY count DESC, primary_coding."display"
      `),
    );

    await this.recordRead(actor, 'diagnoses', meta);

    const diagnoses = [...rows].map((row) => ({
      key: row.code,
      label: row.display,
      count: Number(row.count),
      system: row.system,
      icd11Code: row.icd11_code,
      icd11Display: row.icd11_display,
    }));

    return { total: diagnoses.reduce((sum, row) => sum + row.count, 0), diagnoses };
  }

  async prescriptions(
    actor: Actor,
    range: ReportRange,
    meta: RequestMeta,
  ): Promise<PrescriptionReport> {
    const hospitalId = requireHospital(actor);

    const report = await this.db.asTenant(hospitalId, async (tx) => {
      const where = sql`
        WHERE m."hospital_id" = ${hospitalId}::uuid
          AND m."version_status" = 'current'
          AND app.ist_date(m."recorded_at") BETWEEN ${range.from}::date AND ${range.to}::date
      `;

      const medicines = await tx.execute<{ key: string; count: number }>(sql`
        SELECT m."medicine_name" AS key, count(*)::int AS count
          FROM "medication_request" m ${where}
      GROUP BY 1 ORDER BY count DESC, 1 LIMIT 100
      `);

      const bySystem = await tx.execute<{ key: string; count: number }>(sql`
        SELECT m."system_of_medicine"::text AS key, count(*)::int AS count
          FROM "medication_request" m ${where}
      GROUP BY 1 ORDER BY count DESC
      `);

      return { medicines: [...medicines], bySystem: [...bySystem] };
    });

    await this.recordRead(actor, 'prescriptions', meta);

    const rows = (list: Array<{ key: string; count: number }>): CountRow[] =>
      list.map((row) => ({ key: row.key, label: humanise(row.key), count: Number(row.count) }));

    return {
      total: report.medicines.reduce((sum, row) => sum + Number(row.count), 0),
      medicines: report.medicines.map((row) => ({
        key: row.key,
        label: row.key,
        count: Number(row.count),
      })),
      bySystem: rows(report.bySystem),
    };
  }

  /** What was billed, what came in, and what is still owed (T19). */
  async revenue(actor: Actor, range: ReportRange, meta: RequestMeta): Promise<RevenueReport> {
    const hospitalId = requireHospital(actor);

    const report = await this.db.asTenant(hospitalId, async (tx) => {
      const byDay = await this.dailySeries(
        tx,
        hospitalId,
        range,
        DAILY_METRICS.invoiced,
      );

      const [totals] = await tx.execute<{
        invoiced: string | number;
        received: string | number;
        credited: string | number;
      }>(sql`
        SELECT
          coalesce((
            SELECT sum(v."total_paise") FROM "invoice" v
             WHERE v."hospital_id" = ${hospitalId}::uuid
               AND app.ist_date(v."issued_at") BETWEEN ${range.from}::date AND ${range.to}::date
          ), 0) AS invoiced,
          coalesce((
            SELECT sum(CASE e."kind" WHEN 'payment' THEN e."amount_paise"
                                     WHEN 'refund' THEN -e."amount_paise" ELSE 0 END)
              FROM "payment_entry" e
             WHERE e."hospital_id" = ${hospitalId}::uuid
               AND app.ist_date(e."at") BETWEEN ${range.from}::date AND ${range.to}::date
          ), 0) AS received,
          coalesce((
            SELECT sum(e."amount_paise") FROM "payment_entry" e
             WHERE e."hospital_id" = ${hospitalId}::uuid AND e."kind" = 'credit_note'
               AND app.ist_date(e."at") BETWEEN ${range.from}::date AND ${range.to}::date
          ), 0) AS credited
      `);

      const byCategory = await tx.execute<{ key: string; amount: string | number }>(sql`
        SELECT i."category"::text AS key, sum(line."amount_paise") AS amount
          FROM "invoice_line" line
          JOIN "invoice" v ON v."id" = line."invoice_id"
          JOIN "charge" c ON c."id" = line."charge_id"
          JOIN "service_catalogue_item" i ON i."id" = c."item_id"
         WHERE v."hospital_id" = ${hospitalId}::uuid
           AND app.ist_date(v."issued_at") BETWEEN ${range.from}::date AND ${range.to}::date
      GROUP BY 1 ORDER BY amount DESC
      `);

      const byMethod = await tx.execute<{ key: string; amount: string | number }>(sql`
        SELECT e."method"::text AS key,
               sum(CASE e."kind" WHEN 'payment' THEN e."amount_paise" ELSE -e."amount_paise" END) AS amount
          FROM "payment_entry" e
         WHERE e."hospital_id" = ${hospitalId}::uuid AND e."method" IS NOT NULL
           AND app.ist_date(e."at") BETWEEN ${range.from}::date AND ${range.to}::date
      GROUP BY 1 ORDER BY amount DESC
      `);

      return {
        byDay,
        totals: totals!,
        byCategory: [...byCategory],
        byMethod: [...byMethod],
      };
    });

    await this.recordRead(actor, 'revenue', meta);

    const invoiced = Number(report.totals.invoiced);
    const received = Number(report.totals.received);
    const credited = Number(report.totals.credited);

    return {
      invoicedPaise: invoiced,
      receivedPaise: received,
      creditedPaise: credited,
      outstandingPaise: invoiced - received - credited,
      byDay: report.byDay.map((day) => ({ date: day.date, invoicedPaise: day.count })),
      byCategory: report.byCategory.map((row) => ({
        key: row.key,
        label:
          CATALOGUE_CATEGORY_LABELS[row.key as keyof typeof CATALOGUE_CATEGORY_LABELS] ??
          humanise(row.key),
        amountPaise: Number(row.amount),
      })),
      byMethod: report.byMethod.map((row) => ({
        key: row.key,
        label:
          PAYMENT_METHOD_LABELS[row.key as keyof typeof PAYMENT_METHOD_LABELS] ??
          humanise(row.key),
        amountPaise: Number(row.amount),
      })),
    };
  }

  /**
   * What the record says is unfinished (T22).
   *
   * Each check is something somebody can put right today, and the counts are
   * the hospital's own: nothing here reaches into another's record.
   */
  async dataQuality(actor: Actor, meta: RequestMeta): Promise<DataQualityReport> {
    const hospitalId = requireHospital(actor);

    const [row] = await this.db.asTenant(hospitalId, (tx) =>
      tx.execute<Record<string, number>>(sql`
        SELECT
          (SELECT count(*)::int FROM "condition" c
            WHERE c."hospital_id" = ${hospitalId}::uuid AND c."version_status" = 'current'
              AND NOT EXISTS (
                SELECT 1 FROM "condition_coding" cc
                 WHERE cc."condition_id" = c."id" AND cc."code_system_key" ILIKE 'ICD%'
              )) AS unmapped_diagnoses,
          (SELECT count(*)::int FROM "service_request" r
            WHERE r."hospital_id" = ${hospitalId}::uuid
              AND r."status" IN ('ordered', 'collected', 'in_progress')
              AND r."ordered_at" < now() - interval '3 days') AS stale_orders,
          (SELECT count(*)::int FROM "encounter" e
            WHERE e."hospital_id" = ${hospitalId}::uuid AND e."status" = 'in_progress'
              AND e."started_at" < now() - interval '2 days'
              AND NOT EXISTS (
                SELECT 1 FROM "bed_stay" s
                 WHERE s."encounter_id" = e."id" AND s."ended_at" IS NULL
              )) AS open_encounters,
          (SELECT count(*)::int FROM "charge" c
            WHERE c."hospital_id" = ${hospitalId}::uuid AND c."status" = 'captured'
              AND c."captured_at" < now() - interval '7 days') AS uninvoiced_charges,
          (SELECT count(*)::int FROM "invoice" v
            WHERE v."hospital_id" = ${hospitalId}::uuid
              AND v."issued_at" < now() - interval '30 days'
              AND v."total_paise" > coalesce((
                SELECT sum(CASE e."kind" WHEN 'refund' THEN -e."amount_paise"
                                         ELSE e."amount_paise" END)
                  FROM "payment_entry" e WHERE e."invoice_id" = v."id"
              ), 0)) AS old_unpaid_invoices,
          (SELECT count(*)::int FROM "discharge_summary" d
            WHERE d."hospital_id" = ${hospitalId}::uuid AND d."status" = 'draft'
              AND d."composed_at" < now() - interval '3 days') AS unsigned_summaries
      `),
    );

    await this.recordRead(actor, 'data_quality', meta);

    const checks = [
      {
        key: 'unmapped_diagnoses',
        label: 'Diagnoses with no ICD-11 code',
        explanation:
          'A diagnosis coded only in NAMASTE cannot be counted in the morbidity return. Ask a curator to map the concept, or code it in ICD-11 as well.',
      },
      {
        key: 'stale_orders',
        label: 'Orders outstanding for more than three days',
        explanation: 'The lab or the radiology desk has not recorded a result. Chase or cancel it.',
      },
      {
        key: 'open_encounters',
        label: 'Visits left open for more than two days',
        explanation:
          'An encounter nobody finished. Finish it, or cancel it if it was opened by mistake.',
      },
      {
        key: 'uninvoiced_charges',
        label: 'Charges captured but not billed for a week',
        explanation: 'Money the hospital has earned and not asked for. Raise the invoice.',
      },
      {
        key: 'old_unpaid_invoices',
        label: 'Invoices unpaid after a month',
        explanation: 'Follow them up, or write off what will not be paid with a credit note.',
      },
      {
        key: 'unsigned_summaries',
        label: 'Discharge summaries left as drafts',
        explanation:
          'A summary is not a record until it is signed, and the patient has nothing to take away. Ask the clinician to sign it.',
      },
    ] as const;

    return {
      checks: checks.map((check) => ({ ...check, count: Number(row?.[check.key] ?? 0) })),
    };
  }

  /**
   * Counts a finished day and keeps it.
   *
   * Run nightly for yesterday, and on the spot for any day a report asks for
   * that has not been counted yet — so the numbers are the same either way,
   * and the job is an optimisation rather than something to depend on.
   */
  async summariseDay(hospitalId: string, date: string): Promise<void> {
    if (date >= istToday()) return;

    await this.db.asTenant(hospitalId, async (tx) => {
      await this.countInto(
        tx,
        hospitalId,
        date,
        DAILY_METRICS.encounters,
        sql`
          SELECT count(*)::bigint AS value FROM "encounter" e
           WHERE e."hospital_id" = ${hospitalId}::uuid AND e."status" <> 'cancelled'
             AND app.ist_date(e."started_at") = ${date}::date
        `,
      );

      await this.countInto(
        tx,
        hospitalId,
        date,
        DAILY_METRICS.invoiced,
        sql`
          SELECT coalesce(sum(v."total_paise"), 0)::bigint AS value FROM "invoice" v
           WHERE v."hospital_id" = ${hospitalId}::uuid
             AND app.ist_date(v."issued_at") = ${date}::date
        `,
      );
    });
  }

  /** Every hospital's yesterday, for the nightly job. */
  async summariseYesterdayEverywhere(): Promise<number> {
    const yesterday = new Date(Date.now() - 86_400_000);
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(yesterday);

    const hospitals = await this.db.asSystem((tx) =>
      tx.execute<{ id: string }>(sql`SELECT "id" FROM "hospital" WHERE "status" = 'active'`),
    );

    for (const hospital of hospitals) {
      await this.summariseDay(hospital.id, date);
    }

    return [...hospitals].length;
  }

  /**
   * A day-by-day series over the period.
   *
   * Finished days come from the summary, and are counted and kept if they are
   * missing; today is counted live, because it is not over.
   */
  private async dailySeries(
    tx: DbTransaction,
    hospitalId: string,
    range: ReportRange,
    metric: string,
  ): Promise<Array<{ date: string; count: number }>> {
    const today = istToday();

    const kept = await tx.execute<{ ist_date: string; value: string | number }>(sql`
      SELECT to_char("ist_date", 'YYYY-MM-DD') AS ist_date, "value"
        FROM "daily_summary"
       WHERE "hospital_id" = ${hospitalId}::uuid AND "metric" = ${metric}
         AND "dimension" = 'all'
         AND "ist_date" BETWEEN ${range.from}::date AND ${range.to}::date
    `);

    const byDate = new Map([...kept].map((row) => [row.ist_date, Number(row.value)]));
    const series: Array<{ date: string; count: number }> = [];

    for (const date of daysBetween(range.from, range.to)) {
      if (date > today) continue;

      if (byDate.has(date)) {
        series.push({ date, count: byDate.get(date)! });
        continue;
      }

      const live = await this.countFor(tx, hospitalId, date, metric);

      // A day that is over is worth keeping; today is not.
      if (date < today) await this.write(tx, hospitalId, date, metric, live);

      series.push({ date, count: live });
    }

    return series;
  }

  private async countFor(
    tx: DbTransaction,
    hospitalId: string,
    date: string,
    metric: string,
  ): Promise<number> {
    const [row] = await tx.execute<{ value: string | number }>(
      metric === DAILY_METRICS.invoiced
        ? sql`
            SELECT coalesce(sum(v."total_paise"), 0)::bigint AS value FROM "invoice" v
             WHERE v."hospital_id" = ${hospitalId}::uuid
               AND app.ist_date(v."issued_at") = ${date}::date
          `
        : sql`
            SELECT count(*)::bigint AS value FROM "encounter" e
             WHERE e."hospital_id" = ${hospitalId}::uuid AND e."status" <> 'cancelled'
               AND app.ist_date(e."started_at") = ${date}::date
          `,
    );

    return Number(row?.value ?? 0);
  }

  private async countInto(
    tx: DbTransaction,
    hospitalId: string,
    date: string,
    metric: string,
    query: ReturnType<typeof sql>,
  ): Promise<void> {
    const [row] = await tx.execute<{ value: string | number }>(query);
    await this.write(tx, hospitalId, date, metric, Number(row?.value ?? 0));
  }

  private async write(
    tx: DbTransaction,
    hospitalId: string,
    date: string,
    metric: string,
    value: number,
  ): Promise<void> {
    await tx.execute(sql`
      INSERT INTO "daily_summary" ("hospital_id", "ist_date", "metric", "dimension", "value")
      VALUES (${hospitalId}::uuid, ${date}::date, ${metric}, 'all', ${value})
      ON CONFLICT ("hospital_id", "ist_date", "metric", "dimension")
        DO UPDATE SET "value" = excluded."value", "counted_at" = now()
    `);
  }

  private footfallDimension(by: FootfallQuery['by']): ReturnType<typeof sql> {
    if (by === 'system') return sql`e."system_of_medicine"::text`;
    if (by === 'clinician') return sql`coalesce(s."name", 'Unknown')`;

    return sql`e."class"::text`;
  }

  private async recordRead(actor: Actor, report: string, meta: RequestMeta): Promise<void> {
    await this.audit.recordForActor(actor, {
      resourceType: 'report',
      resourceId: report,
      patientId: null,
      action: 'read',
      meta,
    });
  }
}

/** Every date from one to the other, inclusive, as YYYY-MM-DD. */
export function daysBetween(from: string, to: string): string[] {
  const days: string[] = [];

  for (
    let day = Date.parse(`${from}T00:00:00Z`);
    day <= Date.parse(`${to}T00:00:00Z`);
    day += 86_400_000
  ) {
    days.push(new Date(day).toISOString().slice(0, 10));
  }

  return days;
}

/** Encounter classes, for a report that wants every column even at zero. */
export const REPORTABLE_CLASSES = ENCOUNTER_CLASSES;
