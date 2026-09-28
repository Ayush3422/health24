#!/usr/bin/env node
/**
 * What the production images prove about themselves (sp7-plan.md, T31).
 *
 * Run against the stack `docker-compose.prod.yml` brings up — the same images
 * that would be deployed, configured the way a deployment configures them,
 * with `NODE_ENV=production` and every production refusal in force.
 *
 * What it deliberately does **not** do is sign anybody in. The seed script
 * refuses to run against a production database, which is correct: a deployment
 * has no well-known passwords in it. So this checks what a deployed stack can
 * honestly be asked without fixtures — that it started, that it can reach
 * everything it needs, that it says which commit it is, that it refuses what it
 * should, and that a browser would be told the right things. Signing in is
 * covered by the integration and browser suites, against the development stack.
 *
 *   node scripts/smoke-prod-stack.mjs
 *
 * Ports come from the compose file and can be overridden: API_URL, WORKER_URL,
 * CLINICAL_URL, PORTAL_URL.
 */

const API = process.env.API_URL ?? 'http://localhost:3001';
const WORKER = process.env.WORKER_URL ?? 'http://localhost:3101';
const CLINICAL = process.env.CLINICAL_URL ?? 'http://localhost:8081';
const PORTAL = process.env.PORTAL_URL ?? 'http://localhost:8082';

const failures = [];
let checked = 0;

function check(what, ok, detail = '') {
  checked += 1;
  if (ok) {
    console.log(`ok   ${what}${detail ? ` — ${detail}` : ''}`);
  } else {
    console.log(`FAIL ${what}${detail ? ` — ${detail}` : ''}`);
    failures.push(what);
  }
}

/** A request that says what went wrong rather than throwing a stack trace. */
async function get(url, options = {}) {
  try {
    const response = await fetch(url, { ...options, signal: AbortSignal.timeout(10_000) });
    const text = await response.text();

    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }

    return { status: response.status, headers: response.headers, body, text };
  } catch (error) {
    return { status: 0, headers: new Headers(), body: null, text: String(error) };
  }
}

/** Waits for the stack, because a compose that has just started is not ready. */
async function waitFor(url, label, timeoutMs = 180_000) {
  const until = Date.now() + timeoutMs;

  for (;;) {
    const response = await get(url);
    if (response.status === 200) return;

    if (Date.now() > until) {
      check(`${label} answers`, false, `gave up after ${String(timeoutMs / 1000)}s`);
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

async function main() {
  console.log(`Smoking the production stack at ${API}\n`);

  await waitFor(`${API}/health`, 'the API');

  // --- The API is alive, ready, and says what it is -------------------------

  const health = await get(`${API}/health`);
  check('liveness answers', health.status === 200 && health.body?.status === 'ok');

  const ready = await get(`${API}/ready`);
  const checksSaid = ready.body?.checks ?? {};

  check(
    'readiness answers 200',
    ready.status === 200 && ready.body?.ready === true,
    Object.entries(checksSaid)
      .map(([name, value]) => `${name}=${value.state}`)
      .join(' '),
  );

  for (const dependency of ['database', 'migrations', 'redis', 'storage']) {
    check(`${dependency} is reachable`, checksSaid[dependency]?.state === 'up');
  }

  const version = await get(`${API}/version`);
  check(
    'version names the build',
    version.status === 200 && version.body?.environment === 'production',
    `commit ${String(version.body?.commit)} built ${String(version.body?.builtAt)}`,
  );

  // --- It refuses what it should, which needs the database ------------------

  const unauthenticated = await get(`${API}/api/v1/patients?q=anybody`);
  check('an unauthenticated read is refused', unauthenticated.status === 401);

  const login = await get(`${API}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'nobody@example.in', password: 'not-the-password' }),
  });

  check(
    'a sign-in with no account round-trips to the database and is refused',
    login.status === 401,
  );
  check(
    'and the refusal says nothing about which half was wrong',
    /invalid email or password/i.test(JSON.stringify(login.body)),
  );

  // --- What a browser is told ----------------------------------------------

  const apiPolicy = health.headers.get('content-security-policy') ?? '';
  check('the API allows a browser nothing', apiPolicy.includes("default-src 'none'"));
  check('the API is not framed', health.headers.get('x-frame-options') === 'DENY');
  check('the API does not announce what it runs on', !health.headers.get('x-powered-by'));

  for (const [name, url] of [
    ['the clinical app', CLINICAL],
    ['the portal', PORTAL],
  ]) {
    const page = await get(`${url}/`);
    const policy = page.headers.get('content-security-policy') ?? '';

    check(`${name} serves`, page.status === 200);
    check(`${name} sends a policy`, policy.includes("default-src 'self'"));
    check(
      `${name} lets a document load from storage`,
      /img-src[^;]*https?:\/\//.test(policy),
      policy.split(';').find((part) => part.includes('img-src'))?.trim(),
    );
    check(`${name} refuses to be framed`, page.headers.get('x-frame-options') === 'DENY');
    check(`${name} answers its own health check`, (await get(`${url}/healthz`)).status === 200);
  }

  // --- The worker --------------------------------------------------------

  const workerHealth = await get(`${WORKER}/health`);
  check('the worker is alive', workerHealth.status === 200);

  const metrics = await get(`${WORKER}/metrics`);
  check(
    'the worker says how deep its queues are',
    metrics.status === 200 && metrics.text.includes('scan_queue_waiting'),
  );
  check(
    'and names no patient in doing so',
    !/[6-9]\d{9}|[A-Z]{2,6}-\d{4,}/.test(metrics.text),
  );

  // --- The result ----------------------------------------------------------

  console.log(`\n${String(checked - failures.length)} of ${String(checked)} checks passed`);

  if (failures.length > 0) {
    console.error(`\nThe stack is not serving correctly:\n  ${failures.join('\n  ')}`);
    process.exit(1);
  }

  console.log('The production images work.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
