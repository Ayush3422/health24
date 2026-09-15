import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import {
  LOINC_SYSTEM,
  VITAL_SIGNS,
  VITAL_SIGN_KEYS,
  type RecordVitalsInput,
  type VitalSet,
  type VitalSignKey,
  type VitalsList,
} from '@health24/shared';
import { DatabaseService } from '../../db/database.service';
import type { DbTransaction } from '../../db/client';
import { encounters, observations } from '../../db/schema';
import { requireHospital, type Actor, type RequestMeta } from '../../common/actor';
import { AuditService } from '../audit/audit.service';
import {
  coveringConsentId,
  requireLinkedPatient,
  requireWritableEncounter,
  resolveAttribution,
  toIso,
} from './clinical-access';
import { loadForChange, retire } from './corrections.service';

type ObservationRow = {
  id: string;
  group_id: string | null;
  patient_id: string;
  encounter_id: string | null;
  hospital_id: string;
  hospital_name: string | null;
  code: string;
  display: string;
  value: string | null;
  unit: string | null;
  effective_at: string | Date;
  recorded_at: string | Date;
  attributed_clinician_id: string;
  clinician_name: string | null;
  entry_source: 'direct' | 'transcribed';
  recorded_by_staff_id: string;
  entered_by_name: string | null;
};

const KEY_BY_CODE = new Map<string, VitalSignKey>(
  VITAL_SIGN_KEYS.map((key) => [VITAL_SIGNS[key].code, key]),
);

const OBSERVATION_SELECT = sql`
  SELECT o."id", o."group_id", o."patient_id", o."encounter_id", o."hospital_id",
         d."name" AS hospital_name, o."code", o."display", o."value_quantity"::text AS value,
         o."unit", o."effective_at", o."recorded_at", o."attributed_clinician_id",
         cl."name" AS clinician_name, o."entry_source", o."recorded_by_staff_id",
         eb."name" AS entered_by_name
    FROM "observation" o
    LEFT JOIN "hospital_directory" d ON d."id" = o."hospital_id"
    LEFT JOIN "staff_user" cl ON cl."id" = o."attributed_clinician_id"
    LEFT JOIN "staff_user" eb ON eb."id" = o."recorded_by_staff_id"
`;

/** Body mass index from centimetres and kilograms, to one decimal place. */
export function bodyMassIndex(heightCm: number, weightKg: number): number {
  const metres = heightCm / 100;
  return Math.round((weightKg / (metres * metres)) * 10) / 10;
}

/**
 * Vital signs, stored as LOINC-coded observations.
 *
 * Readings taken together share a group id and are shown, and marked entered
 * in error, as one set. A blood pressure is two observations in the set, not a
 * string like "120/80" that nothing can chart. BMI is derived here from height
 * and weight rather than typed, so it cannot disagree with them.
 */
@Injectable()
export class VitalsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async record(actor: Actor, input: RecordVitalsInput, meta: RequestMeta): Promise<VitalSet> {
    const hospitalId = requireHospital(actor);
    const groupId = uuidv7();

    const rows = await this.db.asTenant(hospitalId, async (tx) => {
      if (input.encounterId) {
        const encounter = await requireWritableEncounter(
          tx,
          hospitalId,
          input.encounterId,
          'Vitals are',
        );

        if (encounter.patientId !== input.patientId) {
          throw new BadRequestException('That encounter belongs to a different patient');
        }
      } else {
        await requireLinkedPatient(tx, hospitalId, input.patientId);
      }

      const attribution = await resolveAttribution(
        tx,
        actor,
        hospitalId,
        input.onBehalfOfClinicianId,
      );

      const readings = VITAL_SIGN_KEYS.flatMap((key): Array<[VitalSignKey, number]> => {
        if (key === 'bmi') return [];
        const value = input.readings[key];
        return value === undefined ? [] : [[key, value]];
      });

      const { height, weight } = input.readings;
      if (height !== undefined && weight !== undefined) {
        readings.push(['bmi', bodyMassIndex(height, weight)]);
      }

      const effectiveAt = input.effectiveAt ? new Date(input.effectiveAt) : new Date();

      await tx.insert(observations).values(
        readings.map(([key, value]) => ({
          patientId: input.patientId,
          hospitalId,
          encounterId: input.encounterId ?? null,
          codeSystem: LOINC_SYSTEM,
          code: VITAL_SIGNS[key].code,
          display: VITAL_SIGNS[key].display,
          valueQuantity: String(value),
          unit: VITAL_SIGNS[key].unit,
          groupId,
          effectiveAt,
          recordedByStaffId: actor.staffUserId,
          attributedClinicianId: attribution.clinicianId,
          entrySource: attribution.entrySource,
        })),
      );

      return this.query(tx, sql`WHERE o."group_id" = ${groupId}::uuid`);
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'observation',
      resourceId: groupId,
      patientId: input.patientId,
      action: 'create',
      meta,
    });

    const [set] = this.toSets(rows, hospitalId);
    if (!set) throw new Error('Recorded vitals are not readable');

