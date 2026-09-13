import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import {
  ALLERGY_CHECK_LIMITATION,
  type AllergyMatch,
  type CorrectPrescriptionInput,
  type CurrentMedications,
  type MedicationSummary,
  type PrescribeInput,
  type PrescriptionResult,
} from '@health24/shared';
import { DatabaseService } from '../../db/database.service';
import type { DbTransaction } from '../../db/client';
import { encounters, medicationRequests } from '../../db/schema';
import { requireHospital, type Actor, type RequestMeta } from '../../common/actor';
import { AuditService } from '../audit/audit.service';
import {
  blankToNull,
  coveringConsentId,
  istToday,
  requireLinkedPatient,
  resolveAttribution,
  toIso,
} from './clinical-access';
import type { Attribution } from './clinical-access';
import { attributionForCorrection, loadForChange, retire } from './corrections.service';

type MedicationRow = {
  id: string;
  patient_id: string;
  encounter_id: string;
  hospital_id: string;
  hospital_name: string | null;
  system_of_medicine: MedicationSummary['systemOfMedicine'];
  medicine_name: string;
  form: string | null;
  strength: string | null;
  dose_quantity: string | null;
  dose_unit: string | null;
  frequency: string;
  route: MedicationSummary['route'];
  duration_value: number | null;
  duration_unit: NonNullable<MedicationSummary['duration']>['unit'] | null;
  start_date: string;
  end_date: string | null;
  vehicle: string | null;
  food_timing: MedicationSummary['foodTiming'];
  instructions: string | null;
  status: MedicationSummary['status'];
  ended_at: string | Date | null;
  end_reason: string | null;
  allergy_override_reason: string | null;
  recorded_at: string | Date;
  recorded_by_staff_id: string;
  recorded_by_name: string | null;
  entry_source: MedicationSummary['entry']['source'];
  supersedes_id: string | null;
  entered_by_staff_id: string;
  entered_by_name: string | null;
};

type AllergyMatchRow = {
  id: string;
  substance: string;
  criticality: AllergyMatch['criticality'];
  reaction: string | null;
  hospital_id: string;
  hospital_name: string | null;
  matched_field: AllergyMatch['matchedField'];
};

const MEDICATION_SELECT = sql`
  SELECT r."id", r."patient_id", r."encounter_id", r."hospital_id", d."name" AS hospital_name,
         r."system_of_medicine", r."medicine_name", r."form", r."strength",
         r."dose_quantity"::text AS dose_quantity, r."dose_unit", r."frequency", r."route",
         r."duration_value", r."duration_unit",
         to_char(r."start_date", 'YYYY-MM-DD') AS start_date,
         to_char(app.medication_end_date(r."start_date", r."duration_value", r."duration_unit"),
                 'YYYY-MM-DD') AS end_date,
         r."vehicle", r."food_timing", r."instructions", r."status", r."ended_at",
         r."end_reason", r."allergy_override_reason", r."recorded_at",
         r."attributed_clinician_id" AS recorded_by_staff_id, s."name" AS recorded_by_name,
         r."entry_source", r."supersedes_id", r."recorded_by_staff_id" AS entered_by_staff_id,
         eb."name" AS entered_by_name
    FROM "medication_request" r
    LEFT JOIN "hospital_directory" d ON d."id" = r."hospital_id"
    LEFT JOIN "staff_user" s ON s."id" = r."attributed_clinician_id"
    LEFT JOIN "staff_user" eb ON eb."id" = r."recorded_by_staff_id"
`;

/** Case and spacing do not make a different substance. */
const normaliseName = (value: string): string => value.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Prescriptions, and the one safety check the plan commits to at the point of
 * prescribing.
 *
 * The check compares the medicine and its vehicle against the patient's
 * recorded allergies by exact name. It is deliberately modest: no drug
 * classes, no interactions (features.md excludes clinical decision support).
 * What it does, it does on every record the prescriber may see — so a
 * penicillin allergy recorded at an Ayurvedic hospital stops a penicillin
 * prescription at an allopathic one, provided allergies are shared.
 */
