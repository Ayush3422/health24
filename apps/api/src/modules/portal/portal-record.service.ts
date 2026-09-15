import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { findAnalyte, type EncounterClass, type PortalSummary } from '@health24/shared';
import type { PatientActor, RequestMeta } from '../../common/actor';
import type { DbTransaction } from '../../db/client';
import { DatabaseService } from '../../db/database.service';
import { AuditService } from '../audit/audit.service';
import { toIso } from '../clinical/clinical-access';

const ABNORMAL_RESULTS_SHOWN = 5;
const LIST_LIMIT = 20;

/** Whole years between a birth date and today, in India Standard Time. */
export function ageInYears(dateOfBirth: string, today: string): number {
  const [birthYear, birthMonth, birthDay] = dateOfBirth.split('-').map(Number) as [number, number, number];
  const [year, month, day] = today.split('-').map(Number) as [number, number, number];
  const hadBirthday = month > birthMonth || (month === birthMonth && day >= birthDay);
  return year - birthYear - (hadBirthday ? 0 : 1);
}

const istToday = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

/** Who the patient is, and what anyone treating them must know first. */
export interface RecordEssentials {
  name: string;
  ageYears: number | null;
  bloodGroup: string | null;
  emergencyContact: { name: string; phone: string } | null;
  allergies: PortalSummary['allergies'];
  problems: PortalSummary['problems'];
  medicines: PortalSummary['medicines'];
}

const hospitalName = (name: string | null) => name ?? 'Unknown hospital';

/**
 * A patient's own record, read in the portal (SP5).
 *
 * Every query runs in the patient's context: row-level security admits their
 * rows at every hospital, across merged record ids, and nothing else — so
 * nothing here filters by hospital or asks about consent.
 */
@Injectable()
export class PortalRecordService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async summary(actor: PatientActor, meta: RequestMeta): Promise<PortalSummary> {
    const ids = sql`app.patient_record_ids(${actor.patientId}::uuid)`;

    const summary = await this.db.asPatient(actor.patientId, async (tx) => {
      const essentials = await this.readEssentials(tx, actor.patientId);

      const results = await tx.execute<{
        id: string;
        code: string;
        display: string;
        value: string;
        unit: string;
        interpretation: string;
        effective_at: string | Date;
        hospital_name: string | null;
      }>(sql`
        SELECT o."id", o."code", o."display", o."value_quantity"::text AS value, o."unit",
               o."interpretation"::text AS interpretation, o."effective_at", h."name" AS hospital_name
          FROM "observation" o
          LEFT JOIN "hospital_directory" h ON h."id" = o."hospital_id"
         WHERE o."patient_id" = ANY (${ids}) AND o."category" = 'laboratory'
           AND o."version_status" = 'current'
           AND o."interpretation" IN ('high', 'low', 'abnormal')
      ORDER BY o."effective_at" DESC
         LIMIT ${ABNORMAL_RESULTS_SHOWN}
      `);

      const [lastVisit] = await tx.execute<{
        started_at: string | Date;
        class: EncounterClass;
        hospital_name: string | null;
      }>(sql`
        SELECT e."started_at", e."class", h."name" AS hospital_name
          FROM "encounter" e
          LEFT JOIN "hospital_directory" h ON h."id" = e."hospital_id"
         WHERE e."patient_id" = ANY (${ids}) AND e."status" <> 'cancelled'
      ORDER BY e."started_at" DESC
         LIMIT 1
      `);

      const hospitals = await tx.execute<{ id: string; name: string; mrn: string }>(sql`
        SELECT l."hospital_id" AS id, h."name", l."mrn"
          FROM "patient_hospital_link" l
          JOIN "hospital_directory" h ON h."id" = l."hospital_id"
         WHERE l."patient_id" = ANY (${ids})
      ORDER BY l."first_seen_at"
      `);

      return {
        patient: { name: essentials.name, ageYears: essentials.ageYears },
        allergies: essentials.allergies,
        problems: essentials.problems,
        medicines: essentials.medicines,
        abnormalResults: [...results].map((row) => ({
          id: row.id,
          label: findAnalyte(row.code)?.analyte.label ?? row.display,
          value: Number(row.value),
          unit: row.unit,
          direction:
            row.interpretation === 'high'
              ? ('higher' as const)
              : row.interpretation === 'low'
                ? ('lower' as const)
                : ('outside' as const),
          collectedAt: toIso(row.effective_at),
          hospitalName: hospitalName(row.hospital_name),
        })),
        lastVisit: lastVisit
          ? {
              date: toIso(lastVisit.started_at),
              kind: lastVisit.class,
              hospitalName: hospitalName(lastVisit.hospital_name),
            }
          : null,
        hospitals: [...hospitals],
      };
    });

    await this.audit.recordForPatient(actor, {
      resourceType: 'portal_summary',
      action: 'read',
      meta,
    });