    return set;
  }

  async forPatient(actor: Actor, patientId: string, meta: RequestMeta): Promise<VitalsList> {
    const hospitalId = requireHospital(actor);

    const { rows, consentArtefactId } = await this.db.asTenant(hospitalId, async (tx) => {
      await requireLinkedPatient(tx, hospitalId, patientId);

      const found = await this.query(
        tx,
        sql`WHERE o."patient_id" = ANY (app.patient_record_ids(${patientId}::uuid))
             AND o."code_system" = ${LOINC_SYSTEM} AND o."category" = 'vital_signs'
             AND o."version_status" = 'current'
        ORDER BY o."effective_at" DESC, o."group_id"
           LIMIT 500`,
      );

      return {
        rows: found,
        consentArtefactId: await coveringConsentId(tx, patientId, 'observations'),
      };
    });

    const sharedRows = rows.some((row) => row.hospital_id !== hospitalId);

    await this.audit.recordForActor(actor, {
      resourceType: 'observation',
      patientId,
      action: 'read',
      consentArtefactId: sharedRows ? consentArtefactId : null,
      meta,
    });

    return {
      sets: this.toSets(rows, hospitalId),
      sharedFromOtherHospitals: consentArtefactId !== null,
    };
  }

  async forEncounter(actor: Actor, encounterId: string, meta: RequestMeta): Promise<VitalSet[]> {
    const hospitalId = requireHospital(actor);

    const { rows, patientId, consentArtefactId } = await this.db.asTenant(
      hospitalId,
      async (tx) => {
        const [encounter] = await tx
          .select({ patientId: encounters.patientId, hospitalId: encounters.hospitalId })
          .from(encounters)
          .where(eq(encounters.id, encounterId))
          .limit(1);

        if (!encounter) throw new NotFoundException('Encounter not found');

        const found = await this.query(
          tx,
          sql`WHERE o."encounter_id" = ${encounterId}::uuid
               AND o."code_system" = ${LOINC_SYSTEM} AND o."category" = 'vital_signs'
               AND o."version_status" = 'current'
          ORDER BY o."effective_at" DESC, o."group_id"`,
        );

        return {
          rows: found,
          patientId: encounter.patientId,
          consentArtefactId:
            encounter.hospitalId !== hospitalId && found.length > 0
              ? await coveringConsentId(tx, encounter.patientId, 'observations')
              : null,
        };
      },
    );

    await this.audit.recordForActor(actor, {
      resourceType: 'observation',
      resourceId: encounterId,
      patientId,
      action: 'read',
      consentArtefactId,
      meta,
    });

    return this.toSets(rows, hospitalId);
  }

  /** Marks a whole set entered in error: readings taken together were mistaken together. */
  async markEnteredInError(
    actor: Actor,
    groupId: string,
    reason: string,
    meta: RequestMeta,
  ): Promise<{ id: string; versionStatus: 'entered_in_error' }> {
    const hospitalId = requireHospital(actor);

    const patientId = await this.db.asTenant(hospitalId, async (tx) => {
      const members = await tx
        .select({ id: observations.id, versionStatus: observations.versionStatus })
        .from(observations)
        .where(and(eq(observations.groupId, groupId), eq(observations.category, 'vital_signs')));

      if (members.length === 0) throw new NotFoundException('Vitals not found');

      const current = members.filter((member) => member.versionStatus === 'current');

      if (current.length === 0) {
        throw new ConflictException('These vitals have already been marked entered in error');
      }

      let patient = '';

      for (const member of current) {
        const row = await loadForChange(tx, 'vitals', member.id, actor, hospitalId);
        await retire(tx, 'vitals', member.id, actor, reason, 'entered_in_error');
        patient = row.patient_id;
      }

      return patient;
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'observation',
      resourceId: groupId,
      patientId,
      action: 'update',
      meta,
    });

    return { id: groupId, versionStatus: 'entered_in_error' };
  }

  private async query(tx: DbTransaction, tail: ReturnType<typeof sql>): Promise<ObservationRow[]> {
    const rows = await tx.execute<ObservationRow>(sql`${OBSERVATION_SELECT} ${tail}`);
    return [...rows];
  }

  /** Groups rows into sets, keeping the order they arrived in. */
  private toSets(rows: ObservationRow[], hospitalId: string): VitalSet[] {
    const sets = new Map<string, VitalSet>();

    for (const row of rows) {
      const key = KEY_BY_CODE.get(row.code);
      if (!key || row.value === null) continue;

      const groupId = row.group_id ?? row.id;
      let set = sets.get(groupId);

      if (!set) {
        set = {
          id: groupId,
          patientId: row.patient_id,
          encounterId: row.encounter_id,
          hospital: {
            id: row.hospital_id,
            name: row.hospital_name ?? 'Unknown hospital',
            isOwn: row.hospital_id === hospitalId,
          },
          effectiveAt: toIso(row.effective_at),
          recordedAt: toIso(row.recorded_at),
          recordedBy: { id: row.attributed_clinician_id, name: row.clinician_name },
          entry: {
            source: row.entry_source,
            enteredBy: { id: row.recorded_by_staff_id, name: row.entered_by_name },
          },
          readings: [],
        };
        sets.set(groupId, set);
      }

      set.readings.push({
        key,
        observationId: row.id,
        code: row.code,
        display: row.display,
        value: Number(row.value),
        unit: row.unit ?? VITAL_SIGNS[key].unit,
      });
    }

    for (const set of sets.values()) {
      set.readings.sort((a, b) => VITAL_SIGN_KEYS.indexOf(a.key) - VITAL_SIGN_KEYS.indexOf(b.key));
    }

    return [...sets.values()];
  }
}
