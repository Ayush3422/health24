import { Injectable, Logger } from '@nestjs/common';
import type { AccessAction, ActorType } from '@health24/shared';
import { DatabaseService } from '../../db/database.service';
import { accessLog } from '../../db/schema';
import type { Actor, PatientActor, RequestMeta } from '../../common/actor';
import { maskPhone } from '../../common/phone';

export interface AuditEntry {
  actorId: string | null;
  actorType: ActorType;
  actorLabel?: string | null;
  hospitalId: string | null;
  patientId?: string | null;
  resourceType: string;
  resourceId?: string | null;
  action: AccessAction;
  outcome?: 'allowed' | 'denied';
  breakGlassReason?: string | null;
  /** The consent artefact a read of another hospital's record rested on. */
  consentArtefactId?: string | null;
  /** For a view made offline and uploaded later: when the device says it happened. */
  offlineViewedAt?: Date | null;
  meta?: Partial<RequestMeta>;
}

/**
 * Writes the audit trail.
 *
 * Two rules govern everything here:
 *
 *   1. Reads are recorded, not just writes. A record of who *changed* a
 *      patient's file is ordinary; a record of who *looked at* it is what the
 *      DPDP Act entitles the patient to ask for.
 *
 *   2. An audit write must never be the reason a request fails. If the log
 *      insert throws, the failure is reported to the operator and the request
 *      proceeds. The opposite choice — failing the request — would mean a
 *      full audit table takes the hospital offline mid-consultation.
 *
 * Rule 2 is a real trade-off, and it is the weaker half: a system where audit
 * failures are survivable is a system where audit gaps are possible. The
 * mitigation is alerting on the error log, not blocking the clinician.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly db: DatabaseService) {}

  async record(entry: AuditEntry): Promise<void> {
    try {
      // System context: the audit table's insert policy permits all inserts,
      // but the surrounding transaction still needs a context to run in, and
      // an audit row must be writable even when the action it records was
      // denied for lack of one.
      await this.db.asSystem(async (tx) => {
        await tx.insert(accessLog).values({
          actorId: entry.actorId,
          actorType: entry.actorType,
          actorLabel: entry.actorLabel ?? null,
          hospitalId: entry.hospitalId,
          patientId: entry.patientId ?? null,
          resourceType: entry.resourceType,
          resourceId: entry.resourceId ?? null,
          action: entry.action,
          outcome: entry.outcome ?? 'allowed',
          breakGlassReason: entry.breakGlassReason ?? null,
          consentArtefactId: entry.consentArtefactId ?? null,
          offlineViewedAt: entry.offlineViewedAt ?? null,
          requestId: entry.meta?.requestId ?? null,
          route: entry.meta?.route ?? null,
          ipAddress: entry.meta?.ipAddress ?? null,
          userAgent: entry.meta?.userAgent ?? null,
        });
      });
    } catch (error) {
      this.logger.error(
        `AUDIT WRITE FAILED action=${entry.action} resource=${entry.resourceType} ` +
          `actor=${entry.actorId ?? 'anonymous'} — investigate immediately`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  /** Convenience for the common case: an authenticated staff member acting. */
  async recordForActor(
    actor: Actor,
    entry: Omit<AuditEntry, 'actorId' | 'actorType' | 'actorLabel' | 'hospitalId'>,
  ): Promise<void> {
    await this.record({
      ...entry,
      actorId: actor.staffUserId,
      actorType: 'staff',
      actorLabel: `${actor.name} <${actor.email}>`,
      hospitalId: actor.hospitalId,
    });
  }

  /** An action by a patient in the portal (SP5): recorded against the account, with no hospital. */
  async recordForPatient(
    actor: PatientActor,
    entry: Omit<AuditEntry, 'actorId' | 'actorType' | 'actorLabel' | 'hospitalId'>,
  ): Promise<void> {
    await this.record({
      ...entry,
      patientId: entry.patientId ?? actor.patientId,
      actorId: actor.accountId,
      actorType: 'patient',
      actorLabel: `patient portal ${maskPhone(actor.phone)}`,
      hospitalId: null,
    });
  }
}
