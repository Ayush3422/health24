/**
 * Shared helpers for the smoke scripts.
 *
 * The important job here is making the scripts re-runnable. A second factor is
 * only revealed once, at enrolment, so a naive script can sign in exactly one
 * time and then fails forever against the same database — which makes it
 * useless as something you run after every change.
 *
 * Two mechanisms fix that: enrolment secrets are cached locally, and tests
 * that need a pristine account create one rather than borrowing a seeded one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as OTPAuth from 'otpauth';

export const BASE = 'http://localhost:3000/api/v1';
export const SEED_PASSWORD = 'health24-dev-password';

const here = path.dirname(fileURLToPath(import.meta.url));
/** Gitignored: holds TOTP secrets for development accounts only. */
const SECRETS_FILE = path.join(here, '..', '.smoke-secrets.json');

function readSecrets() {
  try {
    return JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeSecrets(secrets) {
  fs.writeFileSync(SECRETS_FILE, JSON.stringify(secrets, null, 2));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Issues a request, backing off when the rate limiter pushes back.
 *
 * The login throttle (10/minute) is a real control and should not be relaxed
 * to suit the tests — so the tests wait instead. Without this, running the
 * suite twice in a row fails on 429 rather than on anything meaningful.
 */
export async function call(method, path_, { token, body, retryOn429 = true } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    const result = await callOnce(method, path_, { token, body });

    if (result.status !== 429 || !retryOn429 || attempt >= 3) {
      return result;
    }

    const waitMs = 15_000 * (attempt + 1);
    console.log(`  (rate limited on ${path_}; waiting ${waitMs / 1000}s)`);
    await sleep(waitMs);
  }
}

async function callOnce(method, path_, { token, body } = {}) {
  const res = await fetch(`${BASE}${path_}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON response */
  }

  return { status: res.status, body: json, raw: text };
}

function totpFor(base32) {
  return new OTPAuth.TOTP({
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(base32),
  });
}

/**
 * Signs in completely, enrolling a second factor the first time and reusing
 * the cached secret on every run after that.
 */
export async function signIn(email, password = SEED_PASSWORD) {
  const login = await call('POST', '/auth/login', { body: { email, password } });

  if (login.status !== 200) {
    throw new Error(`Login failed for ${email}: ${login.status} ${login.raw.slice(0, 200)}`);
  }

  const secrets = readSecrets();

  if (login.body.status === 'mfa_enrolment_required') {
    const parsed = OTPAuth.URI.parse(login.body.otpauthUrl);

    const enrol = await call('POST', '/auth/mfa/enrol', {
      body: { challengeToken: login.body.challengeToken, code: parsed.generate() },
    });

    if (enrol.status !== 200) {
      throw new Error(`Enrolment failed for ${email}: ${enrol.status} ${enrol.raw.slice(0, 200)}`);
    }

    secrets[email] = login.body.secret;
    writeSecrets(secrets);

    return { token: enrol.body.accessToken, refreshToken: enrol.body.refreshToken, staff: enrol.body.staff };
  }

  // Already enrolled: use the cached secret.
  const stored = secrets[email];

  if (!stored) {
    throw new Error(
      `${email} has a second factor enrolled but no cached secret. ` +
        `Delete scripts/.smoke-secrets.json and reset MFA in the database, or use a fresh account.`,
    );
  }

  const verify = await call('POST', '/auth/mfa/verify', {
    body: { challengeToken: login.body.challengeToken, code: totpFor(stored).generate() },
  });

  if (verify.status !== 200) {
    throw new Error(`MFA verify failed for ${email}: ${verify.status} ${verify.raw.slice(0, 200)}`);
  }

  return { token: verify.body.accessToken, refreshToken: verify.body.refreshToken, staff: verify.body.staff };
}

/**
 * Invites and activates a brand-new staff account.
 *
 * Used by tests that need an account which has never signed in, so that the
 * first-login path can be exercised on every run instead of only once.
 */
export async function createStaff(adminToken, { role, systemOfMedicine, name } = {}) {
  const email = `smoke.${role ?? 'clinician'}.${Date.now()}.${Math.floor(Math.random() * 1e4)}@sanjeevani.example.in`;
  const password = 'a-perfectly-fine-passphrase';

  const invite = await call('POST', '/staff/invite', {
    token: adminToken,
    body: {
      name: name ?? 'Smoke Test User',
      email,
      role: role ?? 'clinician',
      ...(systemOfMedicine || (role ?? 'clinician') === 'clinician'
        ? { systemOfMedicine: systemOfMedicine ?? 'ayurveda' }
        : {}),
    },
  });

  if (invite.status !== 201) {
    throw new Error(`Invite failed: ${invite.status} ${invite.raw.slice(0, 200)}`);
  }

  const accept = await call('POST', '/auth/invite/accept', {
    body: { inviteToken: invite.body.inviteToken, password },
  });

  if (accept.status !== 204) {
    throw new Error(`Invite acceptance failed: ${accept.status} ${accept.raw.slice(0, 200)}`);
  }

  return { email, password, staff: invite.body.staff, inviteToken: invite.body.inviteToken };
}

export function reporter() {
  const state = { failures: 0 };

  return {
    check(label, condition, detail = '') {
      if (!condition) state.failures += 1;
      console.log(`[${condition ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`);
    },
    section(title) {
      console.log(`\n=== ${title} ===`);
    },
    finish() {
      console.log(`\n${state.failures === 0 ? 'ALL CHECKS PASSED' : state.failures + ' CHECK(S) FAILED'}`);
      process.exit(state.failures === 0 ? 0 : 1);
    },
  };
}
