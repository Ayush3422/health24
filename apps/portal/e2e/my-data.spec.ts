import { expect, test } from '@playwright/test';
import { SANJEEVANI, openMenu, signIn } from './fixture';

/**
 * Her rights over her data (sp5-plan.md, Decision N1): a copy of the record to
 * take away, and a correction she can ask for — which goes to the hospital
 * that holds the detail, because a clinical record is never overwritten here.
 */
test.describe('my data', () => {
  test('she asks for a copy of her record, and it is prepared', async ({ page }) => {
    await signIn(page);
    await openMenu(page, 'My data', 'My data');

    await page.getByRole('button', { name: 'Prepare a copy of my record' }).click();
    await expect(page.getByText('Your copy is being prepared').first()).toBeVisible();

    // The worker builds it; the page waits for it without being told to.
    await expect(page.getByText('Ready').first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('button', { name: 'Download to read (PDF)' })).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Download for another hospital (FHIR)' }),
    ).toBeVisible();
  });

  test('she asks the hospital to correct a detail about her', async ({ page }) => {
    await signIn(page);
    await openMenu(page, 'My data', 'My data');

    await page.getByRole('button', { name: 'Ask for a correction' }).first().click();
    await page.getByLabel('Which hospital holds it?').selectOption({ label: SANJEEVANI });
    await page.getByLabel('What should be corrected?').selectOption('phone');
    await page.getByLabel('What should it say?').fill('9820055002');
    await page
      .getByLabel('Anything else they should know (optional)')
      .fill('New number since May.');
    await page.getByRole('button', { name: 'Send the request' }).click();

    await expect(page.getByText('Your request has been sent to the hospital')).toBeVisible();
    const asked = page.getByRole('listitem').filter({ hasText: 'Waiting' }).first();
    await expect(asked).toContainText('9820055002');
  });
});
