import { expect, test } from '@playwright/test';
import { CITY_GENERAL, EMERGENCY_REASON, openMenu, signIn } from './fixture';

/**
 * Sharing, and the record of who used it (sp5-plan.md, Decisions K1 and DF6):
 * she lets City General see part of her record, sees that it was read and on
 * what it rested, and stops it — which takes effect at once.
 */
test.describe('sharing her record', () => {
  test('she shares four kinds of record with City General, then stops', async ({ page }) => {
    await signIn(page);
    await openMenu(page, 'Sharing', 'Sharing your record');

    await page.getByRole('button', { name: 'Share my records with a hospital' }).click();
    await page.getByRole('radio', { name: CITY_GENERAL }).check();

    for (const kind of ['Diagnoses', 'Medicines', 'Allergies', 'Test results and vitals']) {
      await page.getByRole('checkbox', { name: kind, exact: true }).check();
    }
    await page.getByLabel('For how long?').selectOption('180');

    // What it will mean, before she agrees to it.
    await expect(page.getByText(`${CITY_GENERAL} will see your`)).toBeVisible();

    await page.getByRole('button', { name: 'Share', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('can now see what you chose');

    const shared = page.locator('section', {
      has: page.getByRole('heading', { name: 'Shared now' }),
    });
    const consent = shared.getByRole('listitem').filter({ hasText: CITY_GENERAL }).first();
    await expect(consent).toContainText('You shared this on');
    await expect(consent).toContainText('Diagnoses');

    // And stopping it is hers alone, with immediate effect.
    await consent.getByRole('button', { name: 'Stop sharing' }).click();
    await page.getByRole('button', { name: 'Yes, stop sharing' }).click();
    await expect(page.getByRole('status')).toContainText('can no longer see your records');

    const past = page.locator('section', {
      has: page.getByRole('heading', { name: 'Earlier sharing' }),
    });
    await expect(
      past.getByRole('listitem').filter({ hasText: 'You stopped it' }).first(),
    ).toBeVisible();
  });

  test('emergency access is never out of sight', async ({ page }) => {
    await signIn(page);

    // On the home screen, before she looks for it (DF10).
    await expect(
      page.getByRole('heading', { name: 'Emergency access to your record' }),
    ).toBeVisible();
    await page.getByRole('link', { name: 'See who, and why' }).click();

    await expect(page.getByRole('heading', { name: 'Who saw my record', level: 1 })).toBeVisible();
    await expect(page.getByText(EMERGENCY_REASON).first()).toBeVisible();
    await expect(page.getByText('We sent you a text message about it')).toBeVisible();
  });

  test('the history names who read her record, and what allowed it', async ({ page }) => {
    await signIn(page);
    await openMenu(page, 'Who saw my record', 'Who saw my record');

    // Not the emergency access, which says why it was taken: the ordinary
    // reading, which rested on the sharing she had set up.
    const byTheGastroenterologist = page
      .getByRole('listitem')
      .filter({ hasText: 'Arun Nair' })
      .filter({ hasText: CITY_GENERAL })
      .filter({ hasNotText: 'Reason given' })
      .first();

    await expect(byTheGastroenterologist).toContainText('Clinician');
    await expect(byTheGastroenterologist).toContainText('Looked at');
    await expect(byTheGastroenterologist).toContainText('Allowed by the sharing you set up on');
  });
});
