import { Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import {
  LOINC_SYSTEM,
  NOTE_TEMPLATES,
  VITAL_SIGNS,
  VITAL_SIGN_KEYS,
  type ClinicalDataCategory,
  type EncounterClass,
  type NoteTemplateKey,
  type SystemOfMedicine,
  type TimelineItem,
  type TimelineKind,
  type TimelinePage,
  type TimelineQuery,
  type VitalSignKey,
} from '@health24/shared';
import { DatabaseService } from '../../db/database.service';
import { requireHospital, type Actor, type RequestMeta } from '../../common/actor';
import { AuditService } from '../audit/audit.service';
import { coveringConsentId, requireLinkedPatient, toIso } from './clinical-access';

type TimelineRow = {
  kind: TimelineKind;
  id: string;
  hospital_id: string;
  hospital_name: string | null;
  encounter_id: string | null;
  occurred_at: string | Date;
  /** occurred_at to the microsecond, so paging never skips an entry in the same millisecond. */
  occurred_cursor: string;
  system_of_medicine: SystemOfMedicine | null;
  title: string | null;
  detail: string | null;
  readings: Array<{ code: string; value: string; unit: string | null }> | null;
  clinician_id: string;
  clinician_name: string | null;
  entry_source: 'direct' | 'transcribed';
  entered_by_id: string;
  entered_by_name: string | null;
  category: ClinicalDataCategory;
  corrected: boolean;
  template: string | null;
};

const CLASS_LABELS: Record<EncounterClass, string> = {
  outpatient: 'OPD encounter',
  inpatient: 'IPD admission',
  emergency: 'Emergency encounter',
  teleconsultation: 'Teleconsultation',
};

const UNIT_LABELS: Record<string, string> = {
  'mm[Hg]': 'mmHg',
  Cel: '°C',
  'kg/m2': 'kg/m²',
};

const KEY_BY_CODE = new Map<string, VitalSignKey>(
  VITAL_SIGN_KEYS.map((key) => [VITAL_SIGNS[key].code, key]),
);

/** "BP 130/85 mmHg · Pulse 78 /min · …" from a set's readings. */
export function describeVitals(
  readings: Array<{ code: string; value: string; unit: string | null }>,
): string {
  const byKey = new Map(
    readings.flatMap((reading) => {
      const key = KEY_BY_CODE.get(reading.code);
      return key ? [[key, reading] as const] : [];
    }),
  );

  const unit = (value: string | null) => (value ? (UNIT_LABELS[value] ?? value) : '');
  const parts: string[] = [];
  const systolic = byKey.get('systolic');
  const diastolic = byKey.get('diastolic');

  if (systolic && diastolic) {
    parts.push(`BP ${systolic.value}/${diastolic.value} ${unit(systolic.unit)}`);
  }

  for (const key of VITAL_SIGN_KEYS) {
    if (key === 'systolic' || key === 'diastolic') continue;
    const reading = byKey.get(key);
    if (reading)
      parts.push(`${VITAL_SIGNS[key].label} ${reading.value} ${unit(reading.unit)}`.trim());
  }

  return parts.join(' · ');
}

/**
 * The timeline: one chronological stream of a patient's record across every
 * hospital the caller may see.
 *
 * A query, not a materialised projection (sp3-plan.md): each branch reads a
 * clinical table under the caller's row-level security, so another hospital's
 * entries appear exactly where consent — or emergency access — covers their
 * category and date. The interface is fixed here so a projection can replace
 * the query later without touching callers.
 */
@Injectable()
export class TimelineService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async forPatient(
    actor: Actor,
    patientId: string,
    query: TimelineQuery,
    meta: RequestMeta,
  ): Promise<TimelinePage> {
    const hospitalId = requireHospital(actor);
    const ids = sql`app.patient_record_ids(${patientId}::uuid)`;

    const union = sql`
      SELECT 'encounter'::text AS kind, e."id", e."hospital_id", e."id" AS encounter_id,
             e."started_at" AS occurred_at, e."system_of_medicine"::text AS system_of_medicine,
             e."class"::text AS title,
             concat_ws(' · ', e."chief_complaint", replace(e."status"::text, '_', ' ')) AS detail,
             NULL::json AS readings, e."attending_staff_id" AS clinician_id,
             e."entry_source"::text AS entry_source, e."recorded_by_staff_id" AS entered_by_id,
             'encounters'::text AS category, false AS corrected, NULL::text AS template
        FROM "encounter" e
       WHERE e."patient_id" = ANY (${ids})

      UNION ALL
      SELECT 'diagnosis', c."id", c."hospital_id", c."encounter_id", c."recorded_at",
             en."system_of_medicine"::text,
             (SELECT cc."display" || ' (' || cc."code" || ')' FROM "condition_coding" cc
               WHERE cc."condition_id" = c."id" AND cc."role" = 'primary'),
             concat_ws(' · ',
               (SELECT 'TM2 ' || cc."display" || ' (' || cc."code" || ')' FROM "condition_coding" cc
                 WHERE cc."condition_id" = c."id" AND cc."role" = 'translated'),
               CASE WHEN c."is_primary" THEN 'primary diagnosis' END,
               CASE WHEN c."verification_status" = 'provisional' THEN 'provisional' END,
               CASE WHEN c."clinical_status" <> 'active' THEN c."clinical_status"::text END),
             NULL::json, c."attributed_clinician_id", c."entry_source"::text,
             c."recorded_by_staff_id", 'diagnoses', c."supersedes_id" IS NOT NULL, NULL
        FROM "condition" c
        LEFT JOIN "encounter" en ON en."id" = c."encounter_id"
       WHERE c."patient_id" = ANY (${ids}) AND c."version_status" = 'current'

      UNION ALL
      SELECT 'prescription', r."id", r."hospital_id", r."encounter_id", r."recorded_at",
             r."system_of_medicine"::text,
             r."medicine_name" || coalesce(' ' || r."strength", ''),
             concat_ws(' · ',
               CASE WHEN r."dose_quantity" IS NOT NULL
                    THEN trim_scale(r."dose_quantity")::text || ' ' || r."dose_unit" END,
               r."frequency",
               replace(r."route"::text, '_', ' '),
               CASE WHEN r."duration_value" IS NOT NULL
                    THEN 'for ' || r."duration_value" || ' ' || r."duration_unit"::text END,
               CASE WHEN r."status" <> 'active' THEN r."status"::text END),
             NULL::json, r."attributed_clinician_id", r."entry_source"::text,
             r."recorded_by_staff_id", 'medications', r."supersedes_id" IS NOT NULL, NULL
        FROM "medication_request" r
       WHERE r."patient_id" = ANY (${ids}) AND r."version_status" = 'current'

      UNION ALL
      SELECT 'allergy', a."id", a."hospital_id", a."encounter_id", a."recorded_at", NULL::text,
             'Allergy: ' || a."substance",
             concat_ws(' · ',
               CASE a."criticality" WHEN 'high' THEN 'high risk' WHEN 'low' THEN 'low risk'
                    ELSE 'risk not assessed' END,
               a."reaction",
               CASE WHEN a."clinical_status" <> 'active' THEN a."clinical_status"::text END),
             NULL::json, a."attributed_clinician_id", a."entry_source"::text,
             a."recorded_by_staff_id", 'allergies', a."supersedes_id" IS NOT NULL, NULL
        FROM "allergy_intolerance" a
       WHERE a."patient_id" = ANY (${ids}) AND a."version_status" = 'current'

      UNION ALL
      SELECT 'vitals', o."group_id", min(o."hospital_id"::text)::uuid,
             min(o."encounter_id"::text)::uuid, max(o."effective_at"), NULL::text,
             'Vitals', NULL::text,
             json_agg(json_build_object(
               'code', o."code",
               'value', trim_scale(o."value_quantity")::text,
               'unit', o."unit")),
             min(o."attributed_clinician_id"::text)::uuid, min(o."entry_source"::text),
             min(o."recorded_by_staff_id"::text)::uuid, 'observations', false, NULL
        FROM "observation" o
       WHERE o."patient_id" = ANY (${ids}) AND o."version_status" = 'current'
         AND o."group_id" IS NOT NULL AND o."code_system" = ${LOINC_SYSTEM}
       GROUP BY o."group_id"

      UNION ALL
      SELECT 'note', n."id", n."hospital_id", n."encounter_id", n."recorded_at",
             en."system_of_medicine"::text, n."title", left(n."body", 280),
             NULL::json, n."attributed_clinician_id", n."entry_source"::text,
             n."recorded_by_staff_id", 'notes', n."supersedes_id" IS NOT NULL, n."template"
        FROM "clinical_note" n
        LEFT JOIN "encounter" en ON en."id" = n."encounter_id"
       WHERE n."patient_id" = ANY (${ids}) AND n."version_status" = 'current'

      UNION ALL
      SELECT 'procedure', p."id", p."hospital_id", p."encounter_id", p."performed_at",
             p."system_of_medicine"::text, p."name", p."outcome",
             NULL::json, p."attributed_clinician_id", p."entry_source"::text,
             p."recorded_by_staff_id", 'procedures', p."supersedes_id" IS NOT NULL, NULL
        FROM "procedure" p
       WHERE p."patient_id" = ANY (${ids}) AND p."version_status" = 'current'
    `;

    const filters: SQL[] = [sql`true`];

    if (query.categories && query.categories.length > 0) {
      filters.push(
        sql`t."category" IN (${sql.join(
          query.categories.map((category) => sql`${category}`),
          sql`, `,
        )})`,
      );
    }

    if (query.scope === 'own') {
      filters.push(sql`t."hospital_id" = ${hospitalId}::uuid`);
    }

    if (query.before) {
      filters.push(sql`t."occurred_at" < ${query.before}::timestamptz`);
    }

    const { rows, consentByCategory } = await this.db.asTenant(hospitalId, async (tx) => {
      await requireLinkedPatient(tx, hospitalId, patientId);

      const found = await tx.execute<TimelineRow>(sql`
        SELECT t.*,
               to_char(t."occurred_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_cursor,
               d."name" AS hospital_name, cl."name" AS clinician_name,
               eb."name" AS entered_by_name
          FROM (${union}) t
          LEFT JOIN "hospital_directory" d ON d."id" = t."hospital_id"
          LEFT JOIN "staff_user" cl ON cl."id" = t."clinician_id"
          LEFT JOIN "staff_user" eb ON eb."id" = t."entered_by_id"
         WHERE ${sql.join(filters, sql` AND `)}
      ORDER BY t."occurred_at" DESC, t."id" DESC
         LIMIT ${query.limit + 1}
      `);

      const list = [...found];

      // Which categories other hospitals share, and on which consent: named in
      // the audit trail, and returned so the screen can say what may be missing.
      const consents = new Map<ClinicalDataCategory, string | null>();
      const categories: ClinicalDataCategory[] = [
        'encounters',
        'diagnoses',
        'medications',
        'allergies',
        'observations',
        'notes',
        'procedures',
      ];

      for (const category of categories) {
        consents.set(category, await coveringConsentId(tx, patientId, category));
      }

      return { rows: list, consentByCategory: consents };
    });

    const page = rows.slice(0, query.limit);
    const hasMore = rows.length > query.limit;

    const sharedReads = [
      ...new Set(page.filter((row) => row.hospital_id !== hospitalId).map((row) => row.category)),
    ];

    if (sharedReads.length === 0) {
      await this.audit.recordForActor(actor, {
        resourceType: 'timeline',
        patientId,
        action: 'read',
        meta,
      });
    } else {
      for (const category of sharedReads) {
        await this.audit.recordForActor(actor, {
          resourceType: 'timeline',
          resourceId: category,
          patientId,
          action: 'read',
          consentArtefactId: consentByCategory.get(category) ?? null,
          meta,
        });
      }
    }

    const last = page.at(-1);

    return {
      items: page.map((row) => this.toItem(row, hospitalId)),
      nextBefore: hasMore && last ? last.occurred_cursor : null,
      sharedCategories: [...consentByCategory.entries()]
        .filter(([, consentId]) => consentId !== null)
        .map(([category]) => category),
    };
  }

  private toItem(row: TimelineRow, hospitalId: string): TimelineItem {
    let title = row.title ?? '';
    let detail = row.detail;

    if (row.kind === 'encounter') {
      title = CLASS_LABELS[row.title as EncounterClass] ?? 'Encounter';
    } else if (row.kind === 'vitals') {
      detail = row.readings ? describeVitals(row.readings) : null;
    } else if (row.kind === 'note') {
      title =
        row.title ?? NOTE_TEMPLATES[row.template as NoteTemplateKey]?.label ?? 'Clinical note';
    }

    return {
      kind: row.kind,
      id: row.id,
      at: toIso(row.occurred_at),
      category: row.category,
      hospital: {
        id: row.hospital_id,
        name: row.hospital_name ?? 'Unknown hospital',
        isOwn: row.hospital_id === hospitalId,
      },
      encounterId: row.encounter_id,
      systemOfMedicine: row.system_of_medicine,
      title,
      detail: detail && detail.trim() ? detail : null,
      clinician: { id: row.clinician_id, name: row.clinician_name },
      entry: {
        source: row.entry_source,
        enteredBy: { id: row.entered_by_id, name: row.entered_by_name },
      },
      corrected: row.corrected,
    };
  }
}
