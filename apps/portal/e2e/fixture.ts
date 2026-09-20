import { readFileSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';
import postgres from 'postgres';

/**
 * What the seeded record holds, and how a test becomes the patient.
 *
 * The record itself is arranged by `apps/api/src/db/e2e-fixture.ts`; the names
 * below are asserted on the screen, so the two files change together.
 */

export const PHONE = '9820055001';

export const LAKSHMI = 'Lakshmi Iyer';
export const GANESH = 'Ganesh Iyer';

export const SANJEEVANI = 'Sanjeevani Ayurvedic Hospital';
export const CITY_GENERAL = 'City General Hospital';

export const EMERGENCY_REASON =
  'Brought in unconscious; needs her allergies and recent reports now';

interface Message {
  to: string;
  body: string;
  template: string;
  at: string;
}

/** Every text message the API has sent this run — the patient's phone, in a file. */
export function messages(): Message[] {
  const file = process.env.SMS_LOG_FILE;
  if (!file) throw new Error('SMS_LOG_FILE is not set — the global setup did not run');

  let contents = '';
  try {
    contents = readFileSync(file, 'utf8');
  } catch {
    // Nothing sent yet.
  }

  return contents
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Message);
}

/**
 * The sign-in code of the next message sent after `sentBefore` messages.
 *
 * Codes are random and stored as a keyed hash, so there is nothing to look up:
 * reading the message is the only way to be the phone in the patient's hand.
 */
export async function waitForCode(sentBefore: number): Promise<string> {
  let code: string | undefined;

  await expect
    .poll(
      () => {
        const sent = messages()
          .slice(sentBefore)
          .filter((message) => message.template === 'otp' && message.to === `+91${PHONE}`);

        code = sent.at(-1)?.body.match(/^(\d{6}) /)?.[1];
        return code ?? null;
      },
      { message: 'waiting for the sign-in code', timeout: 15_000 },
    )
    .not.toBeNull();

  return code!;
}

/**
 * Clears the codes asked for so far.
 *
 * Three codes per number in fifteen minutes is a real control, proved at the
 * API level (sp5-plan.md, T22). It is not this suite's to re-prove, and
 * without this the fourth sign-in of the run would be refused.
 */
export async function forgetSignInCodes(): Promise<void> {
  const base = process.env.E2E_DATABASE_ADMIN_URL;
  if (!base) throw new Error('E2E_DATABASE_ADMIN_URL is not set — the global setup did not run');

  const client = postgres(base, { max: 1, onnotice: () => {} });

  try {
    await client`DELETE FROM otp_challenge`;
  } finally {
    await client.end({ timeout: 5 });
  }
}

/** Signs in on this page as the phone's owner, and opens one of its records. */
export async function signIn(page: Page, patient: string = LAKSHMI): Promise<void> {
  await forgetSignInCodes();
  const sentBefore = messages().length;

  await page.goto('/');
  await page.getByLabel('Mobile number').fill(PHONE);
  await page.getByRole('button', { name: 'Send code' }).click();

  const code = await waitForCode(sentBefore);
  await page.getByLabel('6-digit code').fill(code);
  await page.getByRole('button', { name: 'Continue' }).click();

  // The phone opens two records, so it always asks whose (Decision J1).
  await page.getByRole('button', { name: patient }).click();
  await expect(page.getByText(`Viewing the record of ${patient}`)).toBeVisible();
}

/** Follows a link in the menu, and waits for the screen it opens. */
export async function openMenu(page: Page, label: string, heading: string): Promise<void> {
  await page
    .getByRole('navigation', { name: 'Menu' })
    .getByRole('link', { name: label, exact: true })
    .click();
  await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
}
