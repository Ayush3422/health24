import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import argon2 from 'argon2';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import * as OTPAuth from 'otpauth';
import { encryptSecret } from '../common/crypto';
import { loadEnv } from '../config/load-env';

loadEnv();

/**
 * The database the portal's browser tests run against (sp5-plan.md, T23).
 *
 * A third database, beside the developer's and the integration suite's: the
 * browser tests read a fixed record on the screen — Lakshmi's Amlapitta, her
 * penicillin allergy, the liver panel — so the data has to be the same on
 * every run, and truncating either of the other two would be somebody's bad
 * afternoon.
 *
 * Everything here is written straight to the database as the owner, in system
 * context. The journeys under test belong to the patient and are walked in the
 * browser; this only arranges what the desk and the clinicians did before she
 * ever signed in.
 *
 * The names and the phone number are what `apps/portal/e2e/fixture.ts`
 * asserts on. Change one, change the other.
 */

const DATABASE = process.env.E2E_DATABASE ?? 'health24_e2e';

/**
 * The clinical app's browser tests sign in as these people, so unlike SP5's
 * fixture they carry a real second factor. It is a fixture account on a
 * throwaway database and nothing else.
 */
const STAFF_PASSWORD = 'e2e-fixture-password-not-real';

/**
 * Where the accounts are written for the browser tests to read: emails,
 * the password and the enrolled secrets, so a test can sign in as a person
 * instead of being handed a token.
 */
const STAFF_FILE =
  process.env.E2E_STAFF_FILE ??
  path.resolve(__dirname, '..', '..', '..', 'portal', 'test-results', 'e2e-staff.json');

type FixtureStaff = {
  key: string;
  name: string;
  email: string;
  password: string;
  role: string;
  hospital: string;
  totpSecret: string;
};

const accounts: FixtureStaff[] = [];

const PHONE = '+919820055001';

