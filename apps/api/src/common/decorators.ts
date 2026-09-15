import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';
import type { Permission } from '@health24/shared';
import type { Actor, PatientActor, RequestMeta } from './actor';

export const IS_PUBLIC_KEY = 'health24:isPublic';
export const REQUIRED_PERMISSION_KEY = 'health24:requiredPermission';
export const IS_PORTAL_KEY = 'health24:isPortal';

/**
 * Marks a route as the patient portal's (SP5). Only a patient session reaches
 * it — a staff token is refused — and a staff route, in turn, refuses every
 * patient token. Portal routes carry no staff permission: the database admits
 * only the signed-in patient's own record.
 */
export const PortalRoute = () => SetMetadata(IS_PORTAL_KEY, true);

/**
 * Marks a route as reachable without authentication.
 *
 * Authentication is on by default and opted out of here, rather than opted
 * into. Forgetting `@Public()` makes a public route return 401 — visible in
 * the first test. Forgetting an `@Auth()` in the opposite design would expose
 * patient data silently.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Declares the permission a route requires.
 *
 * Accepts several, with OR semantics, for the routes that legitimately serve
 * two audiences — `PATCH /hospitals/:id` is reachable by a platform admin
 * holding `hospital:update:any` and by a hospital admin holding
 * `hospital:update:own`. The guard admits the caller; the service then decides
 * what each of them is actually allowed to change.
 *
 * The authorisation test suite enumerates every route and fails the build if
 * one carries neither this nor `@Public()`, so a new endpoint cannot ship
 * without someone deciding who may call it.
 */
export const RequirePermission = (...permissions: [Permission, ...Permission[]]) =>
  SetMetadata(REQUIRED_PERMISSION_KEY, permissions);

/** Injects the authenticated actor. */
export const CurrentActor = createParamDecorator((_data: unknown, ctx: ExecutionContext): Actor => {
  const request = ctx.switchToHttp().getRequest<{ actor?: Actor }>();

  if (!request.actor) {
    // Reaching this means the guard did not run — a wiring error, not a
    // client error, so it must be loud.
    throw new Error('CurrentActor used on a route with no authentication guard');
  }

  return request.actor;
});

/** Injects request metadata for audit rows. */
export const CurrentMeta = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): RequestMeta => {
    const request = ctx.switchToHttp().getRequest<{ meta?: RequestMeta }>();

    return request.meta ?? { requestId: 'unknown', ipAddress: null, userAgent: null, route: null };
  },
);

/** Injects the signed-in patient, on a portal route. */
export const CurrentPatient = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): PatientActor => {
    const request = ctx.switchToHttp().getRequest<{ patientActor?: PatientActor }>();

    if (!request.patientActor) {
      throw new Error('CurrentPatient used on a route that is not a portal route');
    }

    return request.patientActor;
  },
);
