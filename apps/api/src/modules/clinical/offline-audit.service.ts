import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  OFFLINE_CACHE_MAX_AGE_MS,
  describeOfflineRead,
  hasPermission,
  type OfflineRead,
  type OfflineViewsInput,
  type OfflineViewsResult,
} from '@health24/shared';
import { DatabaseService } from '../../db/database.service';
import { requireHospital, type Actor, type RequestMeta } from '../../common/actor';
import { AuditService } from '../audit/audit.service';

/** Workstation clocks drift; a view a minute or two "in the future" is still a view. */
const CLOCK_SKEW_MS = 2 * 60 * 1000;

/**
 * Views made while offline, uploaded when the connection returns
 * (sp3-plan.md, decision S1).
 *
 * The client can only add to the audit trail, never shape it: each view must
 * name a read the offline cache could have held, of a patient or encounter
 * this hospital can see, at a time the cache could have served it. The time
 * the device reports is kept alongside — not instead of — the server's own
 * time of receipt.
 */
@Injectable()
export class OfflineAuditService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async record(
    actor: Actor,
    input: OfflineViewsInput,
    meta: RequestMeta,
  ): Promise<OfflineViewsResult> {
    const hospitalId = requireHospital(actor);
    const now = Date.now();
    const readsClinical = hasPermission(actor.role, 'clinical:read');

    const candidates = input.views.flatMap((view) => {
      const read = describeOfflineRead(view.path);
      const viewedAt = Date.parse(view.viewedAt);

      if (!read) return [];
      if (read.clinical && !readsClinical) return [];
      if (viewedAt > now + CLOCK_SKEW_MS) return [];
      if (viewedAt < now - OFFLINE_CACHE_MAX_AGE_MS - CLOCK_SKEW_MS) return [];

      return [{ path: view.path, viewedAt, read }];
    });

    const patientIds = [
      ...new Set(candidates.flatMap(({ read }) => (read.patientId ? [read.patientId] : []))),
    ];
    const encounterIds = [
      ...new Set(
        candidates.flatMap(({ read }) =>
          read.resourceType === 'encounter' && read.resourceId ? [read.resourceId] : [],
        ),
      ),
    ];

    const { linked, encounterPatients } = await this.db.asTenant(hospitalId, async (tx) => {
      const uuids = (ids: string[]) =>
        sql.join(
          ids.map((id) => sql`${id}::uuid`),
          sql`, `,
        );

      const links =
        patientIds.length === 0
          ? []
          : await tx.execute<{ patient_id: string }>(sql`
              SELECT "patient_id" FROM "patient_hospital_link"
               WHERE "hospital_id" = ${hospitalId}::uuid AND "patient_id" IN (${uuids(patientIds)})
            `);

      // Row-level security: only encounters this hospital could have read.
      const encounters =
        encounterIds.length === 0
          ? []
          : await tx.execute<{ id: string; patient_id: string }>(sql`
              SELECT "id", "patient_id" FROM "encounter" WHERE "id" IN (${uuids(encounterIds)})
            `);

      return {
        linked: new Set([...links].map((row) => row.patient_id)),
        encounterPatients: new Map([...encounters].map((row) => [row.id, row.patient_id])),
      };
    });

    let recorded = 0;

    for (const { path, viewedAt, read } of candidates) {
      const patientId = this.patientFor(read, linked, encounterPatients);
      if (patientId === undefined) continue;

      await this.audit.recordForActor(actor, {
        resourceType: read.resourceType,
        resourceId: read.resourceId,
        patientId,
        action: read.action,
        offlineViewedAt: new Date(viewedAt),
        meta: { ...meta, route: path },
      });

      recorded += 1;
    }

    return { recorded, rejected: input.views.length - recorded };
  }

  /** The patient a view touched; null when it touched none; undefined when it cannot be accepted. */
  private patientFor(
    read: OfflineRead,
    linked: Set<string>,
    encounterPatients: Map<string, string>,
  ): string | null | undefined {
    if (read.patientId) return linked.has(read.patientId) ? read.patientId : undefined;

    if (read.resourceType === 'encounter' && read.resourceId) {
      return encounterPatients.get(read.resourceId);
    }

    return null;
  }
}
