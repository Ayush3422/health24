import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { requireHospital, type Actor, type RequestMeta } from '../../common/actor';
import { DatabaseService } from '../../db/database.service';
import { AuditService } from '../audit/audit.service';
import { readExportRecord } from '../exports/export-record';
import { buildRecordResources } from '../exports/record-fhir';
import { TerminologyService } from '../terminology/terminology.service';
import { FHIR_RESOURCES } from './capability-statement';

/**
 * The `/fhir/R4` read surface: a translation layer, and nothing more
 * (sp8-plan.md, T27, T28, DF10).
 *
 * Every resource here comes from the same mappings that build a patient's own
 * export and the bundles ABDM receives. There is no second model, no second
 * store, and no second idea of what a `Condition` is — which is the point:
 * two ways to produce the same resource is two ways for them to disagree.
 *
 * **It grants nothing.** Every read runs in the caller's own tenant context,
 * under the same row-level security as `/api/v1`, so a hospital sees its own
 * record and whatever a consent admits, and a FHIR client sees exactly what
 * the same credentials would see through the ordinary API. This surface adds
 * a representation, not an access path.
 *
 * **Every clinical search names a patient**, and is refused without one.
 * There is deliberately no way to ask this surface for all of anything: a
 * "give me every Condition" query is the sort of thing an integration writes
 * once and a breach report describes later.
 */

/** Where a resource's rows live, for resolving which patient one belongs to. */
const RESOURCE_TABLE: Record<string, string> = {
  Patient: 'patient',
  Encounter: 'encounter',
  Condition: 'condition',
  MedicationRequest: 'medication_request',
  Observation: 'observation',
  DocumentReference: 'document_reference',
};

const CLINICAL_TYPES = new Set(
  FHIR_RESOURCES.filter((resource) => resource.patientScoped).map((resource) => resource.type),
);

export const FHIR_TYPES = new Set(FHIR_RESOURCES.map((resource) => resource.type));

