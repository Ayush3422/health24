import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AbdmMode } from './abha-verification.port';

/**
 * How this deployment reaches ABDM, resolved once (sp8-plan.md, T9).
 *
 * Three modes, and the difference between them matters enough to be a type
 * rather than a string read in five places:
 *
 * - `off`      — every ABDM operation is refused, with a message saying so.
 * - `mock`     — an in-process stand-in. No network, no credential, and
 *                refused in production by the configuration schema.
 * - `gateway`  — the wire adapter, pointed at `ABDM_GATEWAY_URL`. In the test
 *                suite that URL is the mock gateway server, which is how the
 *                transport gets tested without a sandbox account (Z1).
 */

export type { AbdmMode };

export interface GatewaySettings {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  /** This facility's id in the Health Facility Registry. */
  hipId: string;
  /** The consent manager this deployment is registered with. */
  cmId: string;
  callbackSecret: string | null;
  callTimeoutMs: number;
  callbackSkewMs: number;
}

@Injectable()
export class AbdmConfig {
  readonly mode: AbdmMode;
  private readonly settings: GatewaySettings | null;

  constructor(config: ConfigService) {
    const configured = config.get<AbdmMode | undefined>('ABDM_MODE');
    const production = config.get<string>('NODE_ENV') === 'production';

    // Unset means the mock outside production and nothing at all in it: a
    // deployment must never silently believe it has a gateway.
    this.mode = configured ?? (production ? 'off' : 'mock');

    this.settings =
      this.mode === 'gateway'
        ? {
            // The schema has already refused to start if any of these is
            // missing, which is why they are read without a fallback.
            baseUrl: config.getOrThrow<string>('ABDM_GATEWAY_URL').replace(/\/+$/, ''),
            clientId: config.getOrThrow<string>('ABDM_CLIENT_ID'),
            clientSecret: config.getOrThrow<string>('ABDM_CLIENT_SECRET'),
            hipId: config.getOrThrow<string>('ABDM_HIP_ID'),
            cmId: config.getOrThrow<string>('ABDM_CM_ID'),
            callbackSecret: config.get<string>('ABDM_CALLBACK_SECRET') ?? null,
            callTimeoutMs: config.get<number>('ABDM_CALL_TIMEOUT_MS') ?? 30_000,
            callbackSkewMs: (config.get<number>('ABDM_CALLBACK_SKEW_SECONDS') ?? 300) * 1_000,
          }
        : null;
  }

  /** The gateway settings, or a refusal naming the setting to change. */
  get gateway(): GatewaySettings {
    if (!this.settings) {
      throw new Error(`ABDM is not configured to reach a gateway (ABDM_MODE=${this.mode})`);
    }

    return this.settings;
  }
}
