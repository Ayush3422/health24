import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  correctNoteSchema,
  writeNoteSchema,
  type CorrectNoteInput,
  type NoteSummary,
  type WriteNoteInput,
} from '@health24/shared';
import { CurrentActor, CurrentMeta, RequirePermission } from '../../common/decorators';
import { zodBody } from '../../common/zod-validation.pipe';
import type { Actor, RequestMeta } from '../../common/actor';
import { NotesService } from './notes.service';

@Controller()
export class NotesController {
  constructor(private readonly notes: NotesService) {}

  @Post('notes')
  @RequirePermission('clinical:write', 'clinical:transcribe')
  async write(
    @CurrentActor() actor: Actor,
    @Body(zodBody(writeNoteSchema)) body: WriteNoteInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<NoteSummary> {
    return this.notes.write(actor, body, meta);
  }

  /** An amendment: a new version of the note; the original stays in its history. */
  @Post('notes/:id/correct')
  @RequirePermission('clinical:write', 'clinical:transcribe')
  async correct(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(correctNoteSchema)) body: CorrectNoteInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<NoteSummary> {
    return this.notes.correct(actor, id, body, meta);
  }

  @Get('encounters/:id/notes')
  @RequirePermission('clinical:read')
  async forEncounter(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<NoteSummary[]> {
    return this.notes.forEncounter(actor, id, meta);
  }
}
