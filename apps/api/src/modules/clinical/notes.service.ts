import { Injectable, NotFoundException } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import {
  NOTE_TEMPLATES,
  type CorrectNoteInput,
  type NoteSummary,
  type NoteTemplateKey,
  type WriteNoteInput,
} from '@health24/shared';
import { DatabaseService } from '../../db/database.service';
import type { DbTransaction } from '../../db/client';
import { clinicalNotes, encounters } from '../../db/schema';
import { requireHospital, type Actor, type RequestMeta } from '../../common/actor';
import { AuditService } from '../audit/audit.service';
import {
  blankToNull,
  coveringConsentId,
  requireWritableEncounter,
  resolveAttribution,
  toIso,
  type Attribution,
} from './clinical-access';
import { attributionForCorrection, loadForChange, retire } from './corrections.service';

type NoteSection = { key: string; label: string; text: string };

type NoteRow = {
  id: string;
  patient_id: string;
  encounter_id: string;
  hospital_id: string;
  hospital_name: string | null;
  template: string;
  title: string | null;
  body: string;
  sections: NoteSection[] | null;
  recorded_at: string | Date;
  attributed_clinician_id: string;
  clinician_name: string | null;
  entry_source: 'direct' | 'transcribed';
  recorded_by_staff_id: string;
  entered_by_name: string | null;
  supersedes_id: string | null;
};

const NOTE_SELECT = sql`
  SELECT n."id", n."patient_id", n."encounter_id", n."hospital_id", d."name" AS hospital_name,
         n."template", n."title", n."body", n."sections", n."recorded_at",
         n."attributed_clinician_id", cl."name" AS clinician_name, n."entry_source",
         n."recorded_by_staff_id", eb."name" AS entered_by_name, n."supersedes_id"
    FROM "clinical_note" n
    LEFT JOIN "hospital_directory" d ON d."id" = n."hospital_id"
    LEFT JOIN "staff_user" cl ON cl."id" = n."attributed_clinician_id"
    LEFT JOIN "staff_user" eb ON eb."id" = n."recorded_by_staff_id"
`;

/** The template's sections that were written, in the template's order. */
export function composeSections(
  template: NoteTemplateKey,
  written: Record<string, string>,
): NoteSection[] {
  return NOTE_TEMPLATES[template].sections.flatMap((section) => {
    const text = written[section.key]?.trim() ?? '';
    return text ? [{ key: section.key, label: section.label, text }] : [];
  });
}

/**
 * Clinical notes, written against a template.
 *
 * Each section is stored on its own and composed into the note's text, so the
 * note reads as prose and a later discharge summary can still take "Plan"
 * without parsing it. An amendment is a new version; the original remains in
 * the note's history.
 */
@Injectable()
export class NotesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async write(actor: Actor, input: WriteNoteInput, meta: RequestMeta): Promise<NoteSummary> {
    const hospitalId = requireHospital(actor);

    const row = await this.db.asTenant(hospitalId, async (tx) => {
      const encounter = await requireWritableEncounter(
        tx,
        hospitalId,
        input.encounterId,
        'A note is',
      );
      const attribution = await resolveAttribution(
        tx,
        actor,
        hospitalId,
        input.onBehalfOfClinicianId,
      );

      return this.insert(tx, {
        input,
        patientId: encounter.patientId,
        hospitalId,
        encounterId: input.encounterId,
        actor,
        attribution,
        supersedesId: null,
      });
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'clinical_note',
      resourceId: row.id,
      patientId: row.patient_id,
      action: 'create',
      meta,
    });

