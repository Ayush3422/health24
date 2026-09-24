import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type {
  AddBedsInput,
  BedSummary,
  BedStatus,
  CreateWardInput,
  SetBedStatusInput,
  UpdateWardInput,
  WardKind,
  WardList,
  WardStatus,
  WardSummary,
} from '@health24/shared';
import { requireHospital, type Actor, type RequestMeta } from '../../common/actor';
import type { DbTransaction } from '../../db/client';
import { DatabaseService } from '../../db/database.service';
import { AuditService } from '../audit/audit.service';
import { blankToNull, toIso, violatedConstraint } from '../clinical/clinical-access';

type BedRow = {
  id: string;
  ward_id: string;
  ward_name: string;
  ward_kind: WardKind;
  ward_status: WardStatus;
  label: string;
  status: BedStatus;
  blocked_reason: string | null;
  occupant_patient_id: string | null;
  occupant_name: string | null;
  occupant_mrn: string | null;
  occupant_encounter_id: string | null;
  occupied_since: string | Date | null;
};

/**
 * Beds with whoever is in them.
 *
 * Occupancy is read from the open stay rather than a column on the bed, so the
 * board cannot drift from the record (Decision P1). The patient's name comes
 * through the same row-level security as everywhere else: a caller who may not
 * read the record sees the bed and not the person.
 */
const BED_SELECT = sql`
  SELECT b."id", b."ward_id", w."name" AS ward_name, w."kind" AS ward_kind, w."status" AS ward_status,
         b."label", b."status", b."blocked_reason",
         s."patient_id" AS occupant_patient_id, p."name" AS occupant_name, l."mrn" AS occupant_mrn,
         s."encounter_id" AS occupant_encounter_id, s."started_at" AS occupied_since
    FROM "bed" b
    JOIN "ward" w ON w."id" = b."ward_id"
    LEFT JOIN "bed_stay" s ON s."bed_id" = b."id" AND s."ended_at" IS NULL
    LEFT JOIN "patient" p ON p."id" = s."patient_id"
    LEFT JOIN "patient_hospital_link" l
           ON l."patient_id" = s."patient_id" AND l."hospital_id" = app.current_hospital_id()
`;

/**
 * Wards and beds (sp6-plan.md, Decision P1): the hospital's own furniture,
 * set up by its administrator and read by everyone who admits or rounds.
 */
@Injectable()
export class WardsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async create(actor: Actor, input: CreateWardInput, meta: RequestMeta): Promise<WardSummary> {
    const hospitalId = requireHospital(actor);

    const wardId = await this.db.asTenant(hospitalId, async (tx) => {
      try {
        const [ward] = await tx.execute<{ id: string }>(sql`
          INSERT INTO "ward" ("hospital_id", "name", "kind")
          VALUES (${hospitalId}::uuid, ${input.name}, ${input.kind}::ward_kind)
          RETURNING "id"
        `);

        await this.insertBeds(tx, hospitalId, ward!.id, input.beds);
        return ward!.id;
      } catch (error) {
        throw this.translate(error);
      }
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'ward',
      resourceId: wardId,
      patientId: null,
      action: 'create',
      meta,
    });

