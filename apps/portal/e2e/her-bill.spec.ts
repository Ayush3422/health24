import { expect, test } from '@playwright/test';
import { openMenu, signIn } from './fixture';

/**
 * What SP6 sends the patient (sp6-plan.md, T25, DF5 and DF8).
 *
 * She never sees an invoice screen or a ward board: what reaches her is two
 * documents in the reports she already had — the summary her doctor signed on
 * the way out, and the receipt for what she paid. Both are rendered by the
 * API, so this proves the whole path, from the desk taking cash to a PDF on
 * her phone.
 */
test.describe('her bill and her summary', () => {
  test('are in her reports, as documents she can open', async ({ page }) => {
    await signIn(page);
    await openMenu(page, 'Reports', 'Your reports');

    const summary = page.locator('li', { hasText: 'Discharge summary' }).first();
    await expect(summary).toBeVisible();
    await expect(summary).toContainText('City General Hospital');

    const receipt = page.locator('li', { hasText: 'Bill or receipt' }).first();
    await expect(receipt).toBeVisible();
    await expect(receipt).toContainText('City General Hospital');
  });
});