    return summary;
  }

  /**
   * The essentials of a patient's record, in their context. Not audited here:
   * each caller records the read as what it is — the patient's summary, or an
   * emergency card opened by whoever holds it.
   */
  async essentials(patientId: string): Promise<RecordEssentials> {
    return this.db.asPatient(patientId, (tx) => this.readEssentials(tx, patientId));
  }

  private async readEssentials(tx: DbTransaction, patientId: string): Promise<RecordEssentials> {
    const ids = sql`app.patient_record_ids(${patientId}::uuid)`;

    const [patient] = await tx.execute<{
      name: string;
      date_of_birth: string | null;
      approximate_age_years: number | null;
      blood_group: string | null;
      emergency_contact_name: string | null;
      emergency_contact_phone: string | null;
    }>(sql`
      SELECT "name", to_char("date_of_birth", 'YYYY-MM-DD') AS date_of_birth, "approximate_age_years",
             "blood_group"::text AS blood_group, "emergency_contact_name", "emergency_contact_phone"
        FROM "patient" WHERE "id" = ${patientId}::uuid
    `);

    const allergies = await tx.execute<{
      id: string;
      substance: string;
      criticality: string | null;
      reaction: string | null;
      hospital_name: string | null;
    }>(sql`
      SELECT a."id", a."substance", a."criticality"::text AS criticality, a."reaction",
             h."name" AS hospital_name
        FROM "allergy_intolerance" a
        LEFT JOIN "hospital_directory" h ON h."id" = a."hospital_id"
       WHERE a."patient_id" = ANY (${ids}) AND a."version_status" = 'current'
         AND a."clinical_status" = 'active'
    ORDER BY a."recorded_at" DESC
    `);

    const problems = await tx.execute<{
      id: string;
      display: string | null;
      code: string | null;
      since: string;
      hospital_name: string | null;
    }>(sql`
      SELECT c."id", cc."display", cc."code",
             to_char(app.ist_date(c."recorded_at"), 'YYYY-MM-DD') AS since,
             h."name" AS hospital_name
        FROM "condition" c
        LEFT JOIN "condition_coding" cc ON cc."condition_id" = c."id" AND cc."role" = 'primary'
        LEFT JOIN "hospital_directory" h ON h."id" = c."hospital_id"
       WHERE c."patient_id" = ANY (${ids}) AND c."version_status" = 'current'
         AND c."clinical_status" = 'active'
    ORDER BY c."recorded_at" DESC
       LIMIT ${LIST_LIMIT}
    `);

    const medicines = await tx.execute<{
      id: string;
      name: string;
      how_to_take: string | null;
      start_date: string | null;
      hospital_name: string | null;
    }>(sql`
      SELECT r."id", r."medicine_name" || coalesce(' ' || r."strength", '') AS name,
             nullif(concat_ws(' · ',
               CASE WHEN r."dose_quantity" IS NOT NULL
                    THEN trim_scale(r."dose_quantity")::text || ' ' || r."dose_unit" END,
               r."frequency",
               CASE WHEN r."duration_value" IS NOT NULL
                    THEN 'for ' || r."duration_value" || ' ' || r."duration_unit"::text END), '') AS how_to_take,
             to_char(r."start_date", 'YYYY-MM-DD') AS start_date,
             h."name" AS hospital_name
        FROM "medication_request" r
        LEFT JOIN "hospital_directory" h ON h."id" = r."hospital_id"
       WHERE r."patient_id" = ANY (${ids}) AND r."version_status" = 'current'
         AND r."status" = 'active'
    ORDER BY r."recorded_at" DESC
       LIMIT ${LIST_LIMIT}
    `);

    return {
      name: patient?.name ?? '',
      ageYears: patient?.date_of_birth
        ? ageInYears(patient.date_of_birth, istToday())
        : (patient?.approximate_age_years ?? null),
      // "unknown" is recorded when the patient does not know it: nothing to show.
      bloodGroup:
        patient?.blood_group && patient.blood_group !== 'unknown' ? patient.blood_group : null,
      emergencyContact:
        patient?.emergency_contact_name && patient.emergency_contact_phone
          ? { name: patient.emergency_contact_name, phone: patient.emergency_contact_phone }
          : null,
      allergies: [...allergies].map((row) => ({
        id: row.id,
        substance: row.substance,
        highRisk: row.criticality === 'high',
        reaction: row.reaction,
        hospitalName: hospitalName(row.hospital_name),
      })),
      problems: [...problems].map((row) => ({
        id: row.id,
        name: row.display ?? 'Diagnosis',
        code: row.code,
        since: row.since,
        hospitalName: hospitalName(row.hospital_name),
      })),
      medicines: [...medicines].map((row) => ({
        id: row.id,
        name: row.name,
        howToTake: row.how_to_take,
        startDate: row.start_date,
        hospitalName: hospitalName(row.hospital_name),
      })),
    };
  }
}
