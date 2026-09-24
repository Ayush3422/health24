import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type {
  Admission,
  AdmissionList,
  AdmissionsQuery,
  AdmitInput,
  BedStay,
  DischargeInput,
  TransferInput,
  WardKind,
} from '@health24/shared';
import { requireHospital, type Actor, type RequestMeta } from '../../common/actor';
import type { DbTransaction } from '../../db/client';
import { DatabaseService } from '../../db/database.service';
import { AuditService } from '../audit/audit.service';
import { blankToNull, requireLinkedPatient, toIso } from '../clinical/clinical-access';

type AdmissionRow = {
  encounter_id: string;
  patient_id: string;
  patient_name: string | null;
  mrn: string | null;
  admitted_at: string | Date;
  discharged_at: string | Date | null;
  reason_for_admission: string | null;
  attending_staff_id: string;
  attending_name: string | null;
};

type StayRow = {
  id: string;
  encounter_id: string;
  bed_id: string;
  bed: string;
  ward: string;
  ward_kind: WardKind;
  started_at: string | Date;
  ended_at: string | Date | null;
  moved_reason: string | null;
  blocked_reason: string | null;
  bed_status: 'available' | 'blocked';
  ward_id: string;
};

const ADMISSION_SELECT = sql`
  SELECT e."id" AS encounter_id, e."patient_id", p."name" AS patient_name, l."mrn",
         e."started_at" AS admitted_at, e."ended_at" AS discharged_at,
         e."chief_complaint" AS reason_for_admission,
         e."attending_staff_id", s."name" AS attending_name
    FROM "encounter" e
    LEFT JOIN "patient" p ON p."id" = e."patient_id"
    LEFT JOIN "patient_hospital_link" l
           ON l."patient_id" = e."patient_id" AND l."hospital_id" = app.current_hospital_id()
    LEFT JOIN "staff_user" s ON s."id" = e."attending_staff_id"
`;

const STAY_SELECT = sql`
  SELECT st."id", st."encounter_id", st."bed_id", b."label" AS bed, w."name" AS ward,
         w."kind" AS ward_kind, w."id" AS ward_id, b."status" AS bed_status, b."blocked_reason",
         st."started_at", st."ended_at", st."moved_reason"
    FROM "bed_stay" st
    JOIN "bed" b ON b."id" = st."bed_id"
    JOIN "ward" w ON w."id" = b."ward_id"
`;

/**
 * Admission, transfer and discharge (sp6-plan.md, Decision P1).
 *
 * An admission is an inpatient encounter — SP3's encounter, unchanged — with a
 * bed history beside it. A transfer ends one stay and starts the next in a
 * single transaction, so nobody is ever in two beds or in none; a discharge
 * ends the stay and finishes the encounter together, for the same reason.
 */
@Injectable()
export class AdmissionsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async admit(actor: Actor, input: AdmitInput, meta: RequestMeta): Promise<Admission> {
    const hospitalId = requireHospital(actor);

    const patientId = await this.db.asTenant(hospitalId, async (tx) => {
      const encounter = await this.requireAdmittableEncounter(tx, hospitalId, input.encounterId);
      await requireLinkedPatient(tx, hospitalId, encounter.patient_id);
      await this.requireFreeBed(tx, input.bedId);

      await this.openStay(tx, {
        hospitalId,
        encounterId: input.encounterId,
        patientId: encounter.patient_id,
        bedId: input.bedId,
        staffId: actor.staffUserId,
      });

      return encounter.patient_id;
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'bed_stay',
      resourceId: input.encounterId,
      patientId,
      action: 'create',
      meta,
    });

