import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as OTPAuth from 'otpauth';

/**
 * What SP8 left on the screens (sp8-plan.md, T34).
 *
 * Arranged the way it happens: the desk confirms the patient's ABHA against
 * the registry, offers a visit to the national network and the patient
 * answers a code; then the **consent manager** notifies a consent, a
 * requester asks for the records, and they leave. The last two are sent to
 * the API's inbound endpoints exactly as the gateway sends them, secret
 * header and all — nothing here reaches behind the API.
 *
 * The codes are the mock gateway's published one, which protects nothing and
 * is meant not to: `ABDM_MODE=mock` and this mock gateway are both refused in
 * production.
 */

export type SeededSp8 = {
  /** The ABHA the desk confirmed, as the screens should print it. */
  abhaAddress: string;
  /** The visit that is on the national network. */
  careContextDisplay: string;
  /** What the patient should see as having asked for their records. */
  requesterName: string;
  hipId: string;
};

type FixtureStaff = {
  key: string;
  name: string;
  email: string;
  password: string;
  role: string;
  hospital: string;
  totpSecret: string;
};

const MOCK_CODE = '000000';
const HIP_ID = 'HFR-CITY-GENERAL-0001';
const ABHA_ADDRESS = 'lakshmi.iyer@abdm';
const REQUESTER = { id: 'shanti-hiu@cm', name: 'Shanti Allopathic (HIU)' };

function staffNamed(key: string): FixtureStaff {
  const file = process.env.E2E_STAFF_FILE;
  if (!file) throw new Error('E2E_STAFF_FILE is not set — the global setup did not run');

  const found = (JSON.parse(readFileSync(file, 'utf8')) as FixtureStaff[]).find(
    (account) => account.key === key,
  );

  if (!found) throw new Error(`No fixture staff account called ${key}`);
  return found;
}

function totpFor(staff: FixtureStaff): string {
  return new OTPAuth.TOTP({
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(staff.totpSecret),
  }).generate();
}

class Api {
  constructor(
    private readonly origin: string,
    private readonly token: string | null = null,
  ) {}

  async call<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
    const response = await fetch(`${this.origin}/api/v1${path}`, {
      method: options.method ?? 'GET',
      headers: {
        'content-type': 'application/json',
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });

    const text = await response.text();

    if (!response.ok) {
      throw new Error(`${options.method ?? 'GET'} ${path} → ${String(response.status)} ${text}`);
    }

    return (text ? JSON.parse(text) : null) as T;
  }

  post<T>(path: string, body: unknown = {}): Promise<T> {
    return this.call<T>(path, { method: 'POST', body });
  }

  patch<T>(path: string, body: unknown = {}): Promise<T> {
    return this.call<T>(path, { method: 'PATCH', body });
  }
}

async function signIn(origin: string, key: string): Promise<Api> {
  const staff = staffNamed(key);
  const anonymous = new Api(origin);

  const login = await anonymous.post<{ challengeToken: string }>('/auth/login', {
    email: staff.email,
    password: staff.password,
  });

  const verified = await anonymous.post<{ accessToken: string }>('/auth/mfa/verify', {
    challengeToken: login.challengeToken,
    code: totpFor(staff),
  });

  return new Api(origin, verified.accessToken);
}

