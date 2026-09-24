import { BadRequestException, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type {
  CorrectImplantInput,
  ImplantList,
  ImplantSearch,
  ImplantSearchResults,
  ImplantSummary,
  RecordImplantInput,
} from '@health24/shared';
import { requireHospital, type Actor, type RequestMeta } from '../../common/actor';
import type { DbTransaction } from '../../db/client';
import { DatabaseService } from '../../db/database.service';
import { implantDevices } from '../../db/schema';
import { AuditService } from '../audit/audit.service';
import {
  blankToNull,
  coveringConsentId,
  requireLinkedPatient,
  requireWritableEncounter,
  resolveAttribution,
  toIso,
  type Attribution,
} from './clinical-access';
import { attributionForCorrection, loadForChange, retire } from './corrections.service';

type ImplantRow = {
  id: string;
  patient_id: string;
  encounter_id: string;
  hospital_id: string;
  hospital_name: string | null;
  procedure_id: string | null;
  procedure_name: string | null;
  name: string;
  manufacturer: string | null;
  model: string | null;
  serial_or_lot: string | null;
  implanted_at: string | Date;
  notes: string | null;
  recorded_at: string | Date;
  attributed_clinician_id: string;
  clinician_name: string | null;
  entry_source: 'direct' | 'transcribed';
  recorded_by_staff_id: string;
  entered_by_name: string | null;
  supersedes_id: string | null;
};

type SearchRow = ImplantRow & { patient_name: string | null; mrn: string | null };

const IMPLANT_SELECT = sql`
  SELECT i."id", i."patient_id", i."encounter_id", i."hospital_id", d."name" AS hospital_name,
         i."procedure_id", i."procedure_name", i."name", i."manufacturer", i."model",
         i."serial_or_lot", i."implanted_at", i."notes", i."recorded_at",
         i."attributed_clinician_id", cl."name" AS clinician_name, i."entry_source",
         i."recorded_by_staff_id", eb."name" AS entered_by_name, i."supersedes_id"
    FROM "implant_device" i
    LEFT JOIN "hospital_directory" d ON d."id" = i."hospital_id"
    LEFT JOIN "staff_user" cl ON cl."id" = i."attributed_clinician_id"
    LEFT JOIN "staff_user" eb ON eb."id" = i."recorded_by_staff_id"
`;

/**
 * Implants and devices (sp6-plan.md, Decision Q1).
 *
 * What was put into a patient, and how to find it again when a manufacturer
 * recalls a batch. Corrected by superseding, like every clinical entry, and
 * searchable by serial or lot across the hospital's own record.
 */
@Injectable()
export class ImplantsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async record(
    actor: Actor,
    input: RecordImplantInput,
    meta: RequestMeta,
  ): Promise<ImplantSummary> {
    const hospitalId = requireHospital(actor);

    const row = await this.db.asTenant(hospitalId, async (tx) => {
      const encounter = await requireWritableEncounter(
        tx,
        hospitalId,
        input.encounterId,
        'A device is',
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
        actor,
        attribution,
        supersedesId: null,
      });
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'implant_device',
      resourceId: row.id,
      patientId: row.patient_id,
      action: 'create',
      meta,
    });

    return this.toSummary(row, hospitalId);
  }

  async correct(
    actor: Actor,
    implantId: string,
    input: CorrectImplantInput,
    meta: RequestMeta,
  ): Promise<ImplantSummary> {
    const hospitalId = requireHospital(actor);

    const row = await this.db.asTenant(hospitalId, async (tx) => {
      const original = await loadForChange(tx, 'implants', implantId, actor, hospitalId);
      const attribution = await attributionForCorrection(tx, actor, hospitalId, original);

      await retire(tx, 'implants', implantId, actor, input.reason, 'superseded');

      return this.insert(tx, {
        input,
        patientId: original.patient_id,
        hospitalId,
        encounterId: original.encounter_id as string,
        actor,
        attribution,
        supersedesId: implantId,
      });
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'implant_device',
      resourceId: implantId,
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
  ): Promise<ImplantSummary[]> {
    const hospitalId = requireHospital(actor);

    const rows = await this.db.asTenant(hospitalId, (tx) =>
      this.query(
        tx,
        sql`WHERE i."encounter_id" = ${encounterId}::uuid AND i."version_status" = 'current'
         ORDER BY i."implanted_at" ASC`,
      ),
    );

    if (rows[0]) {
      await this.audit.recordForActor(actor, {
        resourceType: 'implant_device',
        resourceId: encounterId,
        patientId: rows[0].patient_id,
        action: 'read',
        meta,
      });
    }

    return rows.map((row) => this.toSummary(row, hospitalId));
  }

  async forPatient(actor: Actor, patientId: string, meta: RequestMeta): Promise<ImplantList> {
    const hospitalId = requireHospital(actor);

    const { rows, consentArtefactId } = await this.db.asTenant(hospitalId, async (tx) => {
      await requireLinkedPatient(tx, hospitalId, patientId);

      const found = await this.query(
        tx,
        sql`WHERE i."patient_id" = ANY (app.patient_record_ids(${patientId}::uuid))
              AND i."version_status" = 'current'
         ORDER BY i."implanted_at" DESC`,
      );

      return {
        rows: found,
        consentArtefactId: found.some((row) => row.hospital_id !== hospitalId)
          ? await coveringConsentId(tx, patientId, 'procedures')
          : null,
      };
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'implant_device',
      resourceId: patientId,
      patientId,
      action: 'read',
      consentArtefactId,
      meta,
    });

    return {
      implants: rows.map((row) => this.toSummary(row, hospitalId)),
      sharedFromOtherHospitals: rows.some((row) => row.hospital_id !== hospitalId),
    };
  }

  /**
   * A recall: every device of this batch, and who carries one.
   *
   * The hospital's own record only — another hospital's implants are theirs to
   * search, and a recall is answered by each hospital for its own patients.
   */
  async search(
    actor: Actor,
    query: ImplantSearch,
    meta: RequestMeta,
  ): Promise<ImplantSearchResults> {
    const hospitalId = requireHospital(actor);
    const like = `%${query.q}%`;

    const rows = await this.db.asTenant(hospitalId, (tx) =>
      tx.execute<SearchRow>(sql`
        SELECT found.*, p."name" AS patient_name, l."mrn"
          FROM (${IMPLANT_SELECT}
                 WHERE i."hospital_id" = ${hospitalId}::uuid
                   AND i."version_status" = 'current'
                   AND (i."serial_or_lot" ILIKE ${like} OR i."model" ILIKE ${like})
               ) AS found
          JOIN "patient" p ON p."id" = found."patient_id"
          LEFT JOIN "patient_hospital_link" l
                 ON l."patient_id" = found."patient_id" AND l."hospital_id" = ${hospitalId}::uuid
      ORDER BY found."implanted_at" DESC
         LIMIT ${query.limit}
      `),
    );

    await this.audit.recordForActor(actor, {
      resourceType: 'implant_device',
      resourceId: null,
      patientId: null,
      action: 'search',
      meta,
    });

    return {
      results: [...rows].map((row) => ({
        ...this.toSummary(row, hospitalId),
        patient: { id: row.patient_id, name: row.patient_name ?? 'A patient', mrn: row.mrn },
      })),
    };
  }

  private async insert(
    tx: DbTransaction,
    args: {
      input: RecordImplantInput | CorrectImplantInput;
      patientId: string;
      hospitalId: string;
      encounterId: string;
      actor: Actor;
      attribution: Attribution;
      supersedesId: string | null;
    },
  ): Promise<ImplantRow> {
    const { input } = args;
    const procedure = input.procedureId
      ? await this.requireProcedure(tx, input.procedureId, args.patientId)
      : null;

    const [created] = await tx
      .insert(implantDevices)
      .values({
        patientId: args.patientId,
        hospitalId: args.hospitalId,
        encounterId: args.encounterId,
        procedureId: procedure?.id ?? null,
        procedureName: procedure?.name ?? null,
        name: input.name.trim(),
        manufacturer: blankToNull(input.manufacturer),
        model: blankToNull(input.model),
        serialOrLot: blankToNull(input.serialOrLot),
        // The operation's own time, unless the recorder says otherwise.
        implantedAt: input.implantedAt
          ? new Date(input.implantedAt)
          : (procedure?.performedAt ?? new Date()),
        notes: blankToNull(input.notes),
        recordedByStaffId: args.actor.staffUserId,
        attributedClinicianId: args.attribution.clinicianId,
        entrySource: args.attribution.entrySource,
        supersedesId: args.supersedesId,
      })
      .returning({ id: implantDevices.id });

    if (!created) throw new Error('Failed to record the device');

    const [row] = await this.query(tx, sql`WHERE i."id" = ${created.id}::uuid`);
    if (!row) throw new Error('Recorded device is not readable');

    return row;
  }

  /** The operation it was implanted during: this patient's, at this hospital. */
  private async requireProcedure(
    tx: DbTransaction,
    procedureId: string,
    patientId: string,
  ): Promise<{ id: string; name: string; performedAt: Date }> {
    const [procedure] = await tx.execute<{
      id: string;
      name: string;
      patient_id: string;
      performed_at: string | Date;
    }>(sql`
      SELECT "id", "name", "patient_id", "performed_at" FROM "procedure"
       WHERE "id" = ${procedureId}::uuid
    `);

    if (!procedure || procedure.patient_id !== patientId) {
      throw new BadRequestException('That procedure is not on this patient’s record');
    }

    return {
      id: procedure.id,
      name: procedure.name,
      performedAt: new Date(procedure.performed_at),
    };
  }

  private async query(tx: DbTransaction, tail: ReturnType<typeof sql>): Promise<ImplantRow[]> {
    const rows = await tx.execute<ImplantRow>(sql`${IMPLANT_SELECT} ${tail}`);
    return [...rows];
  }

  private toSummary(row: ImplantRow, hospitalId: string): ImplantSummary {
    return {
      id: row.id,
      patientId: row.patient_id,
      encounterId: row.encounter_id,
      hospital: {
        id: row.hospital_id,
        name: row.hospital_name ?? 'Unknown hospital',
        isOwn: row.hospital_id === hospitalId,
      },
      procedureId: row.procedure_id,
      procedureName: row.procedure_name,
      name: row.name,
      manufacturer: row.manufacturer,
      model: row.model,
      serialOrLot: row.serial_or_lot,
      implantedAt: toIso(row.implanted_at),
      notes: row.notes,
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
