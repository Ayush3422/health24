import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { Public } from '../../../common/decorators';
import { DiscoveryService } from '../care-contexts/discovery.service';
import { LinkingService } from '../care-contexts/linking.service';
import { AbdmConsentService } from '../consent/abdm-consent.service';
import { DataRequestService } from '../transfer/data-request.service';
import { TransferQueue } from '../transfer/transfer-queue';
import { AbdmConfig } from '../abdm.config';
import { INBOUND_REFUSED, refuseInboundRequest } from './callback-auth';
import { GatewayClient } from './gateway.client';
import { isInboundOperation } from './operations';

/**
 * What the national network asks **us** (sp8-plan.md, T11, T12).
 *
 * A patient opens their own health app, looks for the hospitals that hold
 * something for them, and the network turns that into a question addressed to
 * this system. So unlike the callback endpoint, there is no call of ours being
 * answered here — see `callback-auth.ts` for what that costs and what closes
 * the gap instead.
 *
 * Every operation answers the same way: 202 now, and the real answer sent
 * back to the gateway as its own one-way message. Doing the work inside the
 * request would hold the gateway open while a database is queried and an SMS
 * is sent, which is not how any of this is specified to behave.
 */
@Controller('abdm/inbound')
export class GatewayInboundController {
  private readonly logger = new Logger(GatewayInboundController.name);

  constructor(
    private readonly config: AbdmConfig,
    private readonly gateway: GatewayClient,
    private readonly discovery: DiscoveryService,
    private readonly linking: LinkingService,
    private readonly consent: AbdmConsentService,
    private readonly dataRequests: DataRequestService,
    private readonly transfers: TransferQueue,
  ) {}

