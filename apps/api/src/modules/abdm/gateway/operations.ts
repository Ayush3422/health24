/**
 * Everything this system asks the national gateway to do, or is asked by it
 * (sp8-plan.md, T5, DF4).
 *
 * Written as one list before most of it has an implementation, because the
 * value is in the list: it says what the ABDM surface of this system is, and
 * it is the place a later phase adds to rather than inventing a second way in.
 * Each operation carries whether it is built, so nothing here can be mistaken
 * for a claim (DF11).
 *
 * The types are this system's, not ABDM's. Translating at the edge of the
 * adapter is the whole point of having one: a change to the wire format is a
 * change to `gateway.client.ts` and the mock beside it, and to nothing else.
 */

export const GATEWAY_OPERATIONS = {
  /** Ask for a code to be sent to whatever the method names. */
  'abha.verify.init': { path: '/v0.5/users/auth/init', built: true, direction: 'call' },
  /** Answer that code. */
  'abha.verify.confirm': { path: '/v0.5/users/auth/confirm', built: true, direction: 'call' },

  /** The desk offers to link a patient's visits; the gateway sends the code. */
  'care-context.link.init': { path: '/v0.5/links/link/init', built: true, direction: 'call' },
  'care-context.link.confirm': {
    path: '/v0.5/links/link/confirm',
    built: true,
    direction: 'call',
  },

  /**
   * The gateway asking **us** — the patient is in their own health app,
   * looking for the hospitals that hold something for them. These arrive at
   * `/abdm/inbound/:operation` and have no path of their own here.
   */
  'care-context.discover': { path: null, built: true, direction: 'inbound' },
  'care-context.link.inbound-init': { path: null, built: true, direction: 'inbound' },
  'care-context.link.inbound-confirm': { path: null, built: true, direction: 'inbound' },

  /**
   * Our answers to those, sent one way. Nothing waits for a reply to a reply,
   * which is why they are `notify` rather than `call`.
   */
  'care-context.on-discover': {
    path: '/v0.5/care-contexts/on-discover',
    built: true,
    direction: 'notify',
  },
  'care-context.link.on-init': {
    path: '/v0.5/links/link/on-init',
    built: true,
    direction: 'notify',
  },
  'care-context.link.on-confirm': {
    path: '/v0.5/links/link/on-confirm',
    built: true,
    direction: 'notify',
  },

  /** The consent manager telling us a consent now exists, or no longer does. */
  'consent.notify': { path: null, built: true, direction: 'inbound' },
  'consent.on-notify': {
    path: '/v0.5/consents/hip/on-notify',
    built: true,
    direction: 'notify',
  },

  /** A request for data, our acknowledgement of it, and the outcome. */
  'health-information.request': { path: null, built: true, direction: 'inbound' },
  'health-information.on-request': {
    path: '/v0.5/health-information/hip/on-request',
    built: true,
    direction: 'notify',
  },
  'health-information.notify': {
    path: '/v0.5/health-information/notify',
    built: true,
    direction: 'notify',
  },
} as const;

export type GatewayOperation = keyof typeof GATEWAY_OPERATIONS;

/**
 * An operation this system sends. The inbound ones have no path because the
 * gateway calls us at a path of ours instead.
 */
export type OutboundOperation = {
  [K in GatewayOperation]: (typeof GATEWAY_OPERATIONS)[K]['path'] extends string ? K : never;
}[GatewayOperation];

/** An operation the gateway starts. The correlation check cannot apply to these. */
export type InboundOperation = {
  [K in GatewayOperation]: (typeof GATEWAY_OPERATIONS)[K]['direction'] extends 'inbound'
    ? K
    : never;
}[GatewayOperation];

export function isInboundOperation(value: string): value is InboundOperation {
  const operation = GATEWAY_OPERATIONS[value as GatewayOperation] as
    | { direction: string; built: boolean }
    | undefined;

  return operation?.direction === 'inbound' && operation.built;
}

/** The operations with an implementation behind them today. */
export function builtOperations(): GatewayOperation[] {
  return (Object.keys(GATEWAY_OPERATIONS) as GatewayOperation[]).filter(
    (operation) => GATEWAY_OPERATIONS[operation].built,
  );
}

/**
 * The envelope every gateway call carries.
 *
 * `requestId` is the whole of the correlation: the gateway answers 202 and
 * says nothing useful, and the actual answer arrives later as a separate
 * inbound request quoting this id back. Everything in `correlation.ts` exists
 * because of that one property.
 */
export interface GatewayEnvelope {
  requestId: string;
  timestamp: string;
}

/**
 * What comes back, later, as its own request.
 *
 * `resp.requestId` is ours. A callback that does not quote one we are waiting
 * for is refused rather than processed — see `callback-auth.ts`.
 */
export interface GatewayCallback<T = unknown> {
  requestId: string;
  timestamp: string;
  resp?: { requestId?: string };
  error?: { code?: number; message?: string };
  payload?: T;
}

// --- The payloads of the operations that are built -------------------------

export interface AbhaVerifyInitRequest {
  /** One of the two; the address is the one a patient knows. */
  abhaNumber: string | null;
  abhaAddress: string | null;
  method: 'mobile_otp' | 'aadhaar_otp';
}

export interface AbhaVerifyInitResult {
  transactionId: string;
  /** Masked by whoever sent the code. Null when the gateway does not say. */
  sentTo: string | null;
  expiresInSeconds: number;
}

export interface AbhaVerifyConfirmRequest {
  transactionId: string;
  code: string;
}

export interface AbhaVerifyConfirmResult {
  abhaNumber: string | null;
  abhaAddress: string | null;
  method: 'mobile_otp' | 'aadhaar_otp';
}
