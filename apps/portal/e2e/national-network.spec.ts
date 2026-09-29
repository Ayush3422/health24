import { expect, test } from '@playwright/test';
import { openMenu, seededAbdm, signIn } from './fixture';

/**
 * What the patient sees of the national network (sp8-plan.md, T32, T33, T34).
 *
 * This is the test the phase exists for. A consent she gave in her ABHA app
 * caused records to leave this hospital, and the promise SP5 made — that she
 * can see who has looked at her record — has to hold for a requester on the
 * national network exactly as it holds for a hospital. "The system read your
 * record" would not be an answer she could do anything with.
 */
test.describe('her record on the national network', () => {
  test('the access history names the requester that received her records', async ({ page }) => {
    const { requesterName } = seededAbdm();

    await signIn(page);
    await openMenu(page, 'Who saw my record', 'Who saw my record');

    // The transfer runs in the worker, so the entry may arrive a moment after
    // the page does. Reloading is what a patient would do, and it is what the
    // test does rather than asserting on a race.
    await expect(async () => {
      await page.reload();
      await expect(page.getByText(requesterName).first()).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 60_000 });
  });

  test('the consent from her ABHA app sits beside the ones she gave here', async ({ page }) => {
    const { requesterName } = seededAbdm();

    await signIn(page);
    await openMenu(page, 'Sharing', 'Sharing your record');

    const consent = page.locator('li', { hasText: requesterName }).first();
    await expect(consent).toBeVisible();

    // Told apart from a consent recorded at a desk, because it was not.
    await expect(consent).toContainText('National network');
    await expect(consent).toContainText('from your ABHA app');
  });

  test('she can stop it here, and is told plainly what that does not do', async ({ page }) => {
    const { requesterName } = seededAbdm();

    await signIn(page);
    await openMenu(page, 'Sharing', 'Sharing your record');

    const consent = page.locator('li', { hasText: requesterName }).first();
    await consent.getByRole('button', { name: 'Stop sharing', exact: true }).click();

    // The honest half, said before the button rather than after: stopping it
    // here is immediate and partial.
    await expect(consent).toContainText('To end it everywhere, revoke it in your ABHA app');

    await consent.getByRole('button', { name: 'Yes, stop sharing' }).click();

    await expect(page.getByRole('status')).toBeVisible();
  });
});