    return this.one(actor, input.encounterId);
  }

  /** A move: this stay ends, the next begins, and neither happens alone. */
  async transfer(
    actor: Actor,
    encounterId: string,
    input: TransferInput,
    meta: RequestMeta,
  ): Promise<Admission> {
    const hospitalId = requireHospital(actor);

    const patientId = await this.db.asTenant(hospitalId, async (tx) => {
      const current = await this.requireOpenStay(tx, encounterId);

      if (current.bed_id === input.bedId) {
        throw new ConflictException('The patient is already in that bed');
      }

      await this.requireFreeBed(tx, input.bedId);
      await this.closeStay(tx, current.id, actor.staffUserId, input.reason);
      await this.openStay(tx, {
        hospitalId,
        encounterId,
        patientId: current.patient_id,
        bedId: input.bedId,
        staffId: actor.staffUserId,
      });

      return current.patient_id;
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'bed_stay',
      resourceId: encounterId,
      patientId,
      action: 'update',
      meta,
    });

    return this.one(actor, encounterId);
  }

  async discharge(
    actor: Actor,
    encounterId: string,
    input: DischargeInput,
    meta: RequestMeta,
  ): Promise<Admission> {
    const hospitalId = requireHospital(actor);

    const patientId = await this.db.asTenant(hospitalId, async (tx) => {
      const current = await this.requireOpenStay(tx, encounterId);

      await this.closeStay(
        tx,
        current.id,
        actor.staffUserId,
        blankToNull(input.note) ?? 'Discharged',
      );

      await tx.execute(sql`
        UPDATE "encounter" SET "status" = 'finished', "ended_at" = now()
         WHERE "id" = ${encounterId}::uuid AND "status" = 'in_progress'
      `);

      return current.patient_id;
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'bed_stay',
      resourceId: encounterId,
      patientId,
      action: 'update',
      meta,
    });

    return this.one(actor, encounterId);
  }

  async list(actor: Actor, query: AdmissionsQuery, meta: RequestMeta): Promise<AdmissionList> {
    const hospitalId = requireHospital(actor);

    const rows = await this.db.asTenant(hospitalId, async (tx) => {
      const found = await tx.execute<AdmissionRow>(sql`
        ${ADMISSION_SELECT}
         WHERE e."hospital_id" = ${hospitalId}::uuid
           AND e."class" = 'inpatient'
           AND e."status" <> 'cancelled'
           ${
             query.scope === 'current'
               ? sql`AND EXISTS (
                   SELECT 1 FROM "bed_stay" s
                    WHERE s."encounter_id" = e."id" AND s."ended_at" IS NULL
                 )`
               : sql``
           }
           ${
             query.patientId
               ? sql`AND e."patient_id" = ANY (app.patient_record_ids(${query.patientId}::uuid))`
               : sql``
           }
           ${
             query.wardId
               ? sql`AND EXISTS (
                   SELECT 1 FROM "bed_stay" s JOIN "bed" b ON b."id" = s."bed_id"
                    WHERE s."encounter_id" = e."id" AND b."ward_id" = ${query.wardId}::uuid
                      AND s."ended_at" IS NULL
                 )`
               : sql``
           }
      ORDER BY e."started_at" DESC
         LIMIT 200
      `);

      const list = [...found];
      const stays = await this.staysFor(
        tx,
        list.map((row) => row.encounter_id),
      );

      return { list, stays };
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'bed_stay',
      resourceId: null,
      patientId: query.patientId ?? null,
      action: 'search',
      meta,
    });

    return {
      admissions: rows.list.map((row) =>
        this.toAdmission(
          row,
          rows.stays.filter((stay) => stay.encounter_id === row.encounter_id),
        ),
      ),
    };
  }

  async findByEncounter(actor: Actor, encounterId: string, meta: RequestMeta): Promise<Admission> {
    const admission = await this.one(actor, encounterId);

    await this.audit.recordForActor(actor, {
      resourceType: 'bed_stay',
      resourceId: encounterId,
      patientId: admission.patientId,
      action: 'read',
      meta,
    });

    return admission;
  }

  private async one(actor: Actor, encounterId: string): Promise<Admission> {
    const hospitalId = requireHospital(actor);

    const { row, stays } = await this.db.asTenant(hospitalId, async (tx) => {
      const [found] = await tx.execute<AdmissionRow>(sql`
        ${ADMISSION_SELECT} WHERE e."id" = ${encounterId}::uuid
      `);

      if (!found) throw new NotFoundException('Admission not found');

      return { row: found, stays: await this.staysFor(tx, [encounterId]) };
    });

    return this.toAdmission(row, stays);
  }

  private async staysFor(tx: DbTransaction, encounterIds: string[]): Promise<StayRow[]> {
    if (encounterIds.length === 0) return [];

    const rows = await tx.execute<StayRow>(sql`
      ${STAY_SELECT}
       WHERE st."encounter_id" IN (${sql.join(
         encounterIds.map((id) => sql`${id}::uuid`),
         sql`, `,
       )})
    ORDER BY st."started_at" ASC
    `);

    return [...rows];
  }

  private async requireOpenStay(
    tx: DbTransaction,
    encounterId: string,
  ): Promise<{ id: string; bed_id: string; patient_id: string }> {
    const [stay] = await tx.execute<{ id: string; bed_id: string; patient_id: string }>(sql`
      SELECT "id", "bed_id", "patient_id" FROM "bed_stay"
       WHERE "encounter_id" = ${encounterId}::uuid AND "ended_at" IS NULL
         FOR UPDATE
    `);

    if (!stay) {
      throw new NotFoundException('That admission has no patient in a bed');
    }

    return stay;
  }

  /**
   * An encounter a patient may be put to bed under: this hospital's, still
   * open, of a class that has beds, and not already holding one.
   */
  private async requireAdmittableEncounter(
    tx: DbTransaction,
    hospitalId: string,
    encounterId: string,
  ): Promise<{ patient_id: string }> {
    const [encounter] = await tx.execute<{
      patient_id: string;
      hospital_id: string;
      class: string;
      status: string;
      open_stays: number;
    }>(sql`
      SELECT e."patient_id", e."hospital_id", e."class"::text AS class, e."status"::text AS status,
             (SELECT count(*)::int FROM "bed_stay" s
               WHERE s."encounter_id" = e."id" AND s."ended_at" IS NULL) AS open_stays
        FROM "encounter" e WHERE e."id" = ${encounterId}::uuid
    `);

    if (!encounter || encounter.hospital_id !== hospitalId) {
      throw new NotFoundException('Encounter not found');
    }

    if (encounter.class !== 'inpatient' && encounter.class !== 'emergency') {
      throw new BadRequestException(
        'Only an inpatient or emergency encounter puts a patient in a bed; open one first',
      );
    }

    if (encounter.status !== 'in_progress') {
      throw new ConflictException('That encounter has already ended');
    }

    if (encounter.open_stays > 0) {
      throw new ConflictException('That patient is already in a bed; move them instead');
    }

    return { patient_id: encounter.patient_id };
  }

  /** A bed that exists, is in service, is in an open ward, and is empty. */
  private async requireFreeBed(tx: DbTransaction, bedId: string): Promise<void> {
    const [bed] = await tx.execute<{
      status: 'available' | 'blocked';
      ward_status: 'active' | 'closed';
      occupied: boolean;
    }>(sql`
      SELECT b."status", w."status" AS ward_status,
             EXISTS (
               SELECT 1 FROM "bed_stay" s WHERE s."bed_id" = b."id" AND s."ended_at" IS NULL
             ) AS occupied
        FROM "bed" b JOIN "ward" w ON w."id" = b."ward_id"
       WHERE b."id" = ${bedId}::uuid
    `);

    if (!bed) throw new NotFoundException('Bed not found');
    if (bed.status === 'blocked') throw new ConflictException('That bed is out of service');
    if (bed.ward_status === 'closed') throw new ConflictException('That ward is closed');
    if (bed.occupied) throw new ConflictException('Somebody is already in that bed');
  }

  private async openStay(
    tx: DbTransaction,
    stay: {
      hospitalId: string;
      encounterId: string;
      patientId: string;
      bedId: string;
      staffId: string;
    },
  ): Promise<void> {
    await tx.execute(sql`
      INSERT INTO "bed_stay"
        ("hospital_id", "encounter_id", "patient_id", "bed_id", "started_by_staff_id")
      VALUES (${stay.hospitalId}::uuid, ${stay.encounterId}::uuid, ${stay.patientId}::uuid,
              ${stay.bedId}::uuid, ${stay.staffId}::uuid)
    `);
  }

  private async closeStay(
    tx: DbTransaction,
    stayId: string,
    staffId: string,
    reason: string,
  ): Promise<void> {
    await tx.execute(sql`
      UPDATE "bed_stay"
         SET "ended_at" = now(), "ended_by_staff_id" = ${staffId}::uuid, "moved_reason" = ${reason}
       WHERE "id" = ${stayId}::uuid
    `);
  }

  private toAdmission(row: AdmissionRow, stays: StayRow[]): Admission {
    const open = stays.find((stay) => stay.ended_at === null);
    const history = stays.map((stay) => this.toStay(stay));

    return {
      encounterId: row.encounter_id,
      patientId: row.patient_id,
      patientName: row.patient_name ?? 'A patient',
      mrn: row.mrn,
      admittedAt: toIso(row.admitted_at),
      dischargedAt: row.discharged_at ? toIso(row.discharged_at) : null,
      reasonForAdmission: row.reason_for_admission,
      attending: { id: row.attending_staff_id, name: row.attending_name },
      currentBed: open
        ? {
            id: open.bed_id,
            wardId: open.ward_id,
            wardName: open.ward,
            label: open.bed,
            status: open.bed_status,
            blockedReason: open.blocked_reason,
            occupant: {
              patientId: row.patient_id,
              name: row.patient_name ?? 'A patient',
              mrn: row.mrn,
              encounterId: row.encounter_id,
              since: toIso(open.started_at),
            },
          }
        : null,
      stays: history,
      bedDays: history.reduce((total, stay) => total + stay.bedDays, 0),
    };
  }

  private toStay(row: StayRow): BedStay {
    return {
      id: row.id,
      bedId: row.bed_id,
      bed: row.bed,
      ward: row.ward,
      wardKind: row.ward_kind,
      startedAt: toIso(row.started_at),
      endedAt: row.ended_at ? toIso(row.ended_at) : null,
      movedReason: row.moved_reason,
      bedDays: bedDaysOf(row.started_at, row.ended_at),
    };
  }
}

/**
 * What a stay is charged for.
 *
 * Every hospital bills a started day as a day, so this counts calendar days in
 * India Standard Time from the day the patient arrived to the day they left,
 * both included — a stay that is still running counts up to today. Phase 6
 * turns these into charges against the ward's price; nothing here knows what a
 * bed costs.
 */
export function bedDaysOf(startedAt: string | Date, endedAt: string | Date | null): number {
  const istDay = (value: string | Date) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(value));

  const from = Date.parse(`${istDay(startedAt)}T00:00:00+05:30`);
  const to = Date.parse(`${istDay(endedAt ?? new Date())}T00:00:00+05:30`);

  return Math.max(1, Math.round((to - from) / 86_400_000) + 1);
}
