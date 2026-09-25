import { readFileSync } from 'node:fs';
import * as OTPAuth from 'otpauth';

/**
 * What SP6 left on the screens, arranged through the API (sp6-plan.md, T25).
 *
 * Unlike the record the patient reads, which is written straight to the
 * database, this is created by signing in as the staff who would have created
 * it and calling the same endpoints the clinical app calls. Invoices number
 * themselves, PDFs are rendered, documents reach the patient's portal — none
 * of which happens if rows are inserted behind the API's back.
 *
 * It leaves City General looking like an ordinary Tuesday: a patient in a bed,
 * an urgent panel the lab has not done yet, a stay that has been billed and
 * half paid, and a discharge summary signed and sent.
 */

export type FixtureStaff = {
  key: string;
  name: string;
  email: string;
  password: string;
  role: string;
  hospital: string;
  totpSecret: string;
};

export type SeededSp6 = {
  /** What the bills screen should be showing, in paise. */
  invoiceTotalPaise: number;
  invoiceNumber: string;
  /** The urgent order the lab worklist opens on. */
  orderDisplay: string;
  /** The ward and bed the board shows somebody in. */
  ward: string;
  bed: string;
};

/** The fixture accounts, as `apps/api/src/db/e2e-fixture.ts` wrote them. */
export function staffAccounts(): FixtureStaff[] {
  const file = process.env.E2E_STAFF_FILE;
  if (!file) throw new Error('E2E_STAFF_FILE is not set — the global setup did not run');

  return JSON.parse(readFileSync(file, 'utf8')) as FixtureStaff[];
}

export function staffNamed(key: string): FixtureStaff {
  const found = staffAccounts().find((account) => account.key === key);
  if (!found) throw new Error(`No fixture staff account called ${key}`);

  return found;
}

/** The code their authenticator app would be showing right now. */
export function totpFor(staff: FixtureStaff): string {
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
    private token: string | null = null,
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
      throw new Error(`${options.method ?? 'GET'} ${path} → ${response.status} ${text}`);
    }

    return (text ? JSON.parse(text) : null) as T;
  }

  post<T>(path: string, body: unknown = {}): Promise<T> {
    return this.call<T>(path, { method: 'POST', body });
  }
}

/** Signs a fixture account in the way the clinical app does: password, then code. */
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

export async function seedSp6(origin: string): Promise<SeededSp6> {
  const physician = await signIn(origin, 'physician');
  const desk = await signIn(origin, 'cityDesk');
  const admin = await signIn(origin, 'cityAdmin');

  const found = await desk.call<{ results: Array<{ id: string; name: string }> }>(
    '/patients?q=Lakshmi',
  );
  const lakshmi = found.results.find((patient) => patient.name === 'Lakshmi Iyer');
  if (!lakshmi) throw new Error('The fixture patient is not registered at City General');

  // What the hospital charges for.
  const prices: Record<string, string> = {};
  for (const item of [
    { code: 'BED-DAY', name: 'General ward bed', category: 'bed', unit: 'day', pricePaise: 120000 },
    {
      code: 'PROC-ERCP',
      name: 'Endoscopic procedure',
      category: 'procedure',
      unit: 'each',
      pricePaise: 850000,
    },
    {
      code: 'LAB-LFT',
      name: 'Liver function panel',
      category: 'laboratory',
      unit: 'test',
      pricePaise: 60000,
    },
  ]) {
    const created = await admin.post<{ id: string }>('/catalogue', item);
    prices[item.code] = created.id;
  }

  // Its wards.
  const ward = await admin.post<{ id: string; beds: Array<{ id: string; label: string }> }>(
    '/wards',
    { name: 'General ward', kind: 'general', beds: ['G1', 'G2'] },
  );

  // ---------------------------------------------------------------------
  // A stay that is over: billed, half paid, summarised and signed.
  // ---------------------------------------------------------------------

  const past = await physician.post<{ id: string }>('/encounters', {
    patientId: lakshmi.id,
    class: 'inpatient',
    systemOfMedicine: 'allopathy',
    chiefComplaint: 'Jaundice and upper abdominal pain',
  });

  await desk.post('/admissions', { encounterId: past.id, bedId: ward.beds[0]!.id });

  await physician.post('/procedures', {
    encounterId: past.id,
    name: 'ERCP with biliary stenting',
    preOpAssessment: 'Fasting since midnight. Consent taken.',
    anaesthesia: 'Sedation',
    operativeNote: 'Distal stricture dilated and a 10 Fr stent placed. Bile drained freely.',
    postOpCourse: 'Comfortable. Eating by the evening.',
    outcome: 'Uncomplicated',
  });

  const summary = await physician.post<{ id: string }>('/discharge-summaries', {
    encounterId: past.id,
  });
  await physician.post(`/discharge-summaries/${summary.id}`, {
    sections: [
      { key: 'condition', text: 'Comfortable, eating, jaundice settling.' },
      { key: 'advice', text: 'Return at once if the fever or the pain comes back.' },
      { key: 'follow_up', text: 'Review in four weeks with a repeat liver panel.' },
    ],
  });
  await physician.post(`/discharge-summaries/${summary.id}/sign`, { confirmed: true });

  await desk.post(`/admissions/${past.id}/discharge`, { note: 'Home, review in four weeks' });

  const chargeable = await desk.call<{
    uncharged: Array<{ source: string; sourceId: string; quantity: number }>;
  }>(`/encounters/${past.id}/charges`);

  for (const row of chargeable.uncharged) {
    const item = row.source === 'bed_day' ? prices['BED-DAY'] : prices['PROC-ERCP'];
    if (!item) continue;

    await desk.post('/charges', {
      encounterId: past.id,
      itemId: item,
      quantity: row.quantity,
      source: row.source,
      sourceId: row.sourceId,
    });
  }

  const invoice = await desk.post<{ id: string; number: string; totalPaise: number }>('/invoices', {
    encounterId: past.id,
  });

  await desk.post(`/invoices/${invoice.id}/entries`, {
    kind: 'payment',
    method: 'cash',
    amountPaise: Math.floor(invoice.totalPaise / 2),
  });

  // ---------------------------------------------------------------------
  // And today: somebody in a bed, and a panel the lab has not done yet.
  // ---------------------------------------------------------------------

  const current = await physician.post<{ id: string }>('/encounters', {
    patientId: lakshmi.id,
    class: 'inpatient',
    systemOfMedicine: 'allopathy',
    chiefComplaint: 'Fever since the stent, for observation',
  });

  await desk.post('/admissions', { encounterId: current.id, bedId: ward.beds[1]!.id });

  const order = await physician.post<{ requestedDisplay: string }>('/orders', {
    encounterId: current.id,
    category: 'laboratory',
    requestedDisplay: 'Liver function panel',
    requestedCodeSystem: 'http://loinc.org',
    requestedCode: '24325-3',
    priority: 'urgent',
    clinicalNote: 'Fever since the stent; repeat before the round',
  });

  return {
    invoiceTotalPaise: invoice.totalPaise,
    invoiceNumber: invoice.number,
    orderDisplay: order.requestedDisplay,
    ward: 'General ward',
    bed: ward.beds[1]!.label,
  };
}
