import { ForbiddenException } from '@nestjs/common';
import type { StaffRole } from '@health24/shared';

/**
 * The authenticated caller, resolved once per request by the auth guard and
 * threaded explicitly through the services that need it.
 *
 * Explicit rather than ambient: a service that touches patient data should
 * have to name whose authority it is acting under, because that is exactly
 * what the audit trail has to record.
 */
export interface Actor {
  staffUserId: string;
  role: StaffRole;
  /** Null only for platform admins, who belong to no hospital. */
  hospitalId: string | null;
  sessionId: string;
  name: string;
  email: string;
}

/** Request-scoped metadata attached alongside the actor, for audit rows. */
export interface RequestMeta {
  requestId: string;
  ipAddress: string | null;
  userAgent: string | null;
  route: string | null;
}

export interface AuthenticatedRequest {
  actor?: Actor;
  meta: RequestMeta;
}

/**
 * Narrows an actor to one that definitely belongs to a hospital.
 *
 * Platform admins and terminology curators have no tenant, so any code path
 * that needs a tenant context must reject them explicitly rather than
 * defaulting to something.
 *
 * A 403, not a plain Error. A plain Error surfaces as a 500, which tells the
 * caller the server broke when in fact they asked for something their account
 * cannot do — and a second platform-level role made that path reachable.
 */
export function requireHospital(actor: Actor): string {
  if (!actor.hospitalId) {
    throw new ForbiddenException('This action requires an account attached to a hospital');
  }

  return actor.hospitalId;
}
