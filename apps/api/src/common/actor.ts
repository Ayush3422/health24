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
 * Platform admins have no tenant, so any code path that needs a tenant context
 * must reject them explicitly rather than defaulting to something.
 */
export function requireHospital(actor: Actor): string {
  if (!actor.hospitalId) {
    throw new Error(
      `Actor ${actor.staffUserId} (${actor.role}) has no hospital; this operation requires one`,
    );
  }

  return actor.hospitalId;
}