@Injectable()
export class FhirService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly terminology: TerminologyService,
  ) {}

  // --- Clinical resources ---------------------------------------------------

  async read(
    actor: Actor,
    type: string,
    id: string,
    meta: RequestMeta,
  ): Promise<Record<string, unknown>> {
    const hospitalId = requireHospital(actor);
    const patientId = await this.patientFor(hospitalId, type, id);

    const resource = (await this.resourcesFor(hospitalId, patientId)).find(
      (candidate) => candidate.resourceType === type && candidate.id === id,
    );

    if (!resource) throw this.notFound(type, id);

    await this.audit.recordForActor(actor, {
      resourceType: RESOURCE_TABLE[type] ?? type,
      resourceId: id,
      patientId,
      action: 'read',
      meta,
    });

    return resource;
  }

  async search(
    actor: Actor,
    type: string,
    query: Record<string, string | undefined>,
    meta: RequestMeta,
  ): Promise<Record<string, unknown>> {
    const hospitalId = requireHospital(actor);

    if (type === 'Patient') return this.searchPatients(actor, hospitalId, query, meta);

    if (!CLINICAL_TYPES.has(type)) throw this.unsupported(type);

    const patientId = this.reference(query.patient ?? query.subject);

    if (!patientId) {
      throw new BadRequestException(
        `A ${type} search must name a patient: ?patient=<id>. This surface answers nothing unscoped.`,
      );
    }

    const resources = (await this.resourcesFor(hospitalId, patientId)).filter(
      (resource) => resource.resourceType === type,
    );

    await this.audit.recordForActor(actor, {
      resourceType: RESOURCE_TABLE[type] ?? type,
      patientId,
      action: 'search',
      meta,
    });

    return this.searchset(resources);
  }

  // --- Terminology (T28) ----------------------------------------------------

  async readTerminology(
    actor: Actor,
    type: 'CodeSystem' | 'ConceptMap',
    id: string,
    meta: RequestMeta,
  ): Promise<Record<string, unknown>> {
    const found = (await this.terminologyResources(type, { _id: id }))[0];

    if (!found) throw this.notFound(type, id);

    await this.audit.recordForActor(actor, {
      resourceType: type === 'CodeSystem' ? 'code_system' : 'concept_map',
      resourceId: id,
      action: 'read',
      meta,
    });

    return found;
  }

  async searchTerminology(
    actor: Actor,
    type: 'CodeSystem' | 'ConceptMap',
    query: Record<string, string | undefined>,
    meta: RequestMeta,
  ): Promise<Record<string, unknown>> {
    const found = await this.terminologyResources(type, query);

    await this.audit.recordForActor(actor, {
      resourceType: type === 'CodeSystem' ? 'code_system' : 'concept_map',
      action: 'search',
      meta,
    });

    return this.searchset(found);
  }

  /**
   * `ConceptMap/$translate`, over the translation SP2 already does.
   *
   * The interesting part is what the answer carries beside the code: the
   * equivalence, the release it came from, and whether that release is
   * experimental. A translation presented as a bare code is a translation
   * whose provenance somebody will have to guess at, and this system has
   * refused to let anyone guess since SP2.
   */
  async translate(
    actor: Actor,
    query: { system?: string; code?: string; target?: string },
    meta: RequestMeta,
  ): Promise<Record<string, unknown>> {
    if (!query.system || !query.code) {
      throw new BadRequestException('$translate needs a system and a code');
    }

    const translated = await this.terminology.translate({
      system: query.system,
      code: query.code,
      target: query.target,
    } as Parameters<TerminologyService['translate']>[0]);

    await this.audit.recordForActor(actor, {
      resourceType: 'concept_map',
      action: 'search',
      meta,
    });

    const matches = translated.translations;

    return {
      resourceType: 'Parameters',
      parameter: [
        { name: 'result', valueBoolean: matches.length > 0 },
        ...matches.map((match) => ({
          name: 'match',
          part: [
            // FHIR's own word for how close the mapping is.
            { name: 'equivalence', valueCode: match.equivalence },
            {
              name: 'concept',
              valueCoding: {
                system: match.system,
                version: match.systemVersion,
                code: match.code,
                display: match.display,
              },
            },
            { name: 'source', valueUri: `ConceptMap/${match.conceptMapElementId}` },
            // Said out loud rather than left in the release metadata: an
            // experimental mapping must never be mistaken for a real one.
            ...(match.experimental
              ? [{ name: 'experimental', valueBoolean: true }]
              : []),
          ],
        })),
      ],
    };
  }

  // --- The parts everything above leans on -----------------------------------

  /**
   * Which patient a resource belongs to, or nothing.
   *
   * Run in the caller's tenant context, so a row the policies hide is a row
   * this cannot find — the 404 below is row-level security's answer, not a
   * check written here.
   */
  private async patientFor(hospitalId: string, type: string, id: string): Promise<string> {
    if (type === 'Patient') {
      const rows = await this.db.asTenant(hospitalId, async (tx) =>
        tx.execute<{ id: string }>(sql`SELECT "id" FROM "patient" WHERE "id" = ${id}::uuid`),
      );

      if (!rows[0]) throw this.notFound(type, id);
      return rows[0].id;
    }

    const table = RESOURCE_TABLE[type];
    if (!table) throw this.unsupported(type);

    const rows = await this.db.asTenant(hospitalId, async (tx) =>
      tx.execute<{ patient_id: string }>(
        sql`SELECT "patient_id" FROM ${sql.identifier(table)} WHERE "id" = ${id}::uuid`,
      ),
    );

    if (!rows[0]) throw this.notFound(type, id);
    return rows[0].patient_id;
  }

  /**
   * Every resource of a patient's record, as this system already maps them.
   *
   * Reading the whole record to answer for one resource is more work than the
   * answer needs, and it is deliberate for now: it keeps one code path and
   * one set of mappings. If this surface is ever used at volume, the thing to
   * change is here and nowhere else — which is written down rather than left
   * as a surprise (docs/fhir.md).
   */
  private async resourcesFor(
    hospitalId: string,
    patientId: string,
  ): Promise<Array<Record<string, unknown>>> {
    return this.db.asTenant(hospitalId, async (tx) => {
      const record = await readExportRecord(tx, patientId);
      return buildRecordResources(record);
    });
  }

  private async searchPatients(
    actor: Actor,
    hospitalId: string,
    query: Record<string, string | undefined>,
    meta: RequestMeta,
  ): Promise<Record<string, unknown>> {
    const identifier = query.identifier?.trim();
    const id = query._id?.trim();

    if (!identifier && !id) {
      throw new BadRequestException('A Patient search needs ?_id= or ?identifier=');
    }

    const rows = await this.db.asTenant(hospitalId, async (tx) =>
      tx.execute<{ id: string }>(sql`
        SELECT p."id"
          FROM "patient" p
          LEFT JOIN "patient_hospital_link" l
                 ON l."patient_id" = p."id" AND l."hospital_id" = ${hospitalId}::uuid
         WHERE (${id ?? null}::text IS NULL OR p."id"::text = ${id ?? null})
           AND (${identifier ?? null}::text IS NULL
                 OR p."abha_number" = ${identifier ?? null}
                 OR lower(p."abha_address") = lower(${identifier ?? null})
                 OR l."mrn" = ${identifier ?? null})
         LIMIT 20
      `),
    );

    const resources: Array<Record<string, unknown>> = [];

    for (const row of rows) {
      const patient = (await this.resourcesFor(hospitalId, row.id)).find(
        (resource) => resource.resourceType === 'Patient',
      );

      if (patient) resources.push(patient);
    }

    await this.audit.recordForActor(actor, {
      resourceType: 'patient',
      action: 'search',
      meta,
    });

    return this.searchset(resources);
  }

  /**
   * Code systems and concept maps as FHIR, without their concepts.
   *
   * A release holds tens of thousands of codes, and expanding them into one
   * resource would make a response nobody can use out of a question somebody
   * only asked to see what versions exist. `$translate` is how a code is
   * looked up, and `count` is how many there are.
   */
  private async terminologyResources(
    type: 'CodeSystem' | 'ConceptMap',
    query: Record<string, string | undefined>,
  ): Promise<Array<Record<string, unknown>>> {
    const id = query._id?.trim() ?? null;
    const url = query.url?.trim() ?? null;

    if (type === 'CodeSystem') {
      const rows = await this.db.asSystem(async (tx) =>
        tx.execute<{
          id: string;
          uri: string;
          name: string;
          version: string;
          publisher: string;
          status: string;
          experimental: boolean;
          concept_count: number;
        }>(sql`
          SELECT cs."id", cs."uri", cs."name", cs."version", cs."publisher",
                 cs."status"::text AS status, cs."experimental",
                 (SELECT count(*)::int FROM "concept" c WHERE c."code_system_id" = cs."id")
                   AS concept_count
            FROM "code_system" cs
           WHERE (${id}::text IS NULL OR cs."id"::text = ${id})
             AND (${url}::text IS NULL OR cs."uri" = ${url})
        ORDER BY cs."name", cs."version"
        `),
      );

      return rows.map((row) => ({
        resourceType: 'CodeSystem',
        id: row.id,
        url: row.uri,
        version: row.version,
        name: row.name,
        // Only an active release is `active`; a draft or a retired one says so.
        status: row.status === 'active' ? 'active' : row.status === 'retired' ? 'retired' : 'draft',
        experimental: row.experimental,
        publisher: row.publisher,
        content: 'not-present',
        count: Number(row.concept_count),
      }));
    }

    const rows = await this.db.asSystem(async (tx) =>
      tx.execute<{
        id: string;
        name: string;
        version: string;
        publisher: string;
        experimental: boolean;
        source_uri: string;
        target_uri: string;
        element_count: number;
      }>(sql`
        SELECT cm."id", cm."name", cm."version", cm."publisher", cm."experimental",
               src."uri" AS source_uri, tgt."uri" AS target_uri,
               (SELECT count(*)::int FROM "concept_map_element" e
                 WHERE e."concept_map_id" = cm."id" AND e."status" = 'approved')
                 AS element_count
          FROM "concept_map" cm
          JOIN "code_system" src ON src."id" = cm."source_system_id"
          JOIN "code_system" tgt ON tgt."id" = cm."target_system_id"
         WHERE (${id}::text IS NULL OR cm."id"::text = ${id})
           AND (${url}::text IS NULL OR cm."key" = ${url})
      ORDER BY cm."name", cm."version"
      `),
    );

    return rows.map((row) => ({
      resourceType: 'ConceptMap',
      id: row.id,
      version: row.version,
      name: row.name,
      status: 'active',
      experimental: row.experimental,
      publisher: row.publisher,
      sourceUri: row.source_uri,
      targetUri: row.target_uri,
      // The approved ones. A proposed mapping is not a mapping yet (SP2).
      extension: [
        {
          url: 'urn:health24:approved-element-count',
          valueInteger: Number(row.element_count),
        },
      ],
    }));
  }

  /**
   * The id out of `?patient=`, which FHIR clients write either way.
   *
   * `Patient/01a0…` and a bare id both arrive, and refusing one of them
   * would be refusing a client that is doing nothing wrong.
   */
  private reference(value: string | undefined): string | null {
    const trimmed = value?.trim();
    if (!trimmed) return null;

    return trimmed.startsWith('Patient/') ? trimmed.slice('Patient/'.length) : trimmed;
  }

  private searchset(resources: Array<Record<string, unknown>>): Record<string, unknown> {
    return {
      resourceType: 'Bundle',
      type: 'searchset',
      total: resources.length,
      entry: resources.map((resource) => ({
        fullUrl: `urn:uuid:${String(resource.id)}`,
        resource,
      })),
    };
  }

  /** FHIR's own way of saying no, so a client can read the refusal. */
  private notFound(type: string, id: string): NotFoundException {
    return new NotFoundException({
      resourceType: 'OperationOutcome',
      issue: [
        {
          severity: 'error',
          code: 'not-found',
          diagnostics: `No ${type} with id ${id} is visible to you`,
        },
      ],
    });
  }

  private unsupported(type: string): BadRequestException {
    return new BadRequestException({
      resourceType: 'OperationOutcome',
      issue: [
        {
          severity: 'error',
          code: 'not-supported',
          diagnostics: `This surface does not serve ${type}. See /fhir/R4/metadata.`,
        },
      ],
    });
  }
}
