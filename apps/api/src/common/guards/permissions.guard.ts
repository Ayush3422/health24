import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { hasPermission, type Permission } from '@health24/shared';
import { AuditService } from '../../modules/audit/audit.service';
import { IS_PUBLIC_KEY, REQUIRED_PERMISSION_KEY } from '../decorators';
import type { Actor, RequestMeta } from '../actor';

/**
 * Enforces the permission matrix from `@health24/shared`.
 *
 * Denials are audited. A refused attempt to open a patient record is at least
 * as interesting as a successful one — it is the signal that someone is
 * probing, or that someone's access was removed and they did not expect it.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const required = this.reflector.getAllAndOverride<Permission | undefined>(
      REQUIRED_PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );

    // A route with no declared permission is authenticated but unrestricted —
    // legitimate for things like "read my own profile". The authorisation test
    // suite asserts that no patient-touching route relies on this.
    if (!required) {
      return true;
    }

    const request = context.switchToHttp().getRequest<{ actor?: Actor; meta?: RequestMeta }>();
    const actor = request.actor;

    if (!actor) {
      throw new ForbiddenException('Not authenticated');
    }

    if (!hasPermission(actor.role, required)) {
      await this.audit.recordForActor(actor, {
        resourceType: 'authorization',
        resourceId: required,
        action: 'read',
        outcome: 'denied',
        meta: request.meta,
      });

      throw new ForbiddenException(`Your role (${actor.role}) cannot perform this action`);
    }

    return true;
  }
}