/** A request the way the gateway sends it: the secret, and the facility it is about. */
async function asGateway(
  apiOrigin: string,
  operation: string,
  body: Record<string, unknown>,
  callbackSecret: string,
): Promise<void> {
  const response = await fetch(`${apiOrigin}/api/v1/abdm/inbound/${operation}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hip-id': HIP_ID,
      'x-abdm-callback-secret': callbackSecret,
    },
    body: JSON.stringify({
      requestId: randomUUID(),
      timestamp: new Date().toISOString(),
      ...body,
    }),
  });

  if (!response.ok) {
    throw new Error(`${operation} → ${String(response.status)} ${await response.text()}`);
  }
}

/** A raw 32-byte X25519 public key in base64, which is what ABDM sends. */
function requesterPublicKey(): string {
  const { publicKey } = generateKeyPairSync('x25519');
  // The DER encoding of an X25519 public key is a 12-byte prefix and the key.
  return publicKey.export({ type: 'spki', format: 'der' }).subarray(12).toString('base64');
}

const day = (offset: number): string => {
  const at = new Date();
  at.setUTCDate(at.getUTCDate() + offset);
  return at.toISOString();
};

export async function seedSp8(options: {
  apiOrigin: string;
  gatewayOrigin: string;
  callbackSecret: string;
}): Promise<SeededSp8> {
  const { apiOrigin, gatewayOrigin, callbackSecret } = options;

  const admin = await signIn(apiOrigin, 'cityAdmin');
  const desk = await signIn(apiOrigin, 'cityDesk');

  // The facility has to be registered with ABDM before it can answer for
  // anything: this platform hosts many, and the gateway names one.
  const hospital = await admin.call<{ id: string }>('/hospitals/me');
  await admin.patch(`/hospitals/${hospital.id}`, { hfrId: HIP_ID });

  const found = await desk.call<{ results: Array<{ id: string; name: string }> }>(
    '/patients?q=Lakshmi',
  );

  const lakshmi = found.results.find((patient) => patient.name === 'Lakshmi Iyer');
  if (!lakshmi) throw new Error('The fixture patient is not registered at City General');

  // 1. The desk confirms her ABHA, with her reading the code back.
  const challenge = await desk.post<{ transactionId: string }>(
    `/patients/${lakshmi.id}/abha/verification`,
    { abhaAddress: ABHA_ADDRESS, method: 'mobile_otp' },
  );

  await desk.post(`/patients/${lakshmi.id}/abha/verification/confirm`, {
    transactionId: challenge.transactionId,
    code: MOCK_CODE,
  });

  // 2. A visit goes on to the national network, again only once she answers.
  const visits = await desk.call<Array<{ encounterId: string; display: string }>>(
    `/patients/${lakshmi.id}/care-contexts`,
  );

  const visit = visits[0];
  if (!visit) throw new Error('The fixture patient has no visit to share');

  const offered = await desk.post<{ linkRequestId: string }>(
    `/patients/${lakshmi.id}/care-contexts/link`,
    { encounterIds: [visit.encounterId] },
  );

  await desk.post(`/patients/${lakshmi.id}/care-contexts/link/confirm`, {
    linkRequestId: offered.linkRequestId,
    code: MOCK_CODE,
  });

  // 3. She grants a consent in her ABHA app; the consent manager tells us.
  const consentId = `e2e-consent-${String(process.pid)}`;

  await asGateway(
    apiOrigin,
    'consent.notify',
    {
      notification: {
        status: 'GRANTED',
        consentId,
        consentDetail: {
          hiu: REQUESTER,
          careContexts: [{ careContextReference: visit.encounterId }],
          hiTypes: ['Prescription', 'OPConsultation'],
          permission: {
            dateRange: { from: day(-365), to: day(1) },
            dataEraseAt: day(30),
          },
        },
      },
    },
    callbackSecret,
  );

  // 4. And the requester asks for them. The worker assembles, encrypts and
  //    pushes; what the portal then shows is the point of the test.
  await asGateway(
    apiOrigin,
    'health-information.request',
    {
      transactionId: `e2e-transfer-${String(process.pid)}`,
      hiRequest: {
        consent: { id: consentId },
        dataPushUrl: `${gatewayOrigin}/hiu/data-push`,
        keyMaterial: {
          cryptoAlg: 'ECDH',
          curve: 'Curve25519',
          // A real key pair, generated here and thrown away: the requester in
          // these tests is the mock gateway, which keeps what it receives and
          // decrypts none of it. The transfer still has to agree a key, and
          // that is what this is for.
          dhPublicKey: { keyValue: requesterPublicKey() },
          nonce: randomBytes(32).toString('base64'),
        },
      },
    },
    callbackSecret,
  );

  return {
    abhaAddress: ABHA_ADDRESS,
    careContextDisplay: visit.display,
    requesterName: REQUESTER.name,
    hipId: HIP_ID,
  };
}
