import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, desc, eq, isNull, or } from 'drizzle-orm';
import { DatabaseService } from '../../db/database.service';
import {
  patientHospitalLinks,
  patientMergeCandidates,
  patientMergeLog,
  patients,
} from '../../db/schema';
import { requireHospital, type Actor, type RequestMeta } from '../../common/actor';
import { AuditService } from '../audit/audit.service';
import { maskName, maskPhone } from './name-matching';

interface MergeSnapshot {
  survivor: { id: string; abhaNumber: string | null; abhaAddress: string | null };
  merged: {
    id: string;
    status: string;
    mergedIntoPatientId: string | null;
    abhaNumber: string | null;
    abhaAddress: string | null;
  };
  /** Link rows moved or dropped, with enough detail to put them back. */
  links: Array<{ hospitalId: string; mrn: string; action: 'moved' | 'kept_on_merged' }>;
}

@Injectable()
export class MergeService {
  private readonly logger = new Logger(MergeService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  /** Pairs awaiting review at the caller's hospital. */
  async listQueue(actor: Actor, meta: RequestMeta) {
    const hospitalId = requireHospital(actor);

    const rows = await this.db.asTenant(hospitalId, async (tx) =>
      tx
        .select()
        .from(patientMergeCandidates)
        .where(eq(patientMergeCandidates.status, 'pending'))
        .orderBy(desc(patientMergeCandidates.score)),
    );

    // Identities are fetched in system context because one side of a pairing
    // may be a patient this hospital has never seen. Only masked values are
    // returned — enough for a records clerk to recognise a duplicate, not
    // enough to learn about another hospital's patients.
    const detail = await this.db.asSystem(async (tx) => {
      const ids = [...new Set(rows.flatMap((row) => [row.patientAId, row.patientBId]))];

      if (ids.length === 0) return new Map<string, typeof patients.$inferSelect>();

      const found = await tx
        .select()
        .from(patients)
        .where(or(...ids.map((id) => eq(patients.id, id))));

      return new Map(found.map((patient) => [patient.id, patient]));
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'patient_merge_candidate',
      action: 'search',
      meta,
    });

    return rows.map((row) => ({
      id: row.id,
      score: row.score,
      method: row.method,
      matchedOn: row.matchedOn,
      detectedAt: row.detectedAt.toISOString(),
      patients: [row.patientAId, row.patientBId].map((id) => {
        const patient = detail.get(id);

        return {
          patientId: id,
          maskedName: patient ? maskName(patient.name) : '(unknown)',
          maskedPhone: patient ? maskPhone(patient.phone) : null,
          yearOfBirth: patient?.birthYear ?? null,
          gender: patient?.gender ?? null,
        };
      }),
    }));
  }

  /**
   * Resolves a queued pairing.
   *
   * A rejection is as valuable as a merge: it records that a human looked at
   * two similar records and decided they are different people, so the pair
   * does not resurface every time either is touched.
   */
  async resolve(
    actor: Actor,
    candidateId: string,
    decision: 'merge' | 'reject',
    reason: string,
    keepPatientId: string | undefined,
    meta: RequestMeta,
  ): Promise<{ status: string; survivingPatientId?: string; mergeLogId?: string }> {
    const hospitalId = requireHospital(actor);

    const candidate = await this.db.asTenant(hospitalId, async (tx) => {
      const [row] = await tx
        .select()
        .from(patientMergeCandidates)
        .where(eq(patientMergeCandidates.id, candidateId))
        .limit(1);

      return row;
    });

    if (!candidate) {
      throw new NotFoundException('Merge candidate not found');
    }

    if (candidate.status !== 'pending') {
      throw new BadRequestException('That pairing has already been resolved');
    }

    if (decision === 'reject') {
      await this.db.asTenant(hospitalId, async (tx) => {
        await tx
          .update(patientMergeCandidates)
          .set({
            status: 'rejected',
            resolvedByStaffId: actor.staffUserId,
            resolvedAt: new Date(),
            decisionReason: reason,
          })
          .where(eq(patientMergeCandidates.id, candidateId));
      });

      await this.audit.recordForActor(actor, {
        resourceType: 'patient_merge_candidate',
        resourceId: candidateId,
        action: 'update',
        meta,
      });

      return { status: 'rejected' };
    }

    if (!keepPatientId) {
      throw new BadRequestException('Specify which record should survive the merge');
    }

    if (keepPatientId !== candidate.patientAId && keepPatientId !== candidate.patientBId) {
      throw new BadRequestException('The surviving record must be one of the two in this pairing');
    }

    const mergedId =
      keepPatientId === candidate.patientAId ? candidate.patientBId : candidate.patientAId;

    const mergeLogId = await this.execute(
      actor,
      keepPatientId,
      mergedId,
      reason,
      hospitalId,
      candidateId,
      meta,
    );

    // The log id is returned because reversibility is only real if it can be
    // reached. Without this, the revert endpoint exists but nothing ever hands
    // a caller the id it needs.
    return { status: 'merged', survivingPatientId: keepPatientId, mergeLogId };
  }

  /**
   * Performs the merge.
   *
   * System context throughout, because a merge spans hospitals by definition —
   * that is the situation it exists to resolve. The losing record is kept as a
   * tombstone pointing at the survivor rather than deleted, so that references
   * held elsewhere still resolve and the operation stays reversible.
   */
  private async execute(
    actor: Actor,
    survivorId: string,
    mergedId: string,
    reason: string,
    hospitalId: string,
    candidateId: string,
    meta: RequestMeta,
  ): Promise<string> {
    const mergeLogId = await this.db.asSystem(async (tx) => {
      const [survivor] = await tx
        .select()
        .from(patients)
        .where(eq(patients.id, survivorId))
        .limit(1);
      const [merged] = await tx.select().from(patients).where(eq(patients.id, mergedId)).limit(1);

      if (!survivor || !merged) {
        throw new NotFoundException('One of the records no longer exists');
      }

      if (merged.status === 'merged' || survivor.status === 'merged') {
        throw new BadRequestException('One of these records has already been merged');
      }

      const survivorLinks = await tx
        .select()
        .from(patientHospitalLinks)
        .where(eq(patientHospitalLinks.patientId, survivorId));

      const mergedLinks = await tx
        .select()
        .from(patientHospitalLinks)
        .where(eq(patientHospitalLinks.patientId, mergedId));

      const survivorHospitals = new Set(survivorLinks.map((link) => link.hospitalId));
      const snapshotLinks: MergeSnapshot['links'] = [];

      for (const link of mergedLinks) {
        if (survivorHospitals.has(link.hospitalId)) {
          // The hospital already knows the survivor under its own MRN. Two
          // MRNs for one patient at one hospital is not representable, so the
          // survivor's is kept and the other is recorded in the snapshot —
          // which is what makes this reversible.
          snapshotLinks.push({
            hospitalId: link.hospitalId,
            mrn: link.mrn,
            action: 'kept_on_merged',
          });

          this.logger.warn(
            `Merge ${mergedId} -> ${survivorId}: hospital ${link.hospitalId} had both records; ` +
              `MRN ${link.mrn} retired in favour of the survivor's`,
          );
        } else {
          snapshotLinks.push({ hospitalId: link.hospitalId, mrn: link.mrn, action: 'moved' });

          await tx
            .update(patientHospitalLinks)
            .set({ patientId: survivorId })
            .where(
              and(
                eq(patientHospitalLinks.patientId, mergedId),
                eq(patientHospitalLinks.hospitalId, link.hospitalId),
              ),
            );
        }
      }

      // Any link not moved above still points at the tombstone; remove it so
      // the merged record has no live hospital associations.
      await tx.delete(patientHospitalLinks).where(eq(patientHospitalLinks.patientId, mergedId));

      const snapshot: MergeSnapshot = {
        survivor: {
          id: survivor.id,
          abhaNumber: survivor.abhaNumber,
          abhaAddress: survivor.abhaAddress,
        },
        merged: {
          id: merged.id,
          status: merged.status,
          mergedIntoPatientId: merged.mergedIntoPatientId,
          abhaNumber: merged.abhaNumber,
          abhaAddress: merged.abhaAddress,
        },
        links: snapshotLinks,
      };

      // ABHA numbers are unique across the table, so the tombstone must
      // release its identifiers before the survivor can adopt them.
      await tx
        .update(patients)
        .set({
          status: 'merged',
          mergedIntoPatientId: survivorId,
          abhaNumber: null,
          abhaAddress: null,
          updatedAt: new Date(),
        })
        .where(eq(patients.id, mergedId));

      if (!survivor.abhaNumber && merged.abhaNumber) {
        await tx
          .update(patients)
          .set({
            abhaNumber: merged.abhaNumber,
            abhaAddress: merged.abhaAddress,
            updatedAt: new Date(),
          })
          .where(eq(patients.id, survivorId));
      }

      const [logEntry] = await tx
        .insert(patientMergeLog)
        .values({
          survivingPatientId: survivorId,
          mergedPatientId: mergedId,
          performedByStaffId: actor.staffUserId,
          performedAtHospitalId: hospitalId,
          reason,
          snapshot,
        })
        .returning({ id: patientMergeLog.id });

      if (!logEntry) {
        throw new Error('Failed to record the merge');
      }

      await tx
        .update(patientMergeCandidates)
        .set({
          status: 'merged',
          resolvedByStaffId: actor.staffUserId,
          resolvedAt: new Date(),
          decisionReason: reason,
        })
        .where(eq(patientMergeCandidates.id, candidateId));

      return logEntry.id;
    });

    await this.audit.record({
      actorId: actor.staffUserId,
      actorType: 'staff',
      actorLabel: `${actor.name} <${actor.email}>`,
      hospitalId,
      patientId: survivorId,
      resourceType: 'patient_merge',
      resourceId: mergedId,
      action: 'update',
      meta,
    });

    this.logger.log(`Merged patient ${mergedId} into ${survivorId} by staff ${actor.staffUserId}`);

    return mergeLogId;
  }

  /**
   * Undoes a merge.
   *
   * Merges are performed by humans on incomplete information, and some of them
   * will be wrong. A system that cannot undo one leaves two people's histories
   * permanently fused, which is worse than the duplicate it was trying to fix.
   */
  async revert(
    actor: Actor,
    mergeLogId: string,
    reason: string,
    meta: RequestMeta,
  ): Promise<{ restoredPatientId: string }> {
    const hospitalId = requireHospital(actor);

    const restoredPatientId = await this.db.asSystem(async (tx) => {
      const [entry] = await tx
        .select()
        .from(patientMergeLog)
        .where(and(eq(patientMergeLog.id, mergeLogId), isNull(patientMergeLog.revertedAt)))
        .limit(1);

      if (!entry) {
        throw new NotFoundException('No reversible merge found with that id');
      }

      const snapshot = entry.snapshot as MergeSnapshot;

      await tx
        .update(patients)
        .set({
          status: 'active',
          mergedIntoPatientId: null,
          abhaNumber: snapshot.merged.abhaNumber,
          abhaAddress: snapshot.merged.abhaAddress,
          updatedAt: new Date(),
        })
        .where(eq(patients.id, entry.mergedPatientId));

      // The survivor gives back any identifier it adopted during the merge.
      if (!snapshot.survivor.abhaNumber && snapshot.merged.abhaNumber) {
        await tx
          .update(patients)
          .set({
            abhaNumber: snapshot.survivor.abhaNumber,
            abhaAddress: snapshot.survivor.abhaAddress,
            updatedAt: new Date(),
          })
          .where(eq(patients.id, entry.survivingPatientId));
      }

      for (const link of snapshot.links) {
        if (link.action === 'moved') {
          await tx
            .delete(patientHospitalLinks)
            .where(
              and(
                eq(patientHospitalLinks.patientId, entry.survivingPatientId),
                eq(patientHospitalLinks.hospitalId, link.hospitalId),
                eq(patientHospitalLinks.mrn, link.mrn),
              ),
            );
        }

        await tx
          .insert(patientHospitalLinks)
          .values({
            patientId: entry.mergedPatientId,
            hospitalId: link.hospitalId,
            mrn: link.mrn,
          })
          .onConflictDoNothing();
      }

      await tx
        .update(patientMergeLog)
        .set({ revertedAt: new Date(), revertedByStaffId: actor.staffUserId, revertReason: reason })
        .where(eq(patientMergeLog.id, mergeLogId));

      return entry.mergedPatientId;
    });

    await this.audit.record({
      actorId: actor.staffUserId,
      actorType: 'staff',
      actorLabel: `${actor.name} <${actor.email}>`,
      hospitalId,
      patientId: restoredPatientId,
      resourceType: 'patient_merge_revert',
      resourceId: mergeLogId,
      action: 'update',
      meta,
    });

    this.logger.warn(`Reverted merge ${mergeLogId}, restoring patient ${restoredPatientId}`);

    return { restoredPatientId };
  }
}