  @Public()
  @Post(':operation')
  @HttpCode(HttpStatus.ACCEPTED)
  async receive(
    @Param('operation') operation: string,
    @Body() body: InboundBody,
    @Headers('x-abdm-callback-secret') secret?: string,
    @Headers('x-hip-id') hipId?: string,
  ): Promise<{ accepted: true }> {
    const settings = this.config.mode === 'gateway' ? this.config.gateway : null;

    const refusal = refuseInboundRequest(body ?? {}, secret, {
      expectedSecret: settings?.callbackSecret ?? null,
      maxSkewMs: settings?.callbackSkewMs ?? 300_000,
    });

    if (refusal) {
      this.logger.warn(`Refused an inbound ABDM request for ${operation}: ${refusal}`);
      throw new UnauthorizedException(INBOUND_REFUSED);
    }

    if (!isInboundOperation(operation)) {
      throw new NotFoundException(`This system does not answer ${operation}`);
    }

    if (!hipId) {
      // Which facility is being asked about is not optional: this platform
      // hosts many, and answering for the wrong one would be worse than
      // answering for none.
      throw new UnauthorizedException(INBOUND_REFUSED);
    }

    // A consent notification is the one operation that is written before the
    // gateway is answered (sp8-plan.md, T17). Everything else here is a
    // question whose answer the gateway is waiting on and which must not take
    // a queue's round trip; a consent is a fact to keep, and if it cannot be
    // kept the right response is to fail loudly so the consent manager sends
    // it again. Their retry is the durability; a second one of ours would be
    // a failure mode rather than a remedy.
    // Two operations are settled before the gateway is answered: a consent,
    // which is a fact to keep (T17), and a data request, whose acceptance is
    // the promise that a transfer is coming. Everything else is a question
    // the gateway is waiting on.
    if (operation === 'consent.notify' || operation === 'health-information.request') {
      await this.answer(operation, hipId, body);
      return { accepted: true };
    }

    // Everything else is answered asynchronously, deliberately.
    void this.answer(operation, hipId, body).catch((error: unknown) => {
      this.logger.error(
        `Could not answer ${operation}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });

    return { accepted: true };
  }

  private async answer(operation: string, hipId: string, body: InboundBody): Promise<void> {
    const correlation = { resp: { requestId: body.requestId } };

    if (operation === 'care-context.discover') {
      const outcome = await this.discovery.discover({
        hipId,
        abhaAddress: body.patient?.id ?? null,
        name: body.patient?.name ?? null,
        gender: body.patient?.gender ?? null,
        yearOfBirth: body.patient?.yearOfBirth ?? null,
      });

      if (typeof outcome === 'string') {
        // One answer for every refusal. "Not found", "the year of birth
        // disagrees" and "we do not know that facility" are three different
        // sentences, and each of them would tell the asker something.
        this.logger.log(`Discovery for ${hipId} found nothing (${outcome})`);

        await this.gateway.notify(
          'care-context.on-discover',
          {
            ...correlation,
            transactionId: body.transactionId,
            error: { code: 1000, message: 'No patient found' },
          },
          { hipId },
        );

        return;
      }

      await this.gateway.notify(
        'care-context.on-discover',
        { ...correlation, transactionId: body.transactionId, patient: outcome },
        { hipId },
      );

      return;
    }

    if (operation === 'care-context.link.inbound-init') {
      const started = await this.linking.beginPatientLink({
        hipId,
        patientReference: body.patient?.referenceNumber ?? '',
        encounterIds: (body.patient?.careContexts ?? []).map((context) => context.referenceNumber),
      });

      await this.gateway.notify(
        'care-context.link.on-init',
        {
          ...correlation,
          transactionId: body.transactionId,
          link: {
            referenceNumber: started.linkRequestId,
            authenticationType: 'DIRECT',
            meta: {
              communicationMedium: 'MOBILE',
              communicationHint: started.hint,
              communicationExpiry: started.expiresAt.toISOString(),
            },
          },
        },
        { hipId },
      );

      return;
    }

    if (operation === 'consent.notify') {
      const detail = body.notification?.consentDetail ?? {};

      await this.consent.notified({
        hipId,
        status: body.notification?.status ?? 'GRANTED',
        consentId: body.notification?.consentId ?? detail.consentId ?? '',
        requester: detail.hiu,
        careContextReferences: (detail.careContexts ?? []).map(
          (context) => context.careContextReference,
        ),
        hiTypes: detail.hiTypes,
        dateRange: detail.permission?.dateRange,
        dataEraseAt: detail.permission?.dataEraseAt,
      });

      // Sent after the write, so the acknowledgement means the consent is
      // kept rather than merely received.
      await this.gateway.notify('consent.on-notify', { ...correlation }, { hipId });

      return;
    }

    if (operation === 'health-information.request') {
      const requested = body.hiRequest ?? {};
      const key = requested.keyMaterial ?? {};

      const accepted = await this.dataRequests.accept({
        hipId,
        transactionId: body.transactionId ?? '',
        abdmConsentId: requested.consent?.id ?? '',
        dataPushUrl: requested.dataPushUrl ?? '',
        requesterPublicKey: key.dhPublicKey?.keyValue ?? '',
        requesterNonce: key.nonce ?? '',
      });

      await this.gateway.notify(
        'health-information.on-request',
        {
          ...correlation,
          hiRequest: { transactionId: body.transactionId, sessionStatus: 'ACKNOWLEDGED' },
        },
        { hipId },
      );

      // Only after the gateway has been told the request is accepted: a
      // transfer that finished before the acknowledgement would arrive at a
      // requester that has not been told to expect it.
      if (!accepted.alreadyKnown) await this.transfers.requested(accepted.dataRequestId);

      return;
    }

    if (operation === 'care-context.link.inbound-confirm') {
      const linked = await this.linking.completePatientLink({
        hipId,
        linkRequestId: body.confirmation?.linkRefNumber ?? '',
        code: body.confirmation?.token ?? '',
      });

      await this.gateway.notify(
        'care-context.link.on-confirm',
        { ...correlation, patient: linked },
        { hipId },
      );
    }
  }
}

interface InboundBody {
  requestId?: string;
  timestamp?: string;
  transactionId?: string;
  patient?: {
    id?: string;
    referenceNumber?: string;
    name?: string;
    gender?: string;
    yearOfBirth?: number;
    careContexts?: Array<{ referenceNumber: string }>;
  };
  confirmation?: { linkRefNumber?: string; token?: string };
  hiRequest?: {
    consent?: { id?: string };
    dataPushUrl?: string;
    keyMaterial?: { dhPublicKey?: { keyValue?: string }; nonce?: string };
  };
  notification?: {
    status?: 'GRANTED' | 'REVOKED' | 'EXPIRED';
    consentId?: string;
    consentDetail?: {
      consentId?: string;
      hiu?: { id?: string; name?: string };
      careContexts?: Array<{ patientReference?: string; careContextReference: string }>;
      hiTypes?: string[];
      permission?: { dateRange?: { from?: string; to?: string }; dataEraseAt?: string };
    };
  };
}
