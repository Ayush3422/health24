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
  /** Ask for a code to be sent to whatever the method names. Built. */
  'abha.verify.init': { path: '/v0.5/users/auth/init', built: true },
  /** Answer that code. Built. */
  'abha.verify.confirm': { path: '/v0.5/users/auth/confirm', built: true },

  /** Phase 3: answer the gateway's search for a patient we hold records for. */
  'care-context.discover': { path: '/v0.5/care-contexts/discover', built: false },
  /** Phase 3: offer a link, and confirm it once the patient answers. */
  'care-context.link.init': { path: '/v0.5/links/link/init', built: false },
  'care-context.link.confirm': { path: '/v0.5/links/link/confirm', built: false },

  /** Phase 4: the consent manager telling us a consent now exists. */
  'consent.notify': { path: '/v0.5/consents/hip/notify', built: false },

  /** Phase 5: a request for data, and the outcome of sending it. */
  'health-information.request': { path: '/v0.5/health-information/hip/request', built: false },
  'health-information.notify': { path: '/v0.5/health-information/notify', built: false },
} as const;

export type GatewayOperation = keyof typeof GATEWAY_OPERATIONS;

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
