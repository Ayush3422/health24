import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import {
  linkPatientSchema,
  lookupPatientSchema,
  registerPatientSchema,
  resolveMergeCandidateSchema,
  revertMergeSchema,
  searchPatientsSchema,
  updatePatientSchema,
  type LinkPatientInput,
  type LookupPatientInput,
  type PatientSummary,
  type RegisterPatientInput,
  type ResolveMergeCandidateInput,
  type RevertMergeInput,
  type SearchPatientsInput,
  type UpdatePatientInput,
} from '@health24/shared';
import { CurrentActor, CurrentMeta, RequirePermission } from '../../common/decorators';
import { zodBody } from '../../common/zod-validation.pipe';
import type { Actor, RequestMeta } from '../../common/actor';
import { deriveBirthYear } from './name-matching';
import { AuditService } from '../audit/audit.service';
import { MatchingService } from './matching.service';
import { MergeService } from './merge.service';
import { PatientsService } from './patients.service';

@Controller('patients')
export class PatientsController {
  constructor(
    private readonly patients: PatientsService,
    private readonly matching: MatchingService,
    private readonly merges: MergeService,
    private readonly audit: AuditService,
  ) {}

  @Post()
  @RequirePermission('patient:create')
  async register(
    @CurrentActor() actor: Actor,
    @Body(zodBody(registerPatientSchema)) body: RegisterPatientInput,
    @CurrentMeta() meta: RequestMeta,
  ) {
    return this.patients.register(actor, body, meta);
  }

  @Get()
  @RequirePermission('patient:search')
  async search(
    @CurrentActor() actor: Actor,
    @Query(zodBody(searchPatientsSchema)) query: SearchPatientsInput,
    @CurrentMeta() meta: RequestMeta,
  ) {
    return this.patients.search(actor, query, meta);
  }

  /**
   * Looks for a person across every hospital before creating a duplicate.
   *
   * Returns masked identifiers and scores only — never clinical data, and
   * never an unmasked name. A receptionist learns that a possible match
   * exists without learning who another hospital's patients are.
   */
  @Post('lookup')
  @RequirePermission('patient:lookup_global')
  async lookup(
    @CurrentActor() actor: Actor,
    @Body(zodBody(lookupPatientSchema)) body: LookupPatientInput,
    @CurrentMeta() meta: RequestMeta,
  ) {
    const candidates = await this.matching.findCandidates({
      ...body,
      birthYear: deriveBirthYear(body.dateOfBirth, null),
    });

    // This searches every hospital on the platform, so it is exactly the kind
    // of access a patient is entitled to ask about. It was reaching the
    // database without leaving a trace until lint flagged the unused `meta`
    // parameter, which is the sort of omission that would never show up in a
    // functional test.
    await this.audit.recordForActor(actor, {
      resourceType: 'patient_global_lookup',
      action: 'search',
      meta,
    });

    return {
      candidates: candidates.map(({ autoLinkable: _autoLinkable, ...rest }) => rest),
    };
  }

  /** Routes declaring literal paths must precede `:id`. */
  @Get('merge-queue')
  @RequirePermission('merge:read')
  async mergeQueue(@CurrentActor() actor: Actor, @CurrentMeta() meta: RequestMeta) {
    return this.merges.listQueue(actor, meta);
  }

  @Post('merge-queue/:id/resolve')
  @RequirePermission('merge:resolve')
  async resolveMerge(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(resolveMergeCandidateSchema)) body: ResolveMergeCandidateInput,
    @CurrentMeta() meta: RequestMeta,
  ) {
    return this.merges.resolve(actor, id, body.decision, body.reason, body.keepPatientId, meta);
  }

  /** Undoing a merge that turned out to be wrong. */
  @Post('merges/:id/revert')
  @RequirePermission('merge:resolve')
  async revertMerge(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(revertMergeSchema)) body: RevertMergeInput,
    @CurrentMeta() meta: RequestMeta,
  ) {
    return this.merges.revert(actor, id, body.reason, meta);
  }

  @Get(':id')
  @RequirePermission('patient:read')
  async findById(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<PatientSummary> {
    return this.patients.findById(actor, id, meta);
  }

  @Patch(':id')
  @RequirePermission('patient:update')
  async update(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(updatePatientSchema)) body: UpdatePatientInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<PatientSummary> {
    return this.patients.update(actor, id, body, meta);
  }

  /**
   * Attaches an existing person to this hospital after a human confirms the
   * match. The identifying details are re-verified server-side.
   */
  @Post(':id/link')
  @RequirePermission('patient:create')
  async link(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(linkPatientSchema)) body: LinkPatientInput,
    @CurrentMeta() meta: RequestMeta,
  ) {
    return this.patients.linkByConfirmation(actor, id, body, meta);
  }
}
