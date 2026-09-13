import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import {
  NOTE_TEMPLATES,
  hasPermission,
  type ClinicalDataCategory,
  type CorrectableKind,
  type NoteTemplateKey,
  type VersionHistoryEntry,
  type VersionStatus,
} from '@health24/shared';
import { DatabaseService } from '../../db/database.service';
import type { DbTransaction } from '../../db/client';
import { requireHospital, type Actor, type RequestMeta } from '../../common/actor';
import { AuditService } from '../audit/audit.service';
import { coveringConsentId, resolveAttribution, toIso, type Attribution } from './clinical-access';

/**
 * Corrections, shared by every kind of clinical entry.
 *
 * Nothing clinical is edited or deleted. A correction marks the entry
 * superseded and writes a new version pointing back at it; a mistake is marked
 * entered in error. The database enforces the same rules — only forward
 * moves, a reason recorded, a successor for every superseded entry — so these
 * helpers turn a refused change into a clear answer rather than a constraint
 * error.
 */

/** The tables behind each kind, vitals included. Never built from user input. */
const TABLES = {
  diagnoses: 'condition',
  prescriptions: 'medication_request',
  allergies: 'allergy_intolerance',
  notes: 'clinical_note',
  procedures: 'procedure',
  vitals: 'observation',
} as const;

export type ChangeableKind = keyof typeof TABLES;

const CATEGORIES: Record<ChangeableKind, ClinicalDataCategory> = {
  diagnoses: 'diagnoses',
  prescriptions: 'medications',
  allergies: 'allergies',
  notes: 'notes',
  procedures: 'procedures',
  vitals: 'observations',
};

/** One line describing a version, per kind, over the table aliased `r`. */
const LABELS: Record<CorrectableKind, SQL> = {
  diagnoses: sql`coalesce((
      SELECT cc."display" || ' (' || cc."code" || ')'
        FROM "condition_coding" cc
       WHERE cc."condition_id" = r."id" AND cc."role" = 'primary'
    ), 'Diagnosis') || ' · ' || r."clinical_status"::text`,
  prescriptions: sql`r."medicine_name" || coalesce(' ' || r."strength", '') || ' · ' || r."frequency"
    || ' · ' || r."status"::text`,
  allergies: sql`r."substance" || ' · ' || r."criticality"::text || ' · ' || r."clinical_status"::text`,
  notes: sql`coalesce(r."title", r."template")`,
  procedures: sql`r."name" || ' · ' || to_char(r."performed_at" AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI')`,
};

/**
 * The history label as shown. An untitled note's label is its template key,
 * which means nothing to a clinician; it is replaced by the template's name.
 */
export function historyLabel(kind: CorrectableKind, label: string | null): string {
  if (!label) return '';

  if (kind === 'notes' && label in NOTE_TEMPLATES) {
    return NOTE_TEMPLATES[label as NoteTemplateKey].label;
  }

  return label;
}

export type ChangeableRow = {
  id: string;
  patient_id: string;
  hospital_id: string;
  encounter_id: string | null;
  version_status: VersionStatus;
  recorded_by_staff_id: string;
  attributed_clinician_id: string;
  entry_source: 'direct' | 'transcribed';
};

/**
 * Loads an entry the caller is about to correct or mark entered in error, and
 * refuses the change when it is not theirs to make:
 *
 *   - another hospital's entry — only the recording hospital corrects its own;
 *   - an entry already corrected or marked in error — only the current version
 *     changes;
 *   - for records staff, an entry someone else typed — they fix their own
 *     transcription, not a clinician's decision.
 */
export async function loadForChange(
  tx: DbTransaction,
  kind: ChangeableKind,
  id: string,
  actor: Actor,
  hospitalId: string,
): Promise<ChangeableRow> {
  const [row] = await tx.execute<ChangeableRow>(sql`
    SELECT "id", "patient_id", "hospital_id", "encounter_id", "version_status",
           "recorded_by_staff_id", "attributed_clinician_id", "entry_source"
      FROM ${sql.identifier(TABLES[kind])}
     WHERE "id" = ${id}::uuid
  `);

  if (!row) throw new NotFoundException('Entry not found');

  if (row.hospital_id !== hospitalId) {
    throw new ForbiddenException('Only the hospital that recorded an entry can change it');
  }

  if (row.version_status !== 'current') {
    throw new ConflictException(
      row.version_status === 'superseded'
        ? 'This version has already been corrected; change the current version instead'
        : 'This entry has already been marked entered in error',
    );
  }

  if (
    !hasPermission(actor.role, 'clinical:write') &&
    row.recorded_by_staff_id !== actor.staffUserId
  ) {
    throw new ForbiddenException('Records staff can change only the entries they typed');
  }

  return row;
}

/** Moves the current version on: superseded by a correction, or entered in error. */
export async function retire(
  tx: DbTransaction,
  kind: ChangeableKind,
  id: string,
  actor: Actor,
  reason: string,
  status: 'superseded' | 'entered_in_error',
): Promise<void> {
  const updated = await tx.execute<{ id: string }>(sql`
    UPDATE ${sql.identifier(TABLES[kind])}
       SET "version_status" = ${status},
           "status_changed_at" = now(),
           "status_changed_by_staff_id" = ${actor.staffUserId}::uuid,
           "status_reason" = ${reason}
     WHERE "id" = ${id}::uuid AND "version_status" = 'current'
    RETURNING "id"
  `);

  if (updated.length === 0) {
    throw new ConflictException('This entry was changed by someone else a moment ago');
  }
}

