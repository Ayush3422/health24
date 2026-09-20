import { expect, test } from '@playwright/test';
import {
  GANESH,
  LAKSHMI,
  PHONE,
  forgetSignInCodes,
  messages,
  signIn,
  waitForCode,
} from './fixture';

/**
 * Signing in (sp5-plan.md, Decision J1): a mobile number, a code by text
 * message, and — because a household shares a phone — whose record to open.
 */
test.describe('signing in', () => {
  test('a code by text message opens her record', async ({ page }) => {
    await signIn(page, LAKSHMI);

    await expect(page.getByRole('heading', { name: 'Hello, Lakshmi' })).toBeVisible();
    await expect(page.getByText('Penicillin V')).toBeVisible();
  });

  test('the same phone opens the other record it was given', async ({ page }) => {
    await signIn(page, GANESH);

    await expect(page.getByRole('heading', { name: 'Hello, Ganesh' })).toBeVisible();
    // Nothing of hers is on his screen.
    await expect(page.getByText('Penicillin V')).toHaveCount(0);
  });

  test('a wrong code is refused, and the right one still opens the door', async ({ page }) => {
    await forgetSignInCodes();
    const sentBefore = messages().length;

    await page.goto('/');
    await page.getByLabel('Mobile number').fill(PHONE);
    await page.getByRole('button', { name: 'Send code' }).click();

    const code = await waitForCode(sentBefore);
    const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, '0');

    await page.getByLabel('6-digit code').fill(wrong);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('alert')).toContainText('wrong or has expired');

    // Wrong once is not spent: five attempts, five minutes (DF1).
    await page.getByLabel('6-digit code').fill(code);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: 'Whose record?' })).toBeVisible();
  });

  test('signing out leaves nothing behind on the phone', async ({ page }) => {
    await signIn(page);

    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

    // Not merely a screen: reopening the portal asks for a number again.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  });
});