    return this.one(actor, wardId);
  }

  async update(
    actor: Actor,
    wardId: string,
    input: UpdateWardInput,
    meta: RequestMeta,
  ): Promise<WardSummary> {
    const hospitalId = requireHospital(actor);

    await this.db.asTenant(hospitalId, async (tx) => {
      if (input.status === 'closed') {
        const [occupied] = await tx.execute<{ count: number }>(sql`
          SELECT count(*)::int AS count
            FROM "bed_stay" s JOIN "bed" b ON b."id" = s."bed_id"
           WHERE b."ward_id" = ${wardId}::uuid AND s."ended_at" IS NULL
        `);

        if ((occupied?.count ?? 0) > 0) {
          throw new ConflictException('There are still patients in this ward');
        }
      }

      try {
        const updated = await tx.execute(sql`
          UPDATE "ward"
             SET "name" = coalesce(${input.name ?? null}, "name"),
                 "kind" = coalesce(${input.kind ?? null}::ward_kind, "kind"),
                 "status" = coalesce(${input.status ?? null}::ward_status, "status")
           WHERE "id" = ${wardId}::uuid
       RETURNING "id"
        `);

        if ([...updated].length === 0) throw new NotFoundException('Ward not found');
      } catch (error) {
        throw this.translate(error);
      }
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'ward',
      resourceId: wardId,
      patientId: null,
      action: 'update',
      meta,
    });

    return this.one(actor, wardId);
  }

  async addBeds(
    actor: Actor,
    wardId: string,
    input: AddBedsInput,
    meta: RequestMeta,
  ): Promise<WardSummary> {
    const hospitalId = requireHospital(actor);

    await this.db.asTenant(hospitalId, async (tx) => {
      const [ward] = await tx.execute<{ status: WardStatus }>(sql`
        SELECT "status" FROM "ward" WHERE "id" = ${wardId}::uuid
      `);

      if (!ward) throw new NotFoundException('Ward not found');
      if (ward.status === 'closed') throw new ConflictException('That ward is closed');

      try {
        await this.insertBeds(tx, hospitalId, wardId, input.labels);
      } catch (error) {
        throw this.translate(error);
      }
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'bed',
      resourceId: wardId,
      patientId: null,
      action: 'create',
      meta,
    });

    return this.one(actor, wardId);
  }

  /** Out of service, or back in it. A bed with a patient in it is neither. */
  async setBedStatus(
    actor: Actor,
    bedId: string,
    input: SetBedStatusInput,
    meta: RequestMeta,
  ): Promise<BedSummary> {
    const hospitalId = requireHospital(actor);

    const row = await this.db.asTenant(hospitalId, async (tx) => {
      const [bed] = await tx.execute<BedRow>(sql`${BED_SELECT} WHERE b."id" = ${bedId}::uuid`);

      if (!bed) throw new NotFoundException('Bed not found');

      if (input.status === 'blocked' && bed.occupant_patient_id) {
        throw new ConflictException('Somebody is in that bed; move them first');
      }

      await tx.execute(sql`
        UPDATE "bed"
           SET "status" = ${input.status}::bed_status,
               "blocked_reason" = ${input.status === 'blocked' ? blankToNull(input.reason) : null}
         WHERE "id" = ${bedId}::uuid
      `);

      const [updated] = await tx.execute<BedRow>(sql`${BED_SELECT} WHERE b."id" = ${bedId}::uuid`);
      return updated!;
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'bed',
      resourceId: bedId,
      patientId: null,
      action: 'update',
      meta,
    });

    return this.toBed(row);
  }

  async list(actor: Actor, meta: RequestMeta): Promise<WardList> {
    const hospitalId = requireHospital(actor);

    const rows = await this.db.asTenant(hospitalId, (tx) =>
      tx.execute<BedRow>(sql`${BED_SELECT} ORDER BY w."name", b."label"`),
    );

    const wards = await this.db.asTenant(hospitalId, (tx) =>
      tx.execute<{ id: string; name: string; kind: WardKind; status: WardStatus }>(sql`
        SELECT "id", "name", "kind", "status" FROM "ward" ORDER BY "name"
      `),
    );

    await this.audit.recordForActor(actor, {
      resourceType: 'ward',
      resourceId: null,
      patientId: null,
      action: 'search',
      meta,
    });

    return { wards: [...wards].map((ward) => this.toWard(ward, [...rows])) };
  }

  /** One ward, read straight back after a change. */
  private async one(actor: Actor, wardId: string): Promise<WardSummary> {
    const hospitalId = requireHospital(actor);

    const { ward, beds } = await this.db.asTenant(hospitalId, async (tx) => {
      const [found] = await tx.execute<{
        id: string;
        name: string;
        kind: WardKind;
        status: WardStatus;
      }>(sql`SELECT "id", "name", "kind", "status" FROM "ward" WHERE "id" = ${wardId}::uuid`);

      if (!found) throw new NotFoundException('Ward not found');

      const rows = await tx.execute<BedRow>(
        sql`${BED_SELECT} WHERE b."ward_id" = ${wardId}::uuid ORDER BY b."label"`,
      );

      return { ward: found, beds: [...rows] };
    });

    return this.toWard(ward, beds);
  }

  private async insertBeds(
    tx: DbTransaction,
    hospitalId: string,
    wardId: string,
    labels: readonly string[],
  ): Promise<void> {
    for (const label of labels) {
      await tx.execute(sql`
        INSERT INTO "bed" ("hospital_id", "ward_id", "label")
        VALUES (${hospitalId}::uuid, ${wardId}::uuid, ${label})
      `);
    }
  }

  private toWard(
    ward: { id: string; name: string; kind: WardKind; status: WardStatus },
    rows: BedRow[],
  ): WardSummary {
    const beds = rows.filter((row) => row.ward_id === ward.id).map((row) => this.toBed(row));

    return {
      id: ward.id,
      name: ward.name,
      kind: ward.kind,
      status: ward.status,
      beds,
      occupied: beds.filter((bed) => bed.occupant !== null).length,
      free: beds.filter((bed) => bed.occupant === null && bed.status === 'available').length,
    };
  }

  private toBed(row: BedRow): BedSummary {
    return {
      id: row.id,
      wardId: row.ward_id,
      wardName: row.ward_name,
      label: row.label,
      status: row.status,
      blockedReason: row.blocked_reason,
      occupant:
        row.occupant_patient_id && row.occupant_encounter_id && row.occupied_since
          ? {
              patientId: row.occupant_patient_id,
              name: row.occupant_name ?? 'A patient',
              mrn: row.occupant_mrn,
              encounterId: row.occupant_encounter_id,
              since: toIso(row.occupied_since),
            }
          : null,
    };
  }

  /** A duplicate name or label is the administrator's mistake, not a server error. */
  private translate(error: unknown): unknown {
    const constraint = violatedConstraint(error);

    if (constraint === 'ward_name_per_hospital') {
      return new BadRequestException('A ward of that name already exists');
    }

    if (constraint === 'bed_label_per_ward') {
      return new BadRequestException('That ward already has a bed with that label');
    }

    return error;
  }
}
