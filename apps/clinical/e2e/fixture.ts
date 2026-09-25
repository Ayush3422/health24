import { readFileSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';
import * as OTPAuth from 'otpauth';

/**
 * Being a member of staff at a workstation (sp6-plan.md, T25).
 *
 * The accounts are written by `apps/api/src/db/e2e-fixture.ts` and the SP6
 * record by `apps/portal/e2e/seed-sp6.ts`, both against a throwaway database
 * that exists only while these tests run. The password below is a fixture
 * string; nothing here is a real credential.
 *
 * Signing in is done through the screen rather than by planting a token,
 * because the second factor and the session are part of what SP1 promised and
 * every later screen depends on.
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
  invoiceTotalPaise: number;
  invoiceNumber: string;
  orderDisplay: string;
  ward: string;
  bed: string;
};

export const LAKSHMI = 'Lakshmi Iyer';
export const CITY_GENERAL = 'City General Hospital';

function readJson<T>(variable: string): T {
  const file = process.env[variable];
  if (!file) throw new Error(`${variable} is not set — the global setup did not run`);

  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

export function staffNamed(key: string): FixtureStaff {
  const found = readJson<FixtureStaff[]>('E2E_STAFF_FILE').find((account) => account.key === key);
  if (!found) throw new Error(`No fixture staff account called ${key}`);

  return found;
}

/** What SP6 left on the screens: the invoice, the order, the occupied bed. */
export function seeded(): SeededSp6 {
  return readJson<SeededSp6>('E2E_SP6_FILE');
}

/** Rupees as the screens print them: 601000 paise → "₹6,010.00". */
export function rupees(paise: number): string {
  const rupeePart = Math.floor(Math.abs(paise) / 100).toLocaleString('en-IN');
  const paisePart = String(Math.abs(paise) % 100).padStart(2, '0');

  return `${paise < 0 ? '-' : ''}₹${rupeePart}.${paisePart}`;
}

/** Signs in on this page as one of the fixture staff, second factor and all. */
export async function signIn(page: Page, key: string): Promise<FixtureStaff> {
  const staff = staffNamed(key);

  await page.goto('/');
  await page.getByLabel('Email').fill(staff.email);
  await page.getByLabel('Password').fill(staff.password);
  await page.getByRole('button', { name: 'Continue' }).click();

  const code = new OTPAuth.TOTP({
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(staff.totpSecret),
  }).generate();

  await page.getByLabel('Code', { exact: true }).fill(code);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page.getByText(staff.name).first()).toBeVisible();

  return staff;
}

/** Follows a link in the top navigation, and waits for the screen it opens. */
export async function openNav(page: Page, label: string, heading: string): Promise<void> {
  await page.getByRole('navigation').getByRole('link', { name: label, exact: true }).click();
  await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
}
