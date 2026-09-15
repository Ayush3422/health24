import { Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import {
  LAB_PANELS,
  LOINC_SYSTEM,
  NOTE_TEMPLATES,
  VITAL_SIGNS,
  VITAL_SIGN_KEYS,
  findAnalyte,
  type ClinicalDataCategory,
  type DocumentType,
  type EncounterClass,
  type LabPanelKey,
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

type Reading = { code: string; value: string; unit: string | null; interpretation?: string | null };

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
  readings: Reading[] | null;
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

const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  lab_report: 'Lab report',
  radiology: 'Radiology',
  discharge_summary: 'Discharge summary',
  prescription: 'Prescription',
  operative_note: 'Operative note',
  referral: 'Referral',
  bill_or_receipt: 'Bill or receipt',
  other: 'Document',
};

const UNIT_LABELS: Record<string, string> = {
  'mm[Hg]': 'mmHg',
  Cel: '°C',
  'kg/m2': 'kg/m²',
};

/** The most rows one vital-sign set or lab set can have: a page reads this many per set. */
const VITAL_READINGS_PER_SET = VITAL_SIGN_KEYS.length;
const LAB_RESULTS_PER_SET = Math.max(
  ...Object.values(LAB_PANELS).map((panel) => panel.analytes.length),
);

const KEY_BY_CODE = new Map<string, VitalSignKey>(
  VITAL_SIGN_KEYS.map((key) => [VITAL_SIGNS[key].code, key]),
);

/**
 * "ALT (SGPT) 82 U/L high · 3 tests" from a lab set's results: the values
 * outside their range first, since those are what a clinician looks for.
 */
export function describeResults(readings: Reading[]): string {
  const count = `${readings.length} ${readings.length === 1 ? 'test' : 'tests'}`;
  const outside = readings.filter(
    (reading) => reading.interpretation && reading.interpretation !== 'normal',
  );

  if (outside.length === 0) {
    return readings.every((reading) => reading.interpretation === 'normal')
      ? `${count}, all within range`
      : count;
  }

  return [
    ...outside.map((reading) =>
      [
        findAnalyte(reading.code)?.analyte.label ?? reading.code,
        reading.value,
        reading.unit ?? '',
        reading.interpretation,
      ]
        .filter(Boolean)
        .join(' '),
    ),
    count,
  ].join(' · ');
}

/** "BP 130/85 mmHg · Pulse 78 /min · …" from a set's readings. */
export function describeVitals(readings: Reading[]): string {
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
    const limit = query.limit + 1;

    // Each branch reads only the newest rows that could reach this page: an
    // index scan in time order per record id, stopping at the page size. The
    // page is still exact — the newest `limit` entries overall are among each
    // branch's newest `limit` — but row-level security, and so consent, is
    // evaluated for a page's worth of rows rather than the whole history.
    const window = (time: SQL, hospital: SQL): SQL =>
      sql`${query.before ? sql`AND ${time} < ${query.before}::timestamptz` : sql``} ${
        query.scope === 'own' ? sql`AND ${hospital} = ${hospitalId}::uuid` : sql``
      }`;

    const union = sql`
      WITH pids AS (SELECT unnest(app.patient_record_ids(${patientId}::uuid)) AS id)
      SELECT 'encounter'::text AS kind, e."id", e."hospital_id", e."id" AS encounter_id,
             e."started_at" AS occurred_at, e."system_of_medicine"::text AS system_of_medicine,
             e."class"::text AS title,
             concat_ws(' · ', e."chief_complaint", replace(e."status"::text, '_', ' ')) AS detail,
             NULL::json AS readings, e."attending_staff_id" AS clinician_id,
             e."entry_source"::text AS entry_source, e."recorded_by_staff_id" AS entered_by_id,
             'encounters'::text AS category, false AS corrected, NULL::text AS template
        FROM pids CROSS JOIN LATERAL (
          SELECT * FROM "encounter" x
           WHERE x."patient_id" = pids.id ${window(sql`x."started_at"`, sql`x."hospital_id"`)}
           ORDER BY x."started_at" DESC LIMIT ${limit}
        ) e

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
        FROM pids CROSS JOIN LATERAL (
          SELECT * FROM "condition" x
           WHERE x."patient_id" = pids.id AND x."version_status" = 'current'
                 ${window(sql`x."recorded_at"`, sql`x."hospital_id"`)}
           ORDER BY x."recorded_at" DESC LIMIT ${limit}
        ) c
        LEFT JOIN "encounter" en ON en."id" = c."encounter_id"

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
        FROM pids CROSS JOIN LATERAL (
          SELECT * FROM "medication_request" x
           WHERE x."patient_id" = pids.id AND x."version_status" = 'current'
                 ${window(sql`x."recorded_at"`, sql`x."hospital_id"`)}
           ORDER BY x."recorded_at" DESC LIMIT ${limit}
        ) r

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
        FROM pids CROSS JOIN LATERAL (
          SELECT * FROM "allergy_intolerance" x
           WHERE x."patient_id" = pids.id AND x."version_status" = 'current'
                 ${window(sql`x."recorded_at"`, sql`x."hospital_id"`)}
           ORDER BY x."recorded_at" DESC LIMIT ${limit}
        ) a

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
        FROM pids CROSS JOIN LATERAL (
          -- Enough readings for a page of complete sets.
          SELECT * FROM "observation" x
           WHERE x."patient_id" = pids.id AND x."category" = 'vital_signs'
             AND x."version_status" = 'current' AND x."group_id" IS NOT NULL
             AND x."code_system" = ${LOINC_SYSTEM}
                 ${window(sql`x."effective_at"`, sql`x."hospital_id"`)}
           ORDER BY x."effective_at" DESC LIMIT ${limit * VITAL_READINGS_PER_SET}
        ) o
       GROUP BY o."group_id"

      UNION ALL
      SELECT 'note', n."id", n."hospital_id", n."encounter_id", n."recorded_at",
             en."system_of_medicine"::text, n."title", left(n."body", 280),
             NULL::json, n."attributed_clinician_id", n."entry_source"::text,
             n."recorded_by_staff_id", 'notes', n."supersedes_id" IS NOT NULL, n."template"
        FROM pids CROSS JOIN LATERAL (
          SELECT * FROM "clinical_note" x
           WHERE x."patient_id" = pids.id AND x."version_status" = 'current'
                 ${window(sql`x."recorded_at"`, sql`x."hospital_id"`)}
           ORDER BY x."recorded_at" DESC LIMIT ${limit}
        ) n
        LEFT JOIN "encounter" en ON en."id" = n."encounter_id"

      UNION ALL
      SELECT 'procedure', p."id", p."hospital_id", p."encounter_id", p."performed_at",
             p."system_of_medicine"::text, p."name", p."outcome",
             NULL::json, p."attributed_clinician_id", p."entry_source"::text,
             p."recorded_by_staff_id", 'procedures', p."supersedes_id" IS NOT NULL, NULL
        FROM pids CROSS JOIN LATERAL (
          SELECT * FROM "procedure" x
           WHERE x."patient_id" = pids.id AND x."version_status" = 'current'
                 ${window(sql`x."performed_at"`, sql`x."hospital_id"`)}
           ORDER BY x."performed_at" DESC LIMIT ${limit}
        ) p

      -- A document sits on the date printed on it, at midday in India; only one
      -- that scanned clean, since nothing else can be opened.
      UNION ALL
      SELECT 'document', d."id", d."hospital_id", d."encounter_id",
             (d."report_date"::timestamp + interval '12 hours') AT TIME ZONE 'Asia/Kolkata',
             NULL::text, d."doc_type"::text,
             concat_ws(' · ', d."title", d."performing_facility",
               CASE WHEN d."ordering_clinician_name" IS NOT NULL
                    THEN 'ordered by ' || d."ordering_clinician_name" END),
             NULL::json, coalesce(d."ordering_clinician_id", d."recorded_by_staff_id"), 'direct',
             d."recorded_by_staff_id", 'documents', d."supersedes_id" IS NOT NULL, NULL
        FROM pids CROSS JOIN LATERAL (
          SELECT * FROM "document_reference" x
           WHERE x."patient_id" = pids.id AND x."version_status" = 'current'
             AND x."availability" = 'available'
                 ${window(
                   sql`((x."report_date"::timestamp + interval '12 hours') AT TIME ZONE 'Asia/Kolkata')`,
                   sql`x."hospital_id"`,
                 )}
           ORDER BY x."report_date" DESC LIMIT ${limit}
        ) d

      -- A lab set is one entry, when its sample was collected. Attributed to
      -- whoever typed it, as the results themselves are (DF7).
      UNION ALL
      SELECT 'result', o."group_id", min(o."hospital_id"::text)::uuid,
             min(o."encounter_id"::text)::uuid, max(o."effective_at"), NULL::text,
             min(o."panel_code"::text), NULL::text,
             json_agg(json_build_object(
               'code', o."code",
               'value', trim_scale(o."value_quantity")::text,
               'unit', o."unit",
               'interpretation', o."interpretation"::text)),
             min(coalesce(o."attributed_clinician_id", o."recorded_by_staff_id")::text)::uuid,
             min(o."entry_source"::text), min(o."recorded_by_staff_id"::text)::uuid,
             'observations', false, NULL
        FROM pids CROSS JOIN LATERAL (
          -- Enough results for a page of complete sets.
          SELECT * FROM "observation" x
           WHERE x."patient_id" = pids.id AND x."category" = 'laboratory'
             AND x."version_status" = 'current' AND x."group_id" IS NOT NULL
                 ${window(sql`x."effective_at"`, sql`x."hospital_id"`)}
           ORDER BY x."effective_at" DESC LIMIT ${limit * LAB_RESULTS_PER_SET}
        ) o
       GROUP BY o."group_id"
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
        'documents',
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
    } else if (row.kind === 'document') {
      title = DOCUMENT_TYPE_LABELS[row.title as DocumentType] ?? 'Document';
    } else if (row.kind === 'result') {
      title = LAB_PANELS[row.title as LabPanelKey]?.label ?? 'Lab results';
      detail = row.readings ? describeResults(row.readings) : null;
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