@Injectable()
export class PrescriptionsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async prescribe(
    actor: Actor,
    input: PrescribeInput,
    meta: RequestMeta,
  ): Promise<PrescriptionResult> {
    const hospitalId = requireHospital(actor);

    const { attribution, encounter, matches, allergyConsentId } = await this.db.asTenant(
      hospitalId,
      async (tx) => {
        const [found] = await tx
          .select({
            hospitalId: encounters.hospitalId,
            patientId: encounters.patientId,
            status: encounters.status,
            systemOfMedicine: encounters.systemOfMedicine,
          })
          .from(encounters)
          .where(eq(encounters.id, input.encounterId))
          .limit(1);

        if (!found) throw new NotFoundException('Encounter not found');

        if (found.hospitalId !== hospitalId) {
          throw new ForbiddenException(
            'A prescription is written against one of your own hospital’s encounters',
          );
        }

        if (found.status === 'cancelled') {
          throw new ConflictException('This encounter was cancelled; open a new one');
        }

        const resolved = await resolveAttribution(
          tx,
          actor,
          hospitalId,
          input.onBehalfOfClinicianId,
        );

        return {
          attribution: resolved,
          encounter: found,
          matches: await this.allergyMatches(
            tx,
            found.patientId,
            input.medicineName,
            input.vehicle,
          ),
          allergyConsentId: await coveringConsentId(tx, found.patientId, 'allergies'),
        };
      },
    );

    const matchSummaries = await this.enforceAllergyCheck(actor, meta, {
      hospitalId,
      patientId: encounter.patientId,
      matches,
      allergyConsentId,
      overridden: Boolean(input.allergyOverride),
    });

    const row = await this.db.asTenant(hospitalId, async (tx) => {
      const created = await this.insertPrescription(tx, {
        input,
        patientId: encounter.patientId,
        hospitalId,
        encounterId: input.encounterId,
        systemOfMedicine: input.systemOfMedicine ?? encounter.systemOfMedicine,
        matched: matches.length > 0,
        actor,
        attribution,
        supersedesId: null,
      });

      if (!created) throw new Error('Failed to record the prescription');

      const [inserted] = await this.query(tx, sql`WHERE r."id" = ${created.id}::uuid`);

      if (!inserted) throw new Error('Recorded prescription is not readable');

      return inserted;
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'medication_request',
      resourceId: row.id,
      patientId: encounter.patientId,
      action: 'create',
      meta,
    });

    return {
      ...this.toSummary(row, hospitalId),
      allergyCheck: {
        matches: matchSummaries,
        sharedFromOtherHospitals: allergyConsentId !== null,
        limitation: ALLERGY_CHECK_LIMITATION,
      },
    };
  }

  async stop(
    actor: Actor,
    prescriptionId: string,
    reason: string,
    meta: RequestMeta,
  ): Promise<MedicationSummary> {
    const hospitalId = requireHospital(actor);

    const row = await this.db.asTenant(hospitalId, async (tx) => {
      const [current] = await tx
        .select({
          hospitalId: medicationRequests.hospitalId,
          status: medicationRequests.status,
        })
        .from(medicationRequests)
        .where(eq(medicationRequests.id, prescriptionId))
        .limit(1);

      if (!current) throw new NotFoundException('Prescription not found');

      if (current.hospitalId !== hospitalId) {
        throw new ForbiddenException('Only the prescribing hospital can stop this medicine');
      }

      if (current.status !== 'active') {
        throw new ConflictException(`This prescription is already ${current.status}`);
      }

      const updated = await tx
        .update(medicationRequests)
        .set({
          status: 'stopped',
          endedAt: sql`now()`,
          endedByStaffId: actor.staffUserId,
          endReason: reason,
        })
        .where(
          and(eq(medicationRequests.id, prescriptionId), eq(medicationRequests.status, 'active')),
        )
        .returning({ id: medicationRequests.id });

      if (updated.length === 0) {
        throw new ConflictException('This prescription was stopped by someone else a moment ago');
      }

      const [reloaded] = await this.query(tx, sql`WHERE r."id" = ${prescriptionId}::uuid`);
      if (!reloaded) throw new Error('Stopped prescription is not readable');

      return reloaded;
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'medication_request',
      resourceId: prescriptionId,
      patientId: row.patient_id,
      action: 'update',
      meta,
    });

    return this.toSummary(row, hospitalId);
  }

  /** Every current prescription on one encounter the caller may see, stopped ones included. */
  async forEncounter(
    actor: Actor,
    encounterId: string,
    meta: RequestMeta,
  ): Promise<MedicationSummary[]> {
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
          sql`WHERE r."encounter_id" = ${encounterId}::uuid AND r."version_status" = 'current'
           ORDER BY r."recorded_at" ASC`,
        );

        return {
          rows: found,
          patientId: encounter.patientId,
          consentArtefactId:
            encounter.hospitalId !== hospitalId && found.length > 0
              ? await coveringConsentId(tx, encounter.patientId, 'medications')
              : null,
        };
      },
    );

    await this.audit.recordForActor(actor, {
      resourceType: 'medication_request',
      resourceId: encounterId,
      patientId,
      action: 'read',
      consentArtefactId,
      meta,
    });

    return rows.map((row) => this.toSummary(row, hospitalId));
  }

  /**
   * What the patient is currently taking, from every record the caller may
   * see: active, not superseded, and within its course. Ordered by system of
   * medicine so traditional and biomedical treatment read as separate groups —
   * in the enum's declared order, which puts the traditional systems first and
   * allopathy last, not alphabetically.
   */
  async current(actor: Actor, patientId: string, meta: RequestMeta): Promise<CurrentMedications> {
    const hospitalId = requireHospital(actor);

    const { rows, consentArtefactId } = await this.db.asTenant(hospitalId, async (tx) => {
      await requireLinkedPatient(tx, hospitalId, patientId);

      const found = await this.query(
        tx,
        sql`WHERE r."patient_id" = ANY (app.patient_record_ids(${patientId}::uuid))
             AND r."version_status" = 'current'
             AND r."status" = 'active'
             AND (
               r."duration_value" IS NULL
               OR app.medication_end_date(r."start_date", r."duration_value", r."duration_unit")
                    >= ${istToday()}::date
             )
        ORDER BY r."system_of_medicine", r."start_date" DESC, r."recorded_at" DESC`,
      );

      return {
        rows: found,
        consentArtefactId: await coveringConsentId(tx, patientId, 'medications'),
      };
    });

    const sharedRows = rows.some((row) => row.hospital_id !== hospitalId);

    await this.audit.recordForActor(actor, {
      resourceType: 'medication_request',
      patientId,
      action: 'read',
      consentArtefactId: sharedRows ? consentArtefactId : null,
      meta,
    });

    return {
      medications: rows.map((row) => this.toSummary(row, hospitalId)),
      sharedFromOtherHospitals: consentArtefactId !== null,
    };
  }

  /**
   * Corrects an active prescription: a wrong dose, a misspelt name. The
   * corrected version is checked against allergies exactly as a new
   * prescription is. A stopped prescription is not corrected — it is marked
   * entered in error if it should never have been written.
   */
  async correct(
    actor: Actor,
    prescriptionId: string,
    input: CorrectPrescriptionInput,
    meta: RequestMeta,
  ): Promise<PrescriptionResult> {
    const hospitalId = requireHospital(actor);

    const { original, matches, allergyConsentId } = await this.db.asTenant(
      hospitalId,
      async (tx) => {
        const found = await loadForChange(tx, 'prescriptions', prescriptionId, actor, hospitalId);

        const [current] = await tx
          .select({
            status: medicationRequests.status,
            systemOfMedicine: medicationRequests.systemOfMedicine,
          })
          .from(medicationRequests)
          .where(eq(medicationRequests.id, prescriptionId))
          .limit(1);

        if (current?.status !== 'active') {
          throw new ConflictException(
            'Only an active prescription can be corrected; mark a stopped one entered in error instead',
          );
        }

        return {
          original: { ...found, systemOfMedicine: current.systemOfMedicine },
          matches: await this.allergyMatches(
            tx,
            found.patient_id,
            input.medicineName,
            input.vehicle,
          ),
          allergyConsentId: await coveringConsentId(tx, found.patient_id, 'allergies'),
        };
      },
    );

    const matchSummaries = await this.enforceAllergyCheck(actor, meta, {
      hospitalId,
      patientId: original.patient_id,
      matches,
      allergyConsentId,
      overridden: Boolean(input.allergyOverride),
    });

    const row = await this.db.asTenant(hospitalId, async (tx) => {
      const current = await loadForChange(tx, 'prescriptions', prescriptionId, actor, hospitalId);
      const attribution = await attributionForCorrection(tx, actor, hospitalId, current);

      await retire(tx, 'prescriptions', prescriptionId, actor, input.reason, 'superseded');

      const created = await this.insertPrescription(tx, {
        input,
        patientId: current.patient_id,
        hospitalId,
        encounterId: current.encounter_id as string,
        systemOfMedicine: input.systemOfMedicine ?? original.systemOfMedicine,
        matched: matches.length > 0,
        actor,
        attribution,
        supersedesId: prescriptionId,
      });

      if (!created) throw new Error('Failed to record the corrected prescription');

      const [inserted] = await this.query(tx, sql`WHERE r."id" = ${created.id}::uuid`);
      if (!inserted) throw new Error('Corrected prescription is not readable');

      return inserted;
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'medication_request',
      resourceId: prescriptionId,
      patientId: original.patient_id,
      action: 'update',
      meta,
    });

    return {
      ...this.toSummary(row, hospitalId),
      allergyCheck: {
        matches: matchSummaries,
        sharedFromOtherHospitals: allergyConsentId !== null,
        limitation: ALLERGY_CHECK_LIMITATION,
      },
    };
  }

  /**
   * Applies the allergy check's outcome: audits the disclosure of another
   * hospital's allergy, and refuses the prescription when something matched
   * and no override reason was given.
   */
  private async enforceAllergyCheck(
    actor: Actor,
    meta: RequestMeta,
    args: {
      hospitalId: string;
      patientId: string;
      matches: AllergyMatchRow[];
      allergyConsentId: string | null;
      overridden: boolean;
    },
  ): Promise<AllergyMatch[]> {
    const matchSummaries = args.matches.map((row) => this.toMatch(row, args.hospitalId));

    // The check disclosed another hospital's allergy to this prescriber: that
    // is a read of the shared record, whatever happens next.
    if (args.matches.some((row) => row.hospital_id !== args.hospitalId)) {
      await this.audit.recordForActor(actor, {
        resourceType: 'allergy_intolerance',
        patientId: args.patientId,
        action: 'read',
        consentArtefactId: args.allergyConsentId,
        meta,
      });
    }

    if (args.matches.length > 0 && !args.overridden) {
      throw new ConflictException({
        message: 'This patient has a recorded allergy matching this prescription',
        code: 'ALLERGY_MATCH',
        matches: matchSummaries,
        limitation: ALLERGY_CHECK_LIMITATION,
      });
    }

    return matchSummaries;
  }

  /** Writes a prescription in the caller's transaction. */
  private async insertPrescription(
    tx: DbTransaction,
    args: {
      input: Omit<PrescribeInput, 'encounterId' | 'onBehalfOfClinicianId'>;
      patientId: string;
      hospitalId: string;
      encounterId: string;
      systemOfMedicine: MedicationSummary['systemOfMedicine'];
      matched: boolean;
      actor: Actor;
      attribution: Attribution;
      supersedesId: string | null;
    },
  ): Promise<{ id: string } | undefined> {
    const { input } = args;

    const [created] = await tx
      .insert(medicationRequests)
      .values({
        patientId: args.patientId,
        hospitalId: args.hospitalId,
        encounterId: args.encounterId,
        systemOfMedicine: args.systemOfMedicine,
        medicineName: input.medicineName.trim(),
        form: blankToNull(input.form),
        strength: blankToNull(input.strength),
        doseQuantity: input.dose ? String(input.dose.quantity) : null,
        doseUnit: input.dose ? input.dose.unit.trim() : null,
        frequency: input.frequency.trim(),
        route: input.route,
        durationValue: input.duration?.value ?? null,
        durationUnit: input.duration?.unit ?? null,
        startDate: input.startDate ?? istToday(),
        vehicle: blankToNull(input.vehicle),
        foodTiming: input.foodTiming ?? null,
        instructions: blankToNull(input.instructions),
        // An override is meaningful only when something matched.
        allergyOverrideReason: args.matched ? (input.allergyOverride?.reason ?? null) : null,
        recordedByStaffId: args.actor.staffUserId,
        attributedClinicianId: args.attribution.clinicianId,
        entrySource: args.attribution.entrySource,
        supersedesId: args.supersedesId,
      })
      .returning({ id: medicationRequests.id });

    return created;
  }

  /** Active allergies the caller may see whose substance names this medicine or its vehicle. */
  private async allergyMatches(
    tx: DbTransaction,
    patientId: string,
    medicineName: string,
    vehicle: string | undefined,
  ): Promise<AllergyMatchRow[]> {
    const medicine = normaliseName(medicineName);
    // An empty string never matches: a recorded substance cannot be blank.
    const medium = vehicle ? normaliseName(vehicle) : '';

    const rows = await tx.execute<AllergyMatchRow>(sql`
      SELECT a."id", a."substance", a."criticality", a."reaction", a."hospital_id",
             d."name" AS hospital_name,
             CASE WHEN lower(regexp_replace(btrim(a."substance"), '\\s+', ' ', 'g')) = ${medicine}
                  THEN 'medicine' ELSE 'vehicle' END AS matched_field
        FROM "allergy_intolerance" a
        LEFT JOIN "hospital_directory" d ON d."id" = a."hospital_id"
       WHERE a."patient_id" = ANY (app.patient_record_ids(${patientId}::uuid))
         AND a."version_status" = 'current'
         AND a."clinical_status" = 'active'
         AND lower(regexp_replace(btrim(a."substance"), '\\s+', ' ', 'g')) IN (${medicine}, ${medium})
    ORDER BY CASE a."criticality" WHEN 'high' THEN 0 WHEN 'unable_to_assess' THEN 1 ELSE 2 END
    `);

    return [...rows];
  }

  private async query(tx: DbTransaction, tail: ReturnType<typeof sql>): Promise<MedicationRow[]> {
    const rows = await tx.execute<MedicationRow>(sql`${MEDICATION_SELECT} ${tail}`);
    return [...rows];
  }

  private toMatch(row: AllergyMatchRow, hospitalId: string): AllergyMatch {
    return {
      allergyId: row.id,
      substance: row.substance,
      criticality: row.criticality,
      reaction: row.reaction,
      matchedField: row.matched_field,
      hospital: {
        id: row.hospital_id,
        name: row.hospital_name ?? 'Unknown hospital',
        isOwn: row.hospital_id === hospitalId,
      },
    };
  }

  private toSummary(row: MedicationRow, hospitalId: string): MedicationSummary {
    return {
      id: row.id,
      patientId: row.patient_id,
      encounterId: row.encounter_id,
      hospital: {
        id: row.hospital_id,
        name: row.hospital_name ?? 'Unknown hospital',
        isOwn: row.hospital_id === hospitalId,
      },
      systemOfMedicine: row.system_of_medicine,
      medicineName: row.medicine_name,
      form: row.form,
      strength: row.strength,
      dose:
        row.dose_quantity !== null && row.dose_unit !== null
          ? { quantity: Number(row.dose_quantity), unit: row.dose_unit }
          : null,
      frequency: row.frequency,
      route: row.route,
      duration:
        row.duration_value !== null && row.duration_unit !== null
          ? { value: Number(row.duration_value), unit: row.duration_unit }
          : null,
      startDate: row.start_date,
      endDate: row.end_date,
      vehicle: row.vehicle,
      foodTiming: row.food_timing,
      instructions: row.instructions,
      status: row.status,
      supersedesId: row.supersedes_id,
      endedAt: row.ended_at ? toIso(row.ended_at) : null,
      endReason: row.end_reason,
      allergyOverrideReason: row.allergy_override_reason,
      prescribedAt: toIso(row.recorded_at),
      prescriber: { id: row.recorded_by_staff_id, name: row.recorded_by_name },
      entry: {
        source: row.entry_source,
        enteredBy: { id: row.entered_by_staff_id, name: row.entered_by_name },
      },
    };
  }
}
