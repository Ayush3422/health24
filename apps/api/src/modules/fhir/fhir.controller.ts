import { Controller, Get, Param, Query } from '@nestjs/common';
import type { Actor, RequestMeta } from '../../common/actor';
import { CurrentActor, CurrentMeta, Public, RequirePermission } from '../../common/decorators';
import { capabilityStatement } from './capability-statement';
import { FhirService } from './fhir.service';

/**
 * `/fhir/R4` — the seam other systems arrive through
 * (`planning.md` §10, sp8-plan.md, T26–T29).
 *
 * Read-only, and every route carries the same permission the equivalent
 * `/api/v1` route carries. That is the whole of the authorisation story: a
 * FHIR client is a member of staff with a token, seeing what that member of
 * staff sees, through a different representation. The route sweep in
 * `authorization.e2e-spec.ts` covers these exactly as it covers the rest, so
 * a new resource here cannot ship without somebody deciding who may read it.
 *
 * The clinical resources are one permission — `clinical:read` — because that
 * is the permission that governs reading a diagnosis or a prescription
 * anywhere else in this system, and a second answer to the same question is
 * how the two come apart.
 */
@Controller('fhir/R4')
export class FhirController {
  constructor(private readonly fhir: FhirService) {}

  /**
   * The conformance statement, which is public.
   *
   * It names capabilities, not patients: a client has to be able to read it
   * before it has decided whether to authenticate, and there is nothing in it
   * that is not already in this repository.
   */
  @Public()
  @Get('metadata')
  metadata(): Record<string, unknown> {
    return capabilityStatement(new Date());
  }

  @Get('Patient/:id')
  @RequirePermission('patient:read')
  async readPatient(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @CurrentMeta() meta: RequestMeta,
  ) {
    return this.fhir.read(actor, 'Patient', id, meta);
  }

  @Get('Patient')
  @RequirePermission('patient:search')
  async searchPatients(
    @CurrentActor() actor: Actor,
    @Query() query: Record<string, string | undefined>,
    @CurrentMeta() meta: RequestMeta,
  ) {
    return this.fhir.search(actor, 'Patient', query, meta);
  }

  @Get('CodeSystem/:id')
  @RequirePermission('terminology:read')
  async readCodeSystem(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @CurrentMeta() meta: RequestMeta,
  ) {
    return this.fhir.readTerminology(actor, 'CodeSystem', id, meta);
  }

  @Get('CodeSystem')
  @RequirePermission('terminology:read')
  async searchCodeSystems(
    @CurrentActor() actor: Actor,
    @Query() query: Record<string, string | undefined>,
    @CurrentMeta() meta: RequestMeta,
  ) {
    return this.fhir.searchTerminology(actor, 'CodeSystem', query, meta);
  }

  /**
   * `ConceptMap/{id}` and `ConceptMap/$translate`, on one route.
   *
   * Not a matter of taste. Express 4's path matcher does not escape `$` when
   * it builds its regular expression, so a route declared as
   * `ConceptMap/$translate` compiles to a pattern with an end-of-input anchor
   * in the middle of it and matches nothing — silently, with a 404 that looks
   * like a missing resource. The operation therefore arrives as an id, and is
   * told apart here. Any future `$operation` goes the same way.
   */
  @Get('ConceptMap/:id')
  @RequirePermission('terminology:read')
  async readConceptMap(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Query() query: { system?: string; code?: string; target?: string },
    @CurrentMeta() meta: RequestMeta,
  ) {
    if (id === '$translate') return this.fhir.translate(actor, query, meta);

    return this.fhir.readTerminology(actor, 'ConceptMap', id, meta);
  }

  @Get('ConceptMap')
  @RequirePermission('terminology:read')
  async searchConceptMaps(
    @CurrentActor() actor: Actor,
    @Query() query: Record<string, string | undefined>,
    @CurrentMeta() meta: RequestMeta,
  ) {
    return this.fhir.searchTerminology(actor, 'ConceptMap', query, meta);
  }

  /**
   * The clinical resources, behind one route each for read and search.
   *
   * Declared last, so the named routes above win: Nest matches in
   * declaration order, and `Patient` must not fall through to here. Which
   * types are actually served is decided by the capability statement, not by
   * the route — anything else is refused with an `OperationOutcome` naming
   * `/fhir/R4/metadata`, rather than a 404 that leaves a client guessing
   * whether it asked wrongly or the patient does not exist.
   */
  @Get(':type/:id')
  @RequirePermission('clinical:read')
  async readClinical(
    @CurrentActor() actor: Actor,
    @Param('type') type: string,
    @Param('id') id: string,
    @CurrentMeta() meta: RequestMeta,
  ) {
    return this.fhir.read(actor, type, id, meta);
  }

  @Get(':type')
  @RequirePermission('clinical:read')
  async searchClinical(
    @CurrentActor() actor: Actor,
    @Param('type') type: string,
    @Query() query: Record<string, string | undefined>,
    @CurrentMeta() meta: RequestMeta,
  ) {
    return this.fhir.search(actor, type, query, meta);
  }
}
