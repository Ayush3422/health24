#!/usr/bin/env node
/**
 * The mock ABDM gateway, as a process (sp8-plan.md, T7, T34).
 *
 * The integration suite starts it in-process; the browser tests cannot,
 * because the API they drive is a build running in a process of its own and
 * has to be told where the gateway is before it starts. So this runs the same
 * class on a known port.
 *
 * It is the same mock either way — one implementation of the wire format, as
 * DF4 asks — and it needs no credential, because it is not one.
 *
 *   PORT=3103 CALLBACK_BASE_URL=http://localhost:3100 \
 *   ABDM_CLIENT_ID=... ABDM_CLIENT_SECRET=... ABDM_CALLBACK_SECRET=... \
 *   node apps/api/scripts/abdm-mock-gateway.mjs
 */

import { MockGatewayServer } from '../dist/modules/abdm/gateway/mock-gateway.js';

const port = Number(process.env.PORT ?? 3103);

const gateway = new MockGatewayServer({
  callbackBaseUrl: process.env.CALLBACK_BASE_URL ?? 'http://localhost:3100',
  clientId: process.env.ABDM_CLIENT_ID ?? 'health24-e2e',
  clientSecret: process.env.ABDM_CLIENT_SECRET ?? 'not-a-real-client-secret',
  callbackSecret: process.env.ABDM_CALLBACK_SECRET ?? null,
});

await gateway.start(port);

console.log(`Mock ABDM gateway listening on ${gateway.url}`);
console.log(`  data pushes land at ${gateway.dataPushUrl}`);
console.log(`  callbacks go to ${gateway.callbackBaseUrl}`);

const stop = () => {
  void gateway.stop().then(() => process.exit(0));
};

process.on('SIGINT', stop);
process.on('SIGTERM', stop);
