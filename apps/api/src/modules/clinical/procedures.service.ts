import { Injectable, NotFoundException } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import type {
  CorrectProcedureInput,
  ProcedureList,
  ProcedureSummary,
  RecordProcedureInput,
  SystemOfMedicine,
} from '@health24/shared';
import { DatabaseService } from '../../db/database.service';
import type { DbTransaction } from '../../db/client';
import { encounters, procedures } from '../../db/schema';
import { requireHospital, type Actor, type RequestMeta } from '../../common/actor';
import { AuditService } from '../audit/audit.service';
import {
  blankToNull,
  coveringConsentId,
  requireClinicianOfHospital,
  requireLinkedPatient,
  requireWritableEncounter,
  resolveAttribution,
  toIso,
  type Attribution,
} from './clinical-access';
import { attributionForCorrection, loadForChange, retire } from './corrections.service';

type ProcedureRow = {
  id: string;
  patient_id: string;
  encounter_id: string;
  hospital_id: string;
  hospital_name: string | null;
  system_of_medicine: SystemOfMedicine;
  name: string;
  performed_at: string | Date;
  performer_staff_id: string;
  performer_name: string | null;
  outcome: string | null;
  notes: string | null;
  pre_op_assessment: string | null;
  anaesthesia: string | null;
  operative_note: string | null;
  post_op_course: string | null;
  recorded_at: string | Date;
  attributed_clinician_id: string;
  clinician_name: string | null;
  entry_source: 'direct' | 'transcribed';
  recorded_by_staff_id: string;
  entered_by_name: string | null;
  supersedes_id: string | null;
};

const PROCEDURE_SELECT = sql`
  SELECT p."id", p."patient_id", p."encounter_id", p."hospital_id", d."name" AS hospital_name,
         p."system_of_medicine", p."name", p."performed_at", p."performer_staff_id",
         pf."name" AS performer_name, p."outcome", p."notes",
         p."pre_op_assessment", p."anaesthesia", p."operative_note", p."post_op_course",
         p."recorded_at",
         p."attributed_clinician_id", cl."name" AS clinician_name, p."entry_source",
         p."recorded_by_staff_id", eb."name" AS entered_by_name, p."supersedes_id"
    FROM "procedure" p
    LEFT JOIN "hospital_directory" d ON d."id" = p."hospital_id"
    LEFT JOIN "staff_user" pf ON pf."id" = p."performer_staff_id"
    LEFT JOIN "staff_user" cl ON cl."id" = p."attributed_clinician_id"
    LEFT JOIN "staff_user" eb ON eb."id" = p."recorded_by_staff_id"
`;

/**
 * Procedures and therapies. A surgical procedure and a Shirodhara session use
 * the same record: what was done, under which system of medicine, when, by
 * whom, and with what outcome.
 */