function ownerUrl(database: string): string {
  const base = process.env.DATABASE_ADMIN_URL;

  if (!base) {
    throw new Error('DATABASE_ADMIN_URL is not set — the fixture needs the owner connection');
  }

  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

async function createDatabase(): Promise<void> {
  const maintenance = postgres(ownerUrl('postgres'), { max: 1, onnotice: () => {} });

  try {
    const existing = await maintenance`SELECT 1 FROM pg_database WHERE datname = ${DATABASE}`;
    if (existing.length === 0) await maintenance.unsafe(`CREATE DATABASE ${DATABASE}`);
  } finally {
    await maintenance.end({ timeout: 5 });
  }
}

/**
 * Migrations run as the owner, and they also create the `health24_app`
 * privilege group and its grants — which are per-database. That is what makes
 * row-level security bind here as it does everywhere else, so the browser is
 * held to the same rules as the API suites.
 */
async function migrateAndGrant(admin: postgres.Sql): Promise<void> {
  await migrate(drizzle(admin), {
    migrationsFolder: path.resolve(__dirname, '..', '..', 'drizzle'),
  });

  const loginRole = process.env.LOCAL_APP_DB_USER ?? 'health24_api';
  const roleExists = await admin`SELECT 1 FROM pg_roles WHERE rolname = ${loginRole}`;

  if (roleExists.length === 0) {
    throw new Error(`Login role ${loginRole} does not exist. Run: pnpm db:bootstrap`);
  }

  await admin.unsafe(`GRANT health24_app TO ${loginRole}`);
}

/**
 * Empties every table, whatever the schema has grown since.
 *
 * `TRUNCATE` rather than deletes, because the audit trail forbids DELETE —
 * correctly. Truncation is a DDL operation and bypasses the row trigger, which
 * is exactly why the name of the database is checked first.
 */
async function emptyEverything(admin: postgres.Sql): Promise<void> {
  const [current] = await admin<Array<{ name: string }>>`SELECT current_database() AS name`;

  if (current?.name !== DATABASE || !DATABASE.endsWith('_e2e')) {
    throw new Error(
      `Refusing to truncate ${current?.name} — the fixture only runs against a _e2e database`,
    );
  }

  const tables = await admin<Array<{ name: string }>>`
    SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public'
  `;

  if (tables.length > 0) {
    const list = tables.map((table) => `"${table.name}"`).join(', ');
    await admin.unsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
  }
}

async function seed(admin: postgres.Sql): Promise<void> {
  const passwordHash = await argon2.hash(STAFF_PASSWORD, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });

  await admin.begin(async (tx) => {
    await tx`SELECT set_config('app.system_context', 'on', true)`;

    const hospital = async (name: string, prefix: string, type: 'ayush' | 'allopathic') => {
      const [row] = await tx<Array<{ id: string }>>`
        INSERT INTO hospital (name, facility_type, contact_email, contact_phone, mrn_prefix, status)
        VALUES (${name}, ${type}, ${`contact@${prefix.toLowerCase()}.example.in`}, '+919812345670',
                ${prefix}, 'active')
        RETURNING id
      `;
      return row!.id;
    };

    const totpKey = process.env.TOTP_ENCRYPTION_KEY;
    if (!totpKey) throw new Error('TOTP_ENCRYPTION_KEY is not set — the fixture enrols staff');

    const staff = async (
      key: string,
      hospitalId: string,
      hospitalName: string,
      name: string,
      email: string,
      role: 'clinician' | 'front_desk' | 'hospital_admin',
      systemOfMedicine: 'ayurveda' | null = null,
    ) => {
      const secret = new OTPAuth.Secret({ size: 20 }).base32;

      const [row] = await tx<Array<{ id: string }>>`
        INSERT INTO staff_user (hospital_id, name, email, role, system_of_medicine, status,
                                password_hash, totp_secret_encrypted, totp_enrolled_at)
        VALUES (${hospitalId}, ${name}, ${email}, ${role}, ${systemOfMedicine}, 'active',
                ${passwordHash}, ${encryptSecret(secret, totpKey)}, now())
        RETURNING id
      `;

      accounts.push({
        key,
        name,
        email,
        password: STAFF_PASSWORD,
        role,
        hospital: hospitalName,
        totpSecret: secret,
      });

      return row!.id;
    };

    const sanjeevani = await hospital('Sanjeevani Ayurvedic Hospital', 'SAE', 'ayush');
    const cityGeneral = await hospital('City General Hospital', 'CGE', 'allopathic');

    const SANJEEVANI = 'Sanjeevani Ayurvedic Hospital';
    const CITY_GENERAL = 'City General Hospital';

    const vaidya = await staff(
      'vaidya',
      sanjeevani,
      SANJEEVANI,
      'Meera Joshi',
      'meera.joshi@sae.example.in',
      'clinician',
      'ayurveda',
    );
    const desk = await staff(
      'desk',
      sanjeevani,
      SANJEEVANI,
      'Anita Pawar',
      'anita.pawar@sae.example.in',
      'front_desk',
    );
    await staff(
      'ayushAdmin',
      sanjeevani,
      SANJEEVANI,
      'Rekha Deshmukh',
      'rekha.deshmukh@sae.example.in',
      'hospital_admin',
    );
    const gastroenterologist = await staff(
      'physician',
      cityGeneral,
      CITY_GENERAL,
      'Arun Nair',
      'arun.nair@cge.example.in',
      'clinician',
    );
    await staff(
      'cityDesk',
      cityGeneral,
      CITY_GENERAL,
      'Farida Shaikh',
      'farida.shaikh@cge.example.in',
      'front_desk',
    );
    await staff(
      'cityAdmin',
      cityGeneral,
      CITY_GENERAL,
      'Sunil Rao',
      'sunil.rao@cge.example.in',
      'hospital_admin',
    );

    const patient = async (
      name: string,
      gender: 'female' | 'male',
      dateOfBirth: string,
      bloodGroup: string | null,
    ) => {
      const [row] = await tx<Array<{ id: string }>>`
        INSERT INTO patient (name, name_normalized, gender, date_of_birth, birth_year, phone, blood_group,
                             created_by_hospital_id, status)
        VALUES (${name}, ${name.toLowerCase()}, ${gender}, ${dateOfBirth},
                ${Number(dateOfBirth.slice(0, 4))}, ${PHONE}, ${bloodGroup}, ${sanjeevani}, 'active')
        RETURNING id
      `;
      return row!.id;
    };

    const lakshmi = await patient('Lakshmi Iyer', 'female', '1968-04-12', 'B+');
    // Her husband shares the phone, so signing in asks whose record to open
    // (Decision J1): one household, one number, two people.
    const ganesh = await patient('Ganesh Iyer', 'male', '1962-11-30', null);

    await tx`
      INSERT INTO patient_hospital_link (patient_id, hospital_id, mrn) VALUES
        (${lakshmi}, ${sanjeevani}, 'SAE-000001'),
        (${lakshmi}, ${cityGeneral}, 'CGE-000001'),
        (${ganesh}, ${sanjeevani}, 'SAE-000002')
    `;

    // Her record at Sanjeevani: the Amlapitta consultation of SP3, and the
    // liver panel and the ultrasound of SP4.
    const [visit] = await tx<Array<{ id: string }>>`
      INSERT INTO encounter (patient_id, hospital_id, class, system_of_medicine, attending_staff_id,
                             recorded_by_staff_id, status, started_at, ended_at, chief_complaint)
      VALUES (${lakshmi}, ${sanjeevani}, 'outpatient', 'ayurveda', ${vaidya}, ${vaidya}, 'finished',
              now() - interval '60 days', now() - interval '60 days' + interval '30 minutes',
              'Burning after meals for three months')
      RETURNING id
    `;

    const [condition] = await tx<Array<{ id: string }>>`
      INSERT INTO condition (patient_id, hospital_id, encounter_id, clinical_status, verification_status,
                             is_primary, attributed_clinician_id, recorded_by_staff_id)
      VALUES (${lakshmi}, ${sanjeevani}, ${visit!.id}, 'active', 'confirmed', true, ${vaidya}, ${vaidya})
      RETURNING id
    `;
    await tx`
      INSERT INTO condition_coding (condition_id, role, code_system_key, code_system_version, code, display)
      VALUES (${condition!.id}, 'primary', 'NAMASTE', '2024', 'AYU-AMLAPITTA', 'Amlapitta')
    `;

    await tx`
      INSERT INTO medication_request (patient_id, hospital_id, encounter_id, system_of_medicine,
                                      medicine_name, strength, frequency, route, attributed_clinician_id,
                                      recorded_by_staff_id)
      VALUES (${lakshmi}, ${sanjeevani}, ${visit!.id}, 'ayurveda', 'Avipattikar churna', '5 g', '1-0-1',
              'oral', ${vaidya}, ${vaidya})
    `;
    await tx`
      INSERT INTO allergy_intolerance (patient_id, hospital_id, encounter_id, substance, category,
                                       criticality, reaction, attributed_clinician_id, recorded_by_staff_id)
      VALUES (${lakshmi}, ${sanjeevani}, ${visit!.id}, 'Penicillin V', 'medication', 'high',
              'Hives and facial swelling', ${vaidya}, ${vaidya})
    `;

    // Three years of one liver value, so the trend has a line to draw and the
    // latest reading is above the lab's range.
    const liverPanel = [
      { days: 600, value: 39, interpretation: 'normal' },
      { days: 300, value: 48, interpretation: 'normal' },
      { days: 55, value: 62, interpretation: 'high' },
    ];

    for (const reading of liverPanel) {
      await tx`
        INSERT INTO observation (patient_id, hospital_id, encounter_id, category, source, code_system, code,
                                 display, value_quantity, unit, value_canonical, unit_canonical,
                                 reference_low, reference_high, interpretation, panel_code, group_id,
                                 effective_at, recorded_by_staff_id)
        VALUES (${lakshmi}, ${sanjeevani}, ${reading.days === 55 ? visit!.id : null}, 'laboratory',
                'entered', 'http://loinc.org', '1742-6', 'Alanine aminotransferase', ${reading.value},
                'U/L', ${reading.value}, 'U/L', 7, 56, ${reading.interpretation}, 'lft', gen_random_uuid(),
                now() - make_interval(days => ${reading.days}), ${vaidya})
      `;
    }

    await tx`
      INSERT INTO document_reference (patient_id, hospital_id, encounter_id, doc_type, title, report_date,
                                      availability, availability_changed_at, recorded_by_staff_id)
      VALUES (${lakshmi}, ${sanjeevani}, ${visit!.id}, 'radiology', 'Ultrasound abdomen',
              CURRENT_DATE - 50, 'available', now(), ${vaidya})
    `;

    // And a visit to City General, so her record plainly comes from two
    // hospitals even before she shares anything.
    const [cityVisit] = await tx<Array<{ id: string }>>`
      INSERT INTO encounter (patient_id, hospital_id, class, system_of_medicine, attending_staff_id,
                             recorded_by_staff_id, status, started_at, ended_at, chief_complaint)
      VALUES (${lakshmi}, ${cityGeneral}, 'outpatient', 'allopathy', ${gastroenterologist},
              ${gastroenterologist}, 'finished', now() - interval '20 days',
              now() - interval '20 days' + interval '20 minutes', 'Review of liver function')
      RETURNING id
    `;
    await tx`
      INSERT INTO observation (patient_id, hospital_id, encounter_id, category, source, code_system, code,
                               display, value_quantity, unit, value_canonical, unit_canonical,
                               reference_low, reference_high, interpretation, panel_code, group_id,
                               effective_at, recorded_by_staff_id)
      VALUES (${lakshmi}, ${cityGeneral}, ${cityVisit!.id}, 'laboratory', 'entered', 'http://loinc.org',
              '718-7', 'Haemoglobin', 11.2, 'g/dL', 11.2, 'g/dL', 12, 15, 'low', 'cbc',
              gen_random_uuid(), now() - interval '20 days', ${gastroenterologist})
    `;

    // The portal account: her phone, activated at the desk for both of them.
    const [account] = await tx<Array<{ id: string }>>`
      INSERT INTO patient_account (phone) VALUES (${PHONE}) RETURNING id
    `;
    await tx`
      INSERT INTO patient_portal_access (account_id, patient_id, phone, relationship,
                                         activated_at_hospital_id, activated_by_staff_id, activated_at)
      VALUES (${account!.id}, ${lakshmi}, ${PHONE}, 'self', ${sanjeevani}, ${desk},
              now() - interval '30 days'),
             (${account!.id}, ${ganesh}, ${PHONE}, 'self', ${sanjeevani}, ${desk},
              now() - interval '30 days')
    `;

    // A consent she gave City General last month and stopped a week ago, and
    // the gastroenterologist's reading of her record while it stood: the
    // access history has something true to show before the tests touch it.
    const [past] = await tx<Array<{ id: string }>>`
      INSERT INTO consent_artefact (patient_id, grantee_hospital_id, purpose, data_categories, granted_at,
                                    expires_at, capture_method, recorded_by_patient_account_id, status,
                                    revoked_at, revoked_by_patient_account_id, revocation_reason)
      VALUES (${lakshmi}, ${cityGeneral}, 'care_management',
              ARRAY['diagnoses','medications']::clinical_data_category[],
              now() - interval '30 days', now() + interval '150 days', 'patient_portal', ${account!.id},
              'revoked', now() - interval '7 days', ${account!.id},
              'Revoked by the patient in the portal')
      RETURNING id
    `;

    for (const resource of ['timeline', 'condition', 'medication_request']) {
      await tx`
        INSERT INTO access_log (actor_id, actor_type, actor_label, hospital_id, patient_id, resource_type,
                                action, outcome, consent_artefact_id, route, at)
        VALUES (${gastroenterologist}, 'staff', 'Arun Nair', ${cityGeneral}, ${lakshmi}, ${resource},
                'read', 'allowed', ${past!.id}, '/api/v1/patients/:id/timeline',
                now() - interval '9 days')
      `;
    }

    // Emergency access taken two hours ago, still running, and she has been
    // told: the portal owes her the alert whether or not she asks for it.
    const emergencyReason = 'Brought in unconscious; needs her allergies and recent reports now';
    const [emergency] = await tx<Array<{ id: string }>>`
      INSERT INTO consent_artefact (patient_id, grantee_hospital_id, purpose, data_categories, granted_at,
                                    expires_at, capture_method, recorded_by_staff_id, status,
                                    emergency_reason, patient_notified_at)
      VALUES (${lakshmi}, ${cityGeneral}, 'care_management',
              ARRAY['encounters','diagnoses','medications','allergies','observations','notes','procedures','documents']::clinical_data_category[],
              now() - interval '2 hours', now() + interval '4 hours', 'break_glass',
              ${gastroenterologist}, 'active', ${emergencyReason},
              now() - interval '2 hours' + interval '40 seconds')
      RETURNING id
    `;
    await tx`
      INSERT INTO access_log (actor_id, actor_type, actor_label, hospital_id, patient_id, resource_type,
                              action, outcome, consent_artefact_id, break_glass_reason, route, at)
      VALUES (${gastroenterologist}, 'staff', 'Arun Nair', ${cityGeneral}, ${lakshmi},
              'allergy_intolerance', 'read', 'allowed', ${emergency!.id}, ${emergencyReason},
              '/api/v1/patients/:id/timeline', now() - interval '2 hours')
    `;
  });
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('The end-to-end fixture never runs in production');
  }

  await createDatabase();

  const admin = postgres(ownerUrl(DATABASE), { max: 1, onnotice: () => {} });

  try {
    await migrateAndGrant(admin);
    await emptyEverything(admin);
    await seed(admin);
  } finally {
    await admin.end({ timeout: 5 });
  }

  mkdirSync(path.dirname(STAFF_FILE), { recursive: true });
  writeFileSync(STAFF_FILE, JSON.stringify(accounts, null, 2), 'utf8');

  console.log(
    `Seeded ${DATABASE}: Lakshmi Iyer and Ganesh Iyer on ${PHONE}, ${accounts.length} staff in ${STAFF_FILE}`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
