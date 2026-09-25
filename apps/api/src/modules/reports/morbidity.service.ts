import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type {
  GenerateReturnInput,
  MorbidityRow,
  StatutoryReturn,
  StatutoryReturnList,
  SubmitReturnInput,
} from '@health24/shared';
import { requireHospital, type Actor, type RequestMeta } from '../../common/actor';
import type { DbTransaction } from '../../db/client';
import { DatabaseService } from '../../db/database.service';
import { AuditService } from '../audit/audit.service';
import { blankToNull, toIso } from '../clinical/clinical-access';

type ReturnRow = {
  id: string;
  kind: 'ayush_morbidity';
  period_from: string;
  period_to: string;
  contents: MorbidityRow[];
  generated_at: string | Date;
  generated_by_staff_id: string;
  generated_by_name: string | null;
  submitted_at: string | Date | null;
  submitted_by_staff_id: string | null;
  submitted_by_name: string | null;
  reference: string | null;
};

const RETURN_SELECT = sql`
  SELECT r."id", r."kind", to_char(r."period_from", 'YYYY-MM-DD') AS period_from,
         to_char(r."period_to", 'YYYY-MM-DD') AS period_to, r."contents", r."generated_at",
         r."generated_by_staff_id", g."name" AS generated_by_name, r."submitted_at",
         r."submitted_by_staff_id", s."name" AS submitted_by_name, r."reference"
    FROM "statutory_return" r
    LEFT JOIN "staff_user" g ON g."id" = r."generated_by_staff_id"
    LEFT JOIN "staff_user" s ON s."id" = r."submitted_by_staff_id"
`;

/**
 * The Ayush morbidity return (sp6-plan.md, DF10).
 *
 * The point of coding every diagnosis twice: this counts them by their NAMASTE
 * code and by the ICD-11 code the mapping gave, for a period, and keeps what
 * was submitted exactly as it was sent. The record will have gained
 * corrections by the time anybody asks about these numbers again, and a return
 * that quietly changed afterwards would be worse than useless.
 */
