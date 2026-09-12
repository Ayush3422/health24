import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq, ne } from 'drizzle-orm';
import type {
  InviteStaffInput,
  StaffInviteResult,
  StaffSummary,
  UpdateStaffInput,
} from '@health24/shared';
import { DatabaseService } from '../../db/database.service';
import { staffUsers } from '../../db/schema';
import { generateToken, hashToken } from '../../common/crypto';
import { requireHospital, type Actor, type RequestMeta } from '../../common/actor';
import { AuditService } from '../audit/audit.service';
import { SessionService } from '../auth/session.service';

type StaffRow = typeof staffUsers.$inferSelect;

@Injectable()
export class StaffService {
  private static readonly INVITE_TTL_HOURS = 72;

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
  ) {}

  /**
   * Invites a staff member to the caller's hospital.
   *
   * The invitation creates the account in `invited` state with no password.
   * The token is returned to the inviter rather than emailed, because there is
   * no mail transport yet — see `staffInviteResultSchema` for why that is
   * temporary.
   */
  async invite(
    actor: Actor,
    input: InviteStaffInput,
    meta: RequestMeta,
  ): Promise<StaffInviteResult> {
    const hospitalId = requireHospital(actor);

    if (input.role === 'clinician' && !input.systemOfMedicine) {
      throw new BadRequestException(
        'A clinician must have a system of medicine — the timeline separates traditional from biomedical care by this field',
      );
    }

    const inviteToken = generateToken(32);
    const expiresAt = new Date(Date.now() + StaffService.INVITE_TTL_HOURS * 60 * 60 * 1000);

    // Email uniqueness is global, so the check cannot be tenant-scoped: the
    // clash may be with an account at another hospital, which this admin
    // cannot see and must not be told about.
    const created = await this.db.asSystem(async (tx) => {
      const [clash] = await tx
        .select({ id: staffUsers.id })
        .from(staffUsers)
        .where(eq(staffUsers.email, input.email))
        .limit(1);

      if (clash) {
        throw new ConflictException('That email address is already registered');
      }

      const [row] = await tx
        .insert(staffUsers)
        .values({
          hospitalId,
          name: input.name,
          email: input.email,
          phone: input.phone ?? null,
          role: input.role,
          systemOfMedicine: input.systemOfMedicine ?? null,
          hprId: input.hprId ?? null,
          status: 'invited',
          inviteTokenHash: hashToken(inviteToken),
          inviteExpiresAt: expiresAt,
        })
        .returning();

      if (!row) {
        throw new Error('Failed to create staff account');
      }

      return row;
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'staff_user',
      resourceId: created.id,
      action: 'create',
      meta,
    });

    return {
      staff: this.toSummary(created),
      inviteToken,
      expiresAt: expiresAt.toISOString(),
    };
  }

  /** Staff of the caller's own hospital. Scoped by row-level security. */
  async list(actor: Actor, meta: RequestMeta): Promise<StaffSummary[]> {
    const hospitalId = requireHospital(actor);

    const rows = await this.db.asTenant(hospitalId, async (tx) =>
      tx.select().from(staffUsers).orderBy(asc(staffUsers.name)),
    );

    await this.audit.recordForActor(actor, {
      resourceType: 'staff_user',
      action: 'search',
      meta,
    });

    return rows.map((row) => this.toSummary(row));
  }

  async findById(actor: Actor, id: string, meta: RequestMeta): Promise<StaffSummary> {
    const row = await this.loadWithinTenant(actor, id);

    await this.audit.recordForActor(actor, {
      resourceType: 'staff_user',
      resourceId: id,
      action: 'read',
      meta,
    });

    return this.toSummary(row);
  }

  /**
   * Updates a staff member.
   *
   * An administrator cannot change their own role. Not because demotion is
   * dangerous, but because self-service role changes are how an account
   * escalates itself, and because an admin who demotes themselves by accident
   * locks the hospital out of its own staff management.
   */
  async update(
    actor: Actor,
    id: string,
    input: UpdateStaffInput,
    meta: RequestMeta,
  ): Promise<StaffSummary> {
    const hospitalId = requireHospital(actor);
    const existing = await this.loadWithinTenant(actor, id);

    if (input.role !== undefined && id === actor.staffUserId) {
      throw new ForbiddenException('You cannot change your own role');
    }

    if (input.role !== undefined && existing.role !== input.role) {
      await this.assertNotLastAdmin(hospitalId, existing, 'change the role of');
    }

    const nextRole = input.role ?? existing.role;
    const nextSystem =
      input.systemOfMedicine !== undefined ? input.systemOfMedicine : existing.systemOfMedicine;

    if (nextRole === 'clinician' && !nextSystem) {
      throw new BadRequestException('A clinician must have a system of medicine');
    }

    const changes: Partial<typeof staffUsers.$inferInsert> = { updatedAt: new Date() };
    if (input.name !== undefined) changes.name = input.name;
    if (input.phone !== undefined) changes.phone = input.phone;
    if (input.role !== undefined) changes.role = input.role;
    if (input.systemOfMedicine !== undefined) changes.systemOfMedicine = input.systemOfMedicine;
    if (input.hprId !== undefined) changes.hprId = input.hprId;

    const updated = await this.db.asTenant(hospitalId, async (tx) => {
      const [row] = await tx
        .update(staffUsers)
        .set(changes)
        .where(eq(staffUsers.id, id))
        .returning();

      return row;
    });

    if (!updated) {
      throw new NotFoundException('Staff member not found');
    }

    // A role change must take effect now, not whenever their token expires.
    // The auth guard reads the role from the database on every request, so
    // existing sessions already pick this up — revoking them makes the change
    // visible to the user rather than silently altering what they can do.
    if (input.role !== undefined) {
      await this.sessions.revokeAllForStaff(id, 'role_changed');
    }

    await this.audit.recordForActor(actor, {
      resourceType: 'staff_user',
      resourceId: id,
      action: 'update',
      meta,
    });

    return this.toSummary(updated);
  }

  /**
   * Deactivates a staff member and cuts off their sessions immediately.
   *
   * Deactivation is the lever pulled when someone leaves or when an account is
   * suspected of compromise. If it does not take effect until a token expires,
   * it is not a security control.
   */
  async deactivate(
    actor: Actor,
    id: string,
    reason: string,
    meta: RequestMeta,
  ): Promise<StaffSummary> {
    const hospitalId = requireHospital(actor);
    const existing = await this.loadWithinTenant(actor, id);

    if (id === actor.staffUserId) {
      throw new ForbiddenException('You cannot deactivate your own account');
    }

    await this.assertNotLastAdmin(hospitalId, existing, 'deactivate');

    const updated = await this.db.asTenant(hospitalId, async (tx) => {
      const [row] = await tx
        .update(staffUsers)
        .set({ status: 'deactivated', updatedAt: new Date() })
        .where(eq(staffUsers.id, id))
        .returning();

      return row;
    });

    if (!updated) {
      throw new NotFoundException('Staff member not found');
    }

    await this.sessions.revokeAllForStaff(id, 'account_deactivated');

    await this.audit.recordForActor(actor, {
      resourceType: 'staff_user',
      resourceId: id,
      action: 'update',
      meta,
    });

    return this.toSummary(updated);
  }

  async reinstate(actor: Actor, id: string, meta: RequestMeta): Promise<StaffSummary> {
    const hospitalId = requireHospital(actor);
    const existing = await this.loadWithinTenant(actor, id);

    if (existing.status !== 'deactivated' && existing.status !== 'suspended') {
      throw new BadRequestException('That account is not deactivated');
    }

    // An account that never set a password returns to `invited`, not `active`
    // — otherwise reinstating would produce an active account nobody can sign
    // in to, and no way to notice.
    const nextStatus = existing.passwordHash ? 'active' : 'invited';

    const updated = await this.db.asTenant(hospitalId, async (tx) => {
      const [row] = await tx
        .update(staffUsers)
        .set({ status: nextStatus, updatedAt: new Date() })
        .where(eq(staffUsers.id, id))
        .returning();

      return row;
    });

    if (!updated) {
      throw new NotFoundException('Staff member not found');
    }

    await this.audit.recordForActor(actor, {
      resourceType: 'staff_user',
      resourceId: id,
      action: 'update',
      meta,
    });

    return this.toSummary(updated);
  }

  /**
   * Loads a staff row within the caller's tenant.
   *
   * Row-level security does the scoping, so a staff member at another hospital
   * simply is not found — the caller learns nothing about whether the id
   * exists elsewhere.
   */
  private async loadWithinTenant(actor: Actor, id: string): Promise<StaffRow> {
    const hospitalId = requireHospital(actor);

    const row = await this.db.asTenant(hospitalId, async (tx) => {
      const [found] = await tx.select().from(staffUsers).where(eq(staffUsers.id, id)).limit(1);
      return found;
    });

    if (!row) {
      throw new NotFoundException('Staff member not found');
    }

    return row;
  }

  /**
   * Prevents a hospital from removing its last administrator.
   *
   * Without this, one careless deactivation leaves a hospital with no one able
   * to invite staff or manage the account — recoverable only by Health24
   * support, which is a support burden created entirely by omitting this check.
   *
   * Currently unreachable, deliberately kept. Only `hospital_admin` holds
   * staff:update and staff:deactivate, so targeting the last active admin
   * requires being an active admin — which means there are two. The remaining
   * path, acting on oneself, is refused earlier. This guard goes live the
   * moment platform support is given staff permissions over a tenant, and
   * removing it now only means rediscovering the problem then.
   */
  private async assertNotLastAdmin(
    hospitalId: string,
    target: StaffRow,
    verb: string,
  ): Promise<void> {
    if (target.role !== 'hospital_admin') {
      return;
    }

    const others = await this.db.asTenant(hospitalId, async (tx) =>
      tx
        .select({ id: staffUsers.id })
        .from(staffUsers)
        .where(
          and(
            eq(staffUsers.role, 'hospital_admin'),
            eq(staffUsers.status, 'active'),
            ne(staffUsers.id, target.id),
          ),
        ),
    );

    if (others.length === 0) {
      throw new ConflictException(
        `Cannot ${verb} the last active administrator — promote another administrator first`,
      );
    }
  }

  private toSummary(row: StaffRow): StaffSummary {
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      phone: row.phone,
      role: row.role,
      systemOfMedicine: row.systemOfMedicine,
      hprId: row.hprId,
      status: row.status,
      mfaEnrolled: row.totpEnrolledAt !== null,
      lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
