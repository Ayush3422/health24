import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import type { CreateHospitalInput, HospitalSummary, UpdateHospitalInput } from '@health24/shared';
import { DatabaseService } from '../../db/database.service';
import { hospitals } from '../../db/schema';
import type { Actor, RequestMeta } from '../../common/actor';
import { AuditService } from '../audit/audit.service';

type HospitalRow = typeof hospitals.$inferSelect;

@Injectable()
export class HospitalsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Onboards a hospital. Platform administrators only.
   *
   * Runs in system context because a new tenant has no tenant context to run
   * in, and the acting platform admin belongs to no hospital.
   */
  async create(
    actor: Actor,
    input: CreateHospitalInput,
    meta: RequestMeta,
  ): Promise<HospitalSummary> {
    const created = await this.db.asSystem(async (tx) => {
      if (input.hfrId) {
        const [clash] = await tx
          .select({ id: hospitals.id })
          .from(hospitals)
          .where(eq(hospitals.hfrId, input.hfrId))
          .limit(1);

        if (clash) {
          throw new ConflictException('A hospital with that HFR ID already exists');
        }
      }

      const [row] = await tx
        .insert(hospitals)
        .values({
          name: input.name,
          facilityType: input.facilityType,
          hfrId: input.hfrId ?? null,
          contactEmail: input.contactEmail,
          contactPhone: input.contactPhone,
          address: input.address,
          mrnPrefix: input.mrnPrefix,
          status: 'onboarding',
        })
        .returning();

      if (!row) {
        throw new Error('Failed to create hospital');
      }

      return row;
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'hospital',
      resourceId: created.id,
      action: 'create',
      meta,
    });

    return this.toSummary(created);
  }

  /** Every hospital on the platform. Platform administrators only. */
  async listAll(actor: Actor, meta: RequestMeta): Promise<HospitalSummary[]> {
    const rows = await this.db.asSystem(async (tx) =>
      tx.select().from(hospitals).orderBy(asc(hospitals.name)),
    );

    await this.audit.recordForActor(actor, {
      resourceType: 'hospital',
      action: 'search',
      meta,
    });

    return rows.map((row) => this.toSummary(row));
  }

  /**
   * The caller's own hospital.
   *
   * Scoped by tenant context, so row-level security is doing the enforcement
   * rather than a `WHERE` clause we could forget.
   */
  async findOwn(actor: Actor, meta: RequestMeta): Promise<HospitalSummary> {
    if (!actor.hospitalId) {
      throw new ForbiddenException('Your account is not attached to a hospital');
    }

    const hospitalId = actor.hospitalId;

    const row = await this.db.asTenant(hospitalId, async (tx) => {
      const [found] = await tx
        .select()
        .from(hospitals)
        .where(eq(hospitals.id, hospitalId))
        .limit(1);
      return found;
    });

    if (!row) {
      throw new NotFoundException('Hospital not found');
    }

    await this.audit.recordForActor(actor, {
      resourceType: 'hospital',
      resourceId: row.id,
      action: 'read',
      meta,
    });

    return this.toSummary(row);
  }

  /** Any hospital by id. Platform administrators only. */
  async findById(actor: Actor, id: string, meta: RequestMeta): Promise<HospitalSummary> {
    const row = await this.db.asSystem(async (tx) => {
      const [found] = await tx.select().from(hospitals).where(eq(hospitals.id, id)).limit(1);
      return found;
    });

    if (!row) {
      throw new NotFoundException('Hospital not found');
    }

    await this.audit.recordForActor(actor, {
      resourceType: 'hospital',
      resourceId: row.id,
      action: 'read',
      meta,
    });

    return this.toSummary(row);
  }

  /**
   * Updates a hospital.
   *
   * A hospital admin may edit their own facility's details but not its status
   * — suspending or offboarding a tenant is a platform decision, and letting a
   * tenant change its own status would let it escape suspension.
   */
  async update(
    actor: Actor,
    id: string,
    input: UpdateHospitalInput,
    meta: RequestMeta,
  ): Promise<HospitalSummary> {
    const isPlatformAdmin = actor.role === 'platform_admin';

    if (!isPlatformAdmin) {
      if (!actor.hospitalId || actor.hospitalId !== id) {
        throw new ForbiddenException('You can only update your own hospital');
      }

      if (input.status !== undefined) {
        throw new ForbiddenException('Only platform administrators can change hospital status');
      }
    }

    const changes: Partial<typeof hospitals.$inferInsert> = { updatedAt: new Date() };

    if (input.name !== undefined) changes.name = input.name;
    if (input.facilityType !== undefined) changes.facilityType = input.facilityType;
    if (input.hfrId !== undefined) changes.hfrId = input.hfrId;
    if (input.contactEmail !== undefined) changes.contactEmail = input.contactEmail;
    if (input.contactPhone !== undefined) changes.contactPhone = input.contactPhone;
    if (input.address !== undefined) changes.address = input.address;
    if (input.status !== undefined) changes.status = input.status;

    // Changing the MRN prefix does not rewrite existing medical record
    // numbers — those are printed on paper across the hospital and must not
    // move. New registrations simply start using the new prefix.
    if (input.mrnPrefix !== undefined) changes.mrnPrefix = input.mrnPrefix;

    const updated = await this.db.asSystem(async (tx) => {
      const [row] = await tx.update(hospitals).set(changes).where(eq(hospitals.id, id)).returning();
      return row;
    });

    if (!updated) {
      throw new NotFoundException('Hospital not found');
    }

    await this.audit.recordForActor(actor, {
      resourceType: 'hospital',
      resourceId: id,
      action: 'update',
      meta,
    });

    return this.toSummary(updated);
  }

  private toSummary(row: HospitalRow): HospitalSummary {
    return {
      id: row.id,
      name: row.name,
      facilityType: row.facilityType,
      status: row.status,
      hfrId: row.hfrId,
      mrnPrefix: row.mrnPrefix,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
