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
  ) {}

  @Public()
  @Post(':operation')
  @HttpCode(HttpStatus.ACCEPTED)
  receive(
    @Param('operation') operation: string,
    @Body() body: InboundBody,
    @Headers('x-abdm-callback-secret') secret?: string,
    @Headers('x-hip-id') hipId?: string,
  ): { accepted: true } {
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

    // Answered asynchronously, deliberately. Nothing here is awaited.
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
}