    return this.toSummary(row, hospitalId);
  }

  async correct(
    actor: Actor,
    noteId: string,
    input: CorrectNoteInput,
    meta: RequestMeta,
  ): Promise<NoteSummary> {
    const hospitalId = requireHospital(actor);

    const row = await this.db.asTenant(hospitalId, async (tx) => {
      const original = await loadForChange(tx, 'notes', noteId, actor, hospitalId);
      const attribution = await attributionForCorrection(tx, actor, hospitalId, original);

      await retire(tx, 'notes', noteId, actor, input.reason, 'superseded');

      return this.insert(tx, {
        input,
        patientId: original.patient_id,
        hospitalId,
        encounterId: original.encounter_id as string,
        actor,
        attribution,
        supersedesId: noteId,
      });
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'clinical_note',
      resourceId: noteId,
      patientId: row.patient_id,
      action: 'update',
      meta,
    });

    return this.toSummary(row, hospitalId);
  }

  async forEncounter(actor: Actor, encounterId: string, meta: RequestMeta): Promise<NoteSummary[]> {
    const hospitalId = requireHospital(actor);

    const { rows, patientId, consentArtefactId } = await this.db.asTenant(
      hospitalId,
      async (tx) => {
        const [encounter] = await tx
          .select({ patientId: encounters.patientId, hospitalId: encounters.hospitalId })
          .from(encounters)
          .where(eq(encounters.id, encounterId))
          .limit(1);

        if (!encounter) throw new NotFoundException('Encounter not found');

        const found = await tx.execute<NoteRow>(sql`
          ${NOTE_SELECT}
           WHERE n."encounter_id" = ${encounterId}::uuid AND n."version_status" = 'current'
        ORDER BY n."recorded_at" ASC
        `);

        return {
          rows: [...found],
          patientId: encounter.patientId,
          consentArtefactId:
            encounter.hospitalId !== hospitalId && found.length > 0
              ? await coveringConsentId(tx, encounter.patientId, 'notes')
              : null,
        };
      },
    );

    await this.audit.recordForActor(actor, {
      resourceType: 'clinical_note',
      resourceId: encounterId,
      patientId,
      action: 'read',
      consentArtefactId,
      meta,
    });

    return rows.map((row) => this.toSummary(row, hospitalId));
  }

  private async insert(
    tx: DbTransaction,
    args: {
      input: Pick<WriteNoteInput, 'template' | 'title' | 'sections'>;
      patientId: string;
      hospitalId: string;
      encounterId: string;
      actor: Actor;
      attribution: Attribution;
      supersedesId: string | null;
    },
  ): Promise<NoteRow> {
    const sections = composeSections(args.input.template, args.input.sections);
    const body = sections.map((section) => `${section.label}:\n${section.text}`).join('\n\n');

    const [created] = await tx
      .insert(clinicalNotes)
      .values({
        patientId: args.patientId,
        hospitalId: args.hospitalId,
        encounterId: args.encounterId,
        template: args.input.template,
        title: blankToNull(args.input.title),
        body,
        sections,
        recordedByStaffId: args.actor.staffUserId,
        attributedClinicianId: args.attribution.clinicianId,
        entrySource: args.attribution.entrySource,
        supersedesId: args.supersedesId,
      })
      .returning({ id: clinicalNotes.id });

    if (!created) throw new Error('Failed to write the note');

    const [row] = await tx.execute<NoteRow>(sql`
      ${NOTE_SELECT}
       WHERE n."id" = ${created.id}::uuid
    `);

    if (!row) throw new Error('Written note is not readable');

    return row;
  }

  private toSummary(row: NoteRow, hospitalId: string): NoteSummary {
    const template = NOTE_TEMPLATES[row.template as NoteTemplateKey];

    return {
      id: row.id,
      patientId: row.patient_id,
      encounterId: row.encounter_id,
      hospital: {
        id: row.hospital_id,
        name: row.hospital_name ?? 'Unknown hospital',
        isOwn: row.hospital_id === hospitalId,
      },
      template: row.template,
      templateLabel: template?.label ?? row.template,
      title: row.title,
      // A note written without sections still reads as one.
      sections: row.sections ?? [{ key: 'body', label: 'Note', text: row.body }],
      recordedAt: toIso(row.recorded_at),
      recordedBy: { id: row.attributed_clinician_id, name: row.clinician_name },
      entry: {
        source: row.entry_source,
        enteredBy: { id: row.recorded_by_staff_id, name: row.entered_by_name },
      },
      supersedesId: row.supersedes_id,
    };
  }
}
