import { BadRequestException, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type {
  AccessAction,
  AccessHistoryEntry,
  AccessHistoryPage,
  AccessHistoryQuery,
  ConsentCaptureMethod,
  StaffRole,
} from '@health24/shared';
import type { PatientActor, RequestMeta } from '../../common/actor';
import { DatabaseService } from '../../db/database.service';
import { AuditService } from '../audit/audit.service';
import { toIso } from '../clinical/clinical-access';

type GroupRow = {
  day: string;
  actor_type: 'staff' | 'patient' | 'system';
  actor_id: string | null;
  actor_label: string | null;
  hospital_id: string | null;
  hospital_name: string | null;
  first_at: string | Date;
  last_at: string | Date;
  last_cursor: string;
  count: number;
  resources: string[];
  actions: AccessAction[];
  consent_ids: string[];
  break_glass_reason: string | null;
  staff_name: string | null;
  staff_role: StaffRole | null;
};

type ConsentRow = {
  id: string;
  capture_method: ConsentCaptureMethod;
  granted_at: string | Date;
  recorded_by_patient_account_id: string | null;
  emergency_reason: string | null;
};

/** A page boundary: the IST day and the latest moment of the last group shown. */
const CURSOR = /^(\d{4}-\d{2}-\d{2})\|(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)$/;

/** Signing in and out is not access to the record. */
const NOT_ACCESS: AccessAction[] = ['login', 'login_failed', 'logout'];

/**
 * The patient's access history (sp5-plan.md, DF6): everyone else's reads and
 * changes of their record, at every hospital, grouped by day, person and
 * hospital — with the consent or emergency access each rested on.
 *
 * The patient's own portal reads are left out; they would drown the rest. Row-
 * level security admits audit rows about the patient's record ids only, and the
 * names and roles of staff come through the functions that give a patient
 * nothing more about staff than that.
 */
@Injectable()
export class AccessHistoryService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async forOwnRecord(
    patient: PatientActor,
    query: AccessHistoryQuery,
    meta: RequestMeta,
  ): Promise<AccessHistoryPage> {
    let before: { day: string; at: string } | null = null;

    if (query.before) {
      const match = CURSOR.exec(query.before);
      if (!match) throw new BadRequestException('Not a place in the access history');
      before = { day: match[1]!, at: match[2]! };
    }

    const { rows, consents } = await this.db.asPatient(patient.patientId, async (tx) => {
      const found = await tx.execute<GroupRow>(sql`
        WITH entries AS (
          SELECT a.*, app.ist_date(a."at") AS day
            FROM "access_log" a
           WHERE a."patient_id" = ANY (app.patient_record_ids(${patient.patientId}::uuid))
             AND a."outcome" = 'allowed'
             AND a."action"::text NOT IN (${sql.join(
               NOT_ACCESS.map((action) => sql`${action}`),
               sql`, `,
             )})
             AND NOT (a."actor_type" = 'patient' AND a."actor_id" IS NOT DISTINCT FROM ${patient.accountId}::uuid)
        ),
        groups AS (
          SELECT e.day, e."actor_type"::text AS actor_type, e."actor_id", e."hospital_id",
                 max(e."actor_label") AS actor_label,
                 min(e."at") AS first_at, max(e."at") AS last_at, count(*)::int AS count,
                 array_agg(DISTINCT e."resource_type") AS resources,
                 array_agg(DISTINCT e."action"::text) AS actions,
                 coalesce(
                   array_agg(DISTINCT e."consent_artefact_id"::text)
                     FILTER (WHERE e."consent_artefact_id" IS NOT NULL),
                   '{}'
                 ) AS consent_ids,
                 max(e."break_glass_reason") AS break_glass_reason
            FROM entries e
        GROUP BY e.day, e."actor_type", e."actor_id", e."hospital_id"
        )
        SELECT to_char(g.day, 'YYYY-MM-DD') AS day, g.actor_type, g."actor_id", g.actor_label,
               g."hospital_id", h."name" AS hospital_name, g.first_at, g.last_at,
               to_char(g.last_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS last_cursor,
               g.count, g.resources, g.actions, g.consent_ids, g.break_glass_reason,
               CASE WHEN g.actor_type = 'staff' THEN app.staff_name_for_patient(g."actor_id") END AS staff_name,
               CASE WHEN g.actor_type = 'staff' THEN app.staff_role_for_patient(g."actor_id") END AS staff_role
          FROM groups g
          LEFT JOIN "hospital_directory" h ON h."id" = g."hospital_id"
         WHERE ${
           before
             ? sql`(g.day < ${before.day}::date
                    OR (g.day = ${before.day}::date AND g.last_at < ${before.at}::timestamptz))`
             : sql`true`
         }
      ORDER BY g.day DESC, g.last_at DESC
         LIMIT ${query.limit + 1}
      `);

      const list = [...found];
      const ids = [...new Set(list.slice(0, query.limit).flatMap((row) => row.consent_ids))];

      const consentRows =
        ids.length === 0
          ? []
          : [
              ...(await tx.execute<ConsentRow>(sql`
                SELECT ca."id"::text AS id, ca."capture_method"::text AS capture_method,
                       ca."granted_at", ca."recorded_by_patient_account_id"::text AS recorded_by_patient_account_id,
                       ca."emergency_reason"
                  FROM "consent_artefact" ca
                 WHERE ca."id" IN (${sql.join(
                   ids.map((id) => sql`${id}::uuid`),
                   sql`, `,
                 )})
              `)),
            ];

      return { rows: list, consents: new Map(consentRows.map((row) => [row.id, row])) };
    });

    await this.audit.recordForPatient(patient, {
      resourceType: 'access_history',
      action: 'read',
      meta,
    });

    const page = rows.slice(0, query.limit);
    const last = page.at(-1);

    return {
      entries: page.map((row) => this.toEntry(row, consents, patient.accountId)),
      nextBefore: rows.length > query.limit && last ? `${last.day}|${last.last_cursor}` : null,
    };
  }

  private toEntry(
    row: GroupRow,
    consents: Map<string, ConsentRow>,
    accountId: string,
  ): AccessHistoryEntry {
    return {
      id: `${row.day}|${row.actor_type}|${row.actor_id ?? ''}|${row.hospital_id ?? ''}`,
      day: row.day,
      firstAt: toIso(row.first_at),
      lastAt: toIso(row.last_at),
      actor:
        row.actor_type === 'staff'
          ? { kind: 'staff', name: row.staff_name, role: row.staff_role }
          : row.actor_type === 'patient'
            ? // Another phone with access to this record: a family member, or the patient's other phone.
              { kind: 'patient', label: row.actor_label?.replace(/^patient portal\s*/, '') ?? null }
            : { kind: 'system' },
      hospital: row.hospital_id
        ? { id: row.hospital_id, name: row.hospital_name ?? 'Unknown hospital' }
        : null,
      resources: [...row.resources].sort(),
      actions: [...row.actions].sort(),
      count: row.count,
      emergencyReason: row.break_glass_reason,
      consents: row.consent_ids.flatMap((id) => {
        const consent = consents.get(id);
        return consent
          ? [
              {
                id,
                captureMethod: consent.capture_method,
                grantedAt: toIso(consent.granted_at),
                grantedByYou: consent.recorded_by_patient_account_id === accountId,
                emergencyReason: consent.emergency_reason,
              },
            ]
          : [];
      }),
    };
  }
}
