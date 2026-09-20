import { expect, test } from '@playwright/test';
import { CITY_GENERAL, SANJEEVANI, openMenu, signIn } from './fixture';

/**
 * Her own record, from every hospital, without a consent anywhere: it is hers
 * (sp5-plan.md, DF4), and it is shown as her doctors wrote it (DF5).
 */
test.describe('her record', () => {
  test('shows what her hospitals recorded, in plain words', async ({ page }) => {
    await signIn(page);

    await expect(page.getByText('Penicillin V')).toBeVisible();
    await expect(page.getByText('High risk')).toBeVisible();
    await expect(page.getByText('Amlapitta', { exact: true })).toBeVisible();
    await expect(page.getByText('Avipattikar churna 5 g')).toBeVisible();

    // Both hospitals, on one screen, with no sharing set up.
    await expect(page.getByText(SANJEEVANI).first()).toBeVisible();
    await expect(page.getByText(CITY_GENERAL).first()).toBeVisible();

    await openMenu(page, 'History', 'Your health history');
    await expect(page.getByText('Burning after meals for three months')).toBeVisible();

    await openMenu(page, 'Medicines', 'Your medicines');
    await expect(page.getByText('Avipattikar churna').first()).toBeVisible();

    await openMenu(page, 'Allergies', 'Your allergies');
    await expect(page.getByText('Hives and facial swelling')).toBeVisible();

    await openMenu(page, 'Reports', 'Your reports');
    await expect(page.getByText('Ultrasound abdomen')).toBeVisible();
  });

  test('shows a lab value, and how it has changed', async ({ page }) => {
    await signIn(page);

    await openMenu(page, 'Test results', 'Your test results');
    await expect(page.getByText('ALT (SGPT)').first()).toBeVisible();

    // Every reading of the test links to the same trend; the newest is first.
    await page
      .getByRole('link', { name: /ALT \(SGPT\): see how it has changed/ })
      .first()
      .click();
    await expect(page.getByRole('heading', { name: 'ALT (SGPT)', level: 1 })).toBeVisible();

    // The chart is for the eye; every reading is written out beneath it.
    const readings = page.locator('.trend ul.items > li');
    await expect(readings).toHaveCount(3);
    await expect(readings.first()).toContainText('62 U/L');
    await expect(readings.first()).toContainText('Higher than the lab’s range');
  });
});
