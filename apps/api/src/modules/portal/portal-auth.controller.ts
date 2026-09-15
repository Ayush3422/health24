import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  OTP_TTL_SECONDS,
  portalRefreshSchema,
  requestOtpSchema,
  startPortalSessionSchema,
  switchPortalPatientSchema,
  verifyOtpSchema,
  type OtpRequested,
  type OtpVerified,
  type PortalMe,
  type PortalRefreshInput,
  type PortalSessionIssued,
  type PortalSessionSummary,
  type RequestOtpInput,
  type StartPortalSessionInput,
  type SwitchPortalPatientInput,
  type VerifyOtpInput,
} from '@health24/shared';
import type { PatientActor, RequestMeta } from '../../common/actor';
import { CurrentMeta, CurrentPatient, PortalRoute, Public } from '../../common/decorators';
import { maskPhone } from '../../common/phone';
import { zodBody } from '../../common/zod-validation.pipe';
import { AuditService } from '../audit/audit.service';
import { OtpService } from './otp.service';
import { PortalSessionService } from './portal-session.service';

const originOf = (meta: RequestMeta) => ({ ipAddress: meta.ipAddress, userAgent: meta.userAgent });

/** Patient portal sign-in (SP5 Phase 1): phone, one-time code, then the patient to act for. */
@Controller('portal/auth')
export class PortalAuthController {
  constructor(
    private readonly otp: OtpService,
    private readonly sessions: PortalSessionService,
    private readonly audit: AuditService,
  ) {}

  @Public()
  @Post('otp')
  @HttpCode(202)
  // Generous per address: patients on mobile networks share addresses. The
  // per-number limit in OtpService is the real control.
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async requestOtp(
    @Body(zodBody(requestOtpSchema)) body: RequestOtpInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<OtpRequested> {
    await this.otp.request(body.phone, meta.ipAddress);
    return { sent: true, expiresInSeconds: OTP_TTL_SECONDS };
  }

  @Public()
  @Post('verify')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async verify(@Body(zodBody(verifyOtpSchema)) body: VerifyOtpInput): Promise<OtpVerified> {
    const accountId = await this.otp.verify(body.phone, body.code);

    return {
      selectionToken: await this.sessions.signSelection(accountId),
      patients: await this.sessions.patientOptions(accountId),
    };
  }

  @Public()
  @Post('session')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async start(
    @Body(zodBody(startPortalSessionSchema)) body: StartPortalSessionInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<PortalSessionIssued> {
    const accountId = await this.sessions.verifySelection(body.selectionToken);
    const { sessionId, ...issued } = await this.sessions.issue(
      accountId,
      body.patientId,
      originOf(meta),
    );

    await this.audit.record({
      actorId: accountId,
      actorType: 'patient',
      actorLabel: 'patient portal sign-in',
      hospitalId: null,
      patientId: issued.patient.id,
      resourceType: 'portal_session',
      resourceId: sessionId,
      action: 'create',
      meta,
    });

    return issued;
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async refresh(
    @Body(zodBody(portalRefreshSchema)) body: PortalRefreshInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<PortalSessionIssued> {
    return this.sessions.rotate(body.refreshToken, originOf(meta));
  }

  @PortalRoute()
  @Get('me')
  async me(@CurrentPatient() patient: PatientActor): Promise<PortalMe> {
    const patients = await this.sessions.patientOptions(patient.accountId);

    return {
      accountId: patient.accountId,
      phone: maskPhone(patient.phone),
      patient: patients.find((option) => option.id === patient.patientId)!,
      patients,
    };
  }

  /** Acts for another patient on the same phone: a new session, and this one ended. */
  @PortalRoute()
  @Post('switch')
  @HttpCode(200)
  async switchPatient(
    @CurrentPatient() patient: PatientActor,
    @Body(zodBody(switchPortalPatientSchema)) body: SwitchPortalPatientInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<PortalSessionIssued> {
    const { sessionId, ...issued } = await this.sessions.issue(
      patient.accountId,
      body.patientId,
      originOf(meta),
    );
    await this.sessions.revoke(patient, patient.sessionId, 'switched patient');

    await this.audit.record({
      actorId: patient.accountId,
      actorType: 'patient',
      actorLabel: `patient portal ${maskPhone(patient.phone)}`,
      hospitalId: null,
      patientId: issued.patient.id,
      resourceType: 'portal_session',
      resourceId: sessionId,
      action: 'create',
      meta,
    });

    return issued;
  }

  @PortalRoute()
  @Get('sessions')
  async listSessions(@CurrentPatient() patient: PatientActor): Promise<PortalSessionSummary[]> {
    return this.sessions.list(patient);
  }

  @PortalRoute()
  @Delete('sessions/:id')
  @HttpCode(204)
  async revokeSession(
    @CurrentPatient() patient: PatientActor,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.sessions.revoke(patient, id, 'signed out from another device');
  }

  @PortalRoute()
  @Post('logout')
  @HttpCode(204)
  async logout(@CurrentPatient() patient: PatientActor): Promise<void> {
    await this.sessions.revoke(patient, patient.sessionId, 'signed out');
  }
}
