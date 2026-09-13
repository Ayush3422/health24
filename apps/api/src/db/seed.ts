import argon2 from 'argon2';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { loadEnv } from '../config/load-env';
import * as schema from './schema';
import type { DbTransaction } from './client';

loadEnv();

/**
 * Development seed.
 *
 * Creates one platform admin, two hospitals — one Ayush, one allopathic,
 * which is the pairing the whole product exists to bridge — and staff in each.
 *
 * Refuses to run against production. Seeded accounts share a well-known
 * password, which is exactly why this must never touch a real deployment.
 */

const SEED_PASSWORD = 'health24-dev-password';

/**
 * Medical records staff for each seeded hospital. Ensured on every run, so a
 * database seeded before the role existed gains them.
 */
async function ensureRecordsStaff(tx: DbTransaction, passwordHash: string): Promise<void> {
  const hospitals = await tx
    .select({ id: schema.hospitals.id, mrnPrefix: schema.hospitals.mrnPrefix })
    .from(schema.hospitals);

  const byPrefix = new Map(hospitals.map((hospital) => [hospital.mrnPrefix, hospital.id]));

  const accounts = [
    { prefix: 'SAH', name: 'Sunita Pawar (records)', email: 'records@sanjeevani.example.in' },
    { prefix: 'CGH', name: 'Ravi Kulkarni (records)', email: 'records@citygeneral.example.in' },
  ].flatMap((account) => {
    const hospitalId = byPrefix.get(account.prefix);

    return hospitalId
      ? [
          {
            hospitalId,
            name: account.name,
            email: account.email,
            role: 'medical_records' as const,
            status: 'active' as const,
            passwordHash,
          },
        ]
      : [];
  });

  if (accounts.length > 0) {
    await tx.insert(schema.staffUsers).values(accounts).onConflictDoNothing();
  }
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed a production database');
  }

  const url = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;

  if (!url) {
    throw new Error('DATABASE_ADMIN_URL is not set');
  }

  const client = postgres(url, { max: 1, onnotice: () => {} });
  const db = drizzle(client, { schema });

  const passwordHash = await argon2.hash(SEED_PASSWORD, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });

  await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.system_context', 'on', true)`);

    // Two curators, because a mapping cannot be approved by the curator who
    // proposed it — demonstrating review takes a second pair of eyes. Ensured
    // on every run, so a database seeded before curators existed gains them.
    const curators = await tx
      .insert(schema.staffUsers)
      .values([
        {
          hospitalId: null,
          name: 'Vaidya Anjali Kulkarni (curator)',
          email: 'curator.anjali@health24.example.in',
          role: 'terminology_curator',
          status: 'active',
          passwordHash,
        },
        {
          hospitalId: null,
          name: 'Vaidya Rohan Deshpande (curator)',
          email: 'curator.rohan@health24.example.in',
          role: 'terminology_curator',
          status: 'active',
          passwordHash,
        },
      ])
      .onConflictDoNothing()
      .returning({ id: schema.staffUsers.id });

    if (curators.length > 0) {
      console.log(`Added ${curators.length} terminology curator account(s).`);
    }

    const existing = await tx.select({ id: schema.hospitals.id }).from(schema.hospitals).limit(1);

    if (existing.length > 0) {
      await ensureRecordsStaff(tx, passwordHash);
      console.log('Hospitals already seeded; records staff ensured.');
      return;
    }

    const [ayush] = await tx
      .insert(schema.hospitals)
      .values({
        name: 'Sanjeevani Ayurvedic Hospital',
        facilityType: 'ayush',
        contactEmail: 'contact@sanjeevani.example.in',
        contactPhone: '+919812345670',
        mrnPrefix: 'SAH',
        status: 'active',
        address: { city: 'Pune', state: 'Maharashtra', pincode: '411001' },
      })
      .returning({ id: schema.hospitals.id });

    const [allopathic] = await tx
      .insert(schema.hospitals)
      .values({
        name: 'City General Hospital',
        facilityType: 'allopathic',
        contactEmail: 'contact@citygeneral.example.in',
        contactPhone: '+919812345671',
        mrnPrefix: 'CGH',
        status: 'active',
        address: { city: 'Pune', state: 'Maharashtra', pincode: '411004' },
      })
      .returning({ id: schema.hospitals.id });

    if (!ayush || !allopathic) {
      throw new Error('Failed to create seed hospitals');
    }

    await tx.insert(schema.staffUsers).values([
      {
        hospitalId: null,
        name: 'Platform Admin',
        email: 'admin@health24.example.in',
        role: 'platform_admin',
        status: 'active',
        passwordHash,
      },
      {
        hospitalId: ayush.id,
        name: 'Dr. Meera Joshi',
        email: 'meera@sanjeevani.example.in',
        role: 'clinician',
        systemOfMedicine: 'ayurveda',
        status: 'active',
        passwordHash,
      },
      {
        hospitalId: ayush.id,
        name: 'Sanjeevani Front Desk',
        email: 'reception@sanjeevani.example.in',
        role: 'front_desk',
        status: 'active',
        passwordHash,
      },
      {
        hospitalId: ayush.id,
        name: 'Sanjeevani Admin',
        email: 'admin@sanjeevani.example.in',
        role: 'hospital_admin',
        status: 'active',
        passwordHash,
      },
      {
        hospitalId: allopathic.id,
        name: 'Dr. Arun Nair',
        email: 'arun@citygeneral.example.in',
        role: 'clinician',
        systemOfMedicine: 'allopathy',
        status: 'active',
        passwordHash,
      },
      {
        hospitalId: allopathic.id,
        name: 'City General Front Desk',
        email: 'reception@citygeneral.example.in',
        role: 'front_desk',
        status: 'active',
        passwordHash,
      },
    ]);

    await ensureRecordsStaff(tx, passwordHash);
    console.log('Seeded 2 hospitals, 6 staff accounts and 2 records staff.');
    console.log(`All seed accounts use the password: ${SEED_PASSWORD}`);
    console.log('Each will be required to enrol a second factor on first sign-in.');
  });

  await client.end();
}

main().catch((error: unknown) => {
  console.error('Seed failed:', error);
  process.exitCode = 1;
});