@Injectable()
export class ProceduresService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async record(
    actor: Actor,
    input: RecordProcedureInput,
    meta: RequestMeta,
  ): Promise<ProcedureSummary> {
    const hospitalId = requireHospital(actor);

    const row = await this.db.asTenant(hospitalId, async (tx) => {
      const encounter = await requireWritableEncounter(
        tx,
        hospitalId,
        input.encounterId,
        'A procedure is',
      );
      const attribution = await resolveAttribution(
        tx,
        actor,
        hospitalId,
        input.onBehalfOfClinicianId,
      );

      return this.insert(tx, {
        input,
        patientId: encounter.patientId,
        hospitalId,
        encounterId: input.encounterId,
        defaultSystem: encounter.systemOfMedicine,
        actor,
        attribution,
        supersedesId: null,
      });
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'procedure',
      resourceId: row.id,
      patientId: row.patient_id,
      action: 'create',
      meta,
    });

    return this.toSummary(row, hospitalId);
  }

  async correct(
    actor: Actor,
    procedureId: string,
    input: CorrectProcedureInput,
    meta: RequestMeta,
  ): Promise<ProcedureSummary> {
    const hospitalId = requireHospital(actor);

    const row = await this.db.asTenant(hospitalId, async (tx) => {
      const original = await loadForChange(tx, 'procedures', procedureId, actor, hospitalId);

      const [previous] = await tx
        .select({ systemOfMedicine: procedures.systemOfMedicine })
        .from(procedures)
        .where(eq(procedures.id, procedureId))
        .limit(1);

      const attribution = await attributionForCorrection(tx, actor, hospitalId, original);

      await retire(tx, 'procedures', procedureId, actor, input.reason, 'superseded');

      return this.insert(tx, {
        input,
        patientId: original.patient_id,
        hospitalId,
        encounterId: original.encounter_id as string,
        defaultSystem: previous?.systemOfMedicine ?? 'allopathy',
        actor,
        attribution,
        supersedesId: procedureId,
      });
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'procedure',
      resourceId: procedureId,
      patientId: row.patient_id,
      action: 'update',
      meta,
    });

    return this.toSummary(row, hospitalId);
  }

  async forEncounter(
    actor: Actor,
    encounterId: string,
    meta: RequestMeta,
  ): Promise<ProcedureSummary[]> {
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
          sql`WHERE p."encounter_id" = ${encounterId}::uuid AND p."version_status" = 'current'
           ORDER BY p."performed_at" ASC`,
        );

        return {
          rows: found,
          patientId: encounter.patientId,
          consentArtefactId:
            encounter.hospitalId !== hospitalId && found.length > 0
              ? await coveringConsentId(tx, encounter.patientId, 'procedures')
              : null,
        };
      },
    );

    await this.audit.recordForActor(actor, {
      resourceType: 'procedure',
      resourceId: encounterId,
      patientId,
      action: 'read',
      consentArtefactId,
      meta,
    });

    return rows.map((row) => this.toSummary(row, hospitalId));
  }

  async forPatient(actor: Actor, patientId: string, meta: RequestMeta): Promise<ProcedureList> {
    const hospitalId = requireHospital(actor);

    const { rows, consentArtefactId } = await this.db.asTenant(hospitalId, async (tx) => {
      await requireLinkedPatient(tx, hospitalId, patientId);

      const found = await this.query(
        tx,
        sql`WHERE p."patient_id" = ANY (app.patient_record_ids(${patientId}::uuid))
             AND p."version_status" = 'current'
        ORDER BY p."performed_at" DESC`,
      );

      return {
        rows: found,
        consentArtefactId: await coveringConsentId(tx, patientId, 'procedures'),
      };
    });

    const sharedRows = rows.some((row) => row.hospital_id !== hospitalId);

    await this.audit.recordForActor(actor, {
      resourceType: 'procedure',
      patientId,
      action: 'read',
      consentArtefactId: sharedRows ? consentArtefactId : null,
      meta,
    });

    return {
      procedures: rows.map((row) => this.toSummary(row, hospitalId)),
      sharedFromOtherHospitals: consentArtefactId !== null,
    };
  }

  private async insert(
    tx: DbTransaction,
    args: {
      input: Omit<RecordProcedureInput, 'encounterId' | 'onBehalfOfClinicianId'>;
      patientId: string;
      hospitalId: string;
      encounterId: string;
      defaultSystem: SystemOfMedicine;
      actor: Actor;
      attribution: Attribution;
      supersedesId: string | null;
    },
  ): Promise<ProcedureRow> {
    const { input } = args;

    if (input.performerClinicianId) {
      await requireClinicianOfHospital(
        tx,
        args.hospitalId,
        input.performerClinicianId,
        'performerClinicianId',
      );
    }

    const [created] = await tx
      .insert(procedures)
      .values({
        patientId: args.patientId,
        hospitalId: args.hospitalId,
        encounterId: args.encounterId,
        systemOfMedicine: input.systemOfMedicine ?? args.defaultSystem,
        name: input.name.trim(),
        performedAt: input.performedAt ? new Date(input.performedAt) : new Date(),
        // The clinician the entry belongs to performed it, unless someone else is named.
        performerStaffId: input.performerClinicianId ?? args.attribution.clinicianId,
        outcome: blankToNull(input.outcome),
        notes: blankToNull(input.notes),
        preOpAssessment: blankToNull(input.preOpAssessment),
        anaesthesia: blankToNull(input.anaesthesia),
        operativeNote: blankToNull(input.operativeNote),
        postOpCourse: blankToNull(input.postOpCourse),
        recordedByStaffId: args.actor.staffUserId,
        attributedClinicianId: args.attribution.clinicianId,
        entrySource: args.attribution.entrySource,
        supersedesId: args.supersedesId,
      })
      .returning({ id: procedures.id });

    if (!created) throw new Error('Failed to record the procedure');

    const [row] = await this.query(tx, sql`WHERE p."id" = ${created.id}::uuid`);
    if (!row) throw new Error('Recorded procedure is not readable');

    return row;
  }

  private async query(tx: DbTransaction, tail: ReturnType<typeof sql>): Promise<ProcedureRow[]> {
    const rows = await tx.execute<ProcedureRow>(sql`${PROCEDURE_SELECT} ${tail}`);
    return [...rows];
  }

  private toSummary(row: ProcedureRow, hospitalId: string): ProcedureSummary {
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
      name: row.name,
      performedAt: toIso(row.performed_at),
      performer: { id: row.performer_staff_id, name: row.performer_name },
      outcome: row.outcome,
      notes: row.notes,
      preOpAssessment: row.pre_op_assessment,
      anaesthesia: row.anaesthesia,
      operativeNote: row.operative_note,
      postOpCourse: row.post_op_course,
      recordedAt: toIso(row.recorded_at),
      recordedBy: { id: row.attributed_clinician_id, name: row.clinician_name },
      entry: {
        source: row.entry_source,
        enteredBy: { id: row.recorded_by_staff_id, name: row.entered_by_name },
      },
      supersedesId: row.supersedes_id,
    };
  }
}