@Injectable()
export class MorbidityService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async generate(
    actor: Actor,
    input: GenerateReturnInput,
    meta: RequestMeta,
  ): Promise<StatutoryReturn> {
    const hospitalId = requireHospital(actor);

    const row = await this.db.asTenant(hospitalId, async (tx) => {
      const rows = await this.count(tx, hospitalId, input);

      const [created] = await tx.execute<{ id: string }>(sql`
        INSERT INTO "statutory_return"
          ("hospital_id", "kind", "period_from", "period_to", "contents", "generated_by_staff_id")
        VALUES (${hospitalId}::uuid, 'ayush_morbidity', ${input.from}::date, ${input.to}::date,
                ${JSON.stringify(rows)}::jsonb, ${actor.staffUserId}::uuid)
        RETURNING "id"
      `);

      return this.load(tx, created!.id);
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'statutory_return',
      resourceId: row.id,
      patientId: null,
      action: 'create',
      meta,
    });

    return this.toReturn(row);
  }

  /** Recorded as sent: what went, when, and the acknowledgement it came back with. */
  async submit(
    actor: Actor,
    returnId: string,
    input: SubmitReturnInput,
    meta: RequestMeta,
  ): Promise<StatutoryReturn> {
    const hospitalId = requireHospital(actor);

    const row = await this.db.asTenant(hospitalId, async (tx) => {
      const current = await this.load(tx, returnId);

      if (current.submitted_at) {
        throw new ConflictException('That return has already been submitted');
      }

      await tx.execute(sql`
        UPDATE "statutory_return"
           SET "submitted_at" = now(), "submitted_by_staff_id" = ${actor.staffUserId}::uuid,
               "reference" = ${blankToNull(input.reference)}
         WHERE "id" = ${returnId}::uuid
      `);

      return this.load(tx, returnId);
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'statutory_return',
      resourceId: returnId,
      patientId: null,
      action: 'update',
      meta,
    });

    return this.toReturn(row);
  }

  async list(actor: Actor, meta: RequestMeta): Promise<StatutoryReturnList> {
    const hospitalId = requireHospital(actor);

    const rows = await this.db.asTenant(hospitalId, (tx) =>
      tx.execute<ReturnRow>(sql`
        ${RETURN_SELECT}
         WHERE r."hospital_id" = ${hospitalId}::uuid
      ORDER BY r."period_from" DESC, r."generated_at" DESC
         LIMIT 100
      `),
    );

    await this.audit.recordForActor(actor, {
      resourceType: 'statutory_return',
      resourceId: null,
      patientId: null,
      action: 'search',
      meta,
    });

    return {
      returns: [...rows].map((row) => {
        const { rows: _counted, ...rest } = this.toReturn(row);
        return rest;
      }),
    };
  }

  async findById(actor: Actor, returnId: string, meta: RequestMeta): Promise<StatutoryReturn> {
    const hospitalId = requireHospital(actor);
    const row = await this.db.asTenant(hospitalId, (tx) => this.load(tx, returnId));

    await this.audit.recordForActor(actor, {
      resourceType: 'statutory_return',
      resourceId: returnId,
      patientId: null,
      action: 'read',
      meta,
    });

    return this.toReturn(row);
  }

  /** The return as a spreadsheet, which is how a ministry asks for one. */
  async asCsv(actor: Actor, returnId: string, meta: RequestMeta): Promise<string> {
    const filed = await this.findById(actor, returnId, meta);

    const header = [
      'NAMASTE code',
      'NAMASTE term',
      'ICD-11 code',
      'ICD-11 term',
      'Total',
      'Male',
      'Female',
      'Other',
    ];

    const lines = filed.rows.map((row) =>
      [
        row.namasteCode,
        row.namasteDisplay,
        row.icd11Code ?? '',
        row.icd11Display ?? '',
        row.total,
        row.male,
        row.female,
        row.other,
      ]
        .map((cell) => csvCell(String(cell)))
        .join(','),
    );

    return [header.map(csvCell).join(','), ...lines].join('\r\n');
  }

  /**
   * The count itself: every coded diagnosis in the period, by code and sex.
   *
   * Counted from current versions only — a diagnosis corrected since is
   * counted as it stands now, which is what the ministry is asking about.
   */
  private async count(
    tx: DbTransaction,
    hospitalId: string,
    range: GenerateReturnInput,
  ): Promise<MorbidityRow[]> {
    const rows = await tx.execute<{
      namaste_code: string;
      namaste_display: string;
      icd11_code: string | null;
      icd11_display: string | null;
      total: number;
      male: number;
      female: number;
      other: number;
    }>(sql`
      SELECT namaste."code" AS namaste_code, namaste."display" AS namaste_display,
             icd."code" AS icd11_code, icd."display" AS icd11_display,
             count(*)::int AS total,
             count(*) FILTER (WHERE p."gender" = 'male')::int AS male,
             count(*) FILTER (WHERE p."gender" = 'female')::int AS female,
             count(*) FILTER (WHERE p."gender" NOT IN ('male', 'female'))::int AS other
        FROM "condition" c
        JOIN "patient" p ON p."id" = c."patient_id"
        JOIN LATERAL (
          SELECT cc."code", cc."display" FROM "condition_coding" cc
           WHERE cc."condition_id" = c."id" AND upper(cc."code_system_key") = 'NAMASTE'
           LIMIT 1
        ) AS namaste ON true
        LEFT JOIN LATERAL (
          SELECT cc."code", cc."display" FROM "condition_coding" cc
           WHERE cc."condition_id" = c."id" AND cc."code_system_key" ILIKE 'ICD%'
           LIMIT 1
        ) AS icd ON true
       WHERE c."hospital_id" = ${hospitalId}::uuid
         AND c."version_status" = 'current'
         AND app.ist_date(c."recorded_at") BETWEEN ${range.from}::date AND ${range.to}::date
    GROUP BY namaste."code", namaste."display", icd."code", icd."display"
    ORDER BY total DESC, namaste."display"
    `);

    return [...rows].map((row) => ({
      namasteCode: row.namaste_code,
      namasteDisplay: row.namaste_display,
      icd11Code: row.icd11_code,
      icd11Display: row.icd11_display,
      total: Number(row.total),
      male: Number(row.male),
      female: Number(row.female),
      other: Number(row.other),
    }));
  }

  private async load(tx: DbTransaction, returnId: string): Promise<ReturnRow> {
    const [row] = await tx.execute<ReturnRow>(sql`
      ${RETURN_SELECT} WHERE r."id" = ${returnId}::uuid
    `);

    if (!row) throw new NotFoundException('Return not found');

    return row;
  }

  private toReturn(row: ReturnRow): StatutoryReturn {
    const rows = row.contents;

    return {
      id: row.id,
      kind: row.kind,
      periodFrom: row.period_from,
      periodTo: row.period_to,
      generatedAt: toIso(row.generated_at),
      generatedBy: { id: row.generated_by_staff_id, name: row.generated_by_name },
      rows,
      total: rows.reduce((sum, entry) => sum + entry.total, 0),
      submittedAt: row.submitted_at ? toIso(row.submitted_at) : null,
      submittedBy: row.submitted_by_staff_id
        ? { id: row.submitted_by_staff_id, name: row.submitted_by_name }
        : null,
      reference: row.reference,
    };
  }
}

/** A cell that is safe in a spreadsheet, quotes and commas and all. */
function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