/**
 * Whose name a correction goes in. A clinician correcting takes it in their
 * own name. Records staff correcting their own typing keep it in the name of
 * the clinician the entry already belonged to.
 */
export function attributionForCorrection(
  tx: DbTransaction,
  actor: Actor,
  hospitalId: string,
  original: ChangeableRow,
): Promise<Attribution> {
  return resolveAttribution(
    tx,
    actor,
    hospitalId,
    hasPermission(actor.role, 'clinical:write') ? undefined : original.attributed_clinician_id,
  );
}

type HistoryRow = {
  id: string;
  version: number;
  version_status: VersionStatus;
  label: string | null;
  hospital_id: string;
  hospital_name: string | null;
  patient_id: string;
  recorded_at: string | Date;
  attributed_clinician_id: string;
  clinician_name: string | null;
  entry_source: 'direct' | 'transcribed';
  recorded_by_staff_id: string;
  entered_by_name: string | null;
  status_changed_at: string | Date | null;
  status_changed_by_staff_id: string | null;
  status_changed_by_name: string | null;
  status_reason: string | null;
};

@Injectable()
export class CorrectionsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async markEnteredInError(
    actor: Actor,
    kind: CorrectableKind,
    id: string,
    reason: string,
    meta: RequestMeta,
  ): Promise<{ id: string; versionStatus: 'entered_in_error' }> {
    const hospitalId = requireHospital(actor);

    const patientId = await this.db.asTenant(hospitalId, async (tx) => {
      const row = await loadForChange(tx, kind, id, actor, hospitalId);
      await retire(tx, kind, id, actor, reason, 'entered_in_error');
      return row.patient_id;
    });

    await this.audit.recordForActor(actor, {
      resourceType: TABLES[kind],
      resourceId: id,
      patientId,
      action: 'update',
      meta,
    });

    return { id, versionStatus: 'entered_in_error' };
  }

  /**
   * Every version of an entry, oldest first, reached from any one of them.
   * Visible exactly where the entry is: another hospital's history appears
   * only under consent, and is audited as such.
   */
  async history(
    actor: Actor,
    kind: CorrectableKind,
    id: string,
    meta: RequestMeta,
  ): Promise<VersionHistoryEntry[]> {
    const hospitalId = requireHospital(actor);
    const table = sql.identifier(TABLES[kind]);

    const { rows, consentArtefactId } = await this.db.asTenant(hospitalId, async (tx) => {
      const found = await tx.execute<HistoryRow>(sql`
        WITH RECURSIVE up AS (
          SELECT t."id", t."supersedes_id", 0 AS depth FROM ${table} t WHERE t."id" = ${id}::uuid
          UNION ALL
          SELECT t."id", t."supersedes_id", up.depth + 1
            FROM ${table} t JOIN up ON t."id" = up."supersedes_id"
           WHERE up.depth < 100
        ),
        root AS (SELECT "id" FROM up ORDER BY depth DESC LIMIT 1),
        down AS (
          SELECT root."id", 1 AS version FROM root
          UNION ALL
          SELECT t."id", down.version + 1
            FROM ${table} t JOIN down ON t."supersedes_id" = down."id"
           WHERE down.version < 100
        )
        SELECT r."id", down.version, r."version_status", (${LABELS[kind]}) AS label,
               r."hospital_id", d."name" AS hospital_name, r."patient_id", r."recorded_at",
               r."attributed_clinician_id", cl."name" AS clinician_name, r."entry_source",
               r."recorded_by_staff_id", eb."name" AS entered_by_name,
               r."status_changed_at", r."status_changed_by_staff_id",
               sc."name" AS status_changed_by_name, r."status_reason"
          FROM down
          JOIN ${table} r ON r."id" = down."id"
          LEFT JOIN "hospital_directory" d ON d."id" = r."hospital_id"
          LEFT JOIN "staff_user" cl ON cl."id" = r."attributed_clinician_id"
          LEFT JOIN "staff_user" eb ON eb."id" = r."recorded_by_staff_id"
          LEFT JOIN "staff_user" sc ON sc."id" = r."status_changed_by_staff_id"
      ORDER BY down.version
      `);

      const list = [...found];
      const first = list[0];

      if (!first) throw new NotFoundException('Entry not found');

      return {
        rows: list,
        consentArtefactId:
          first.hospital_id !== hospitalId
            ? await coveringConsentId(tx, first.patient_id, CATEGORIES[kind])
            : null,
      };
    });

    await this.audit.recordForActor(actor, {
      resourceType: TABLES[kind],
      resourceId: id,
      patientId: rows[0]?.patient_id ?? null,
      action: 'read',
      consentArtefactId,
      meta,
    });

    return rows.map((row) => ({
      id: row.id,
      version: Number(row.version),
      versionStatus: row.version_status,
      label: historyLabel(kind, row.label),
      hospital: {
        id: row.hospital_id,
        name: row.hospital_name ?? 'Unknown hospital',
        isOwn: row.hospital_id === hospitalId,
      },
      recordedAt: toIso(row.recorded_at),
      recordedBy: { id: row.attributed_clinician_id, name: row.clinician_name },
      entry: {
        source: row.entry_source,
        enteredBy: { id: row.recorded_by_staff_id, name: row.entered_by_name },
      },
      statusChangedAt: row.status_changed_at ? toIso(row.status_changed_at) : null,
      statusChangedBy: row.status_changed_by_staff_id
        ? { id: row.status_changed_by_staff_id, name: row.status_changed_by_name }
        : null,
      statusReason: row.status_reason,
    }));
  }
}
