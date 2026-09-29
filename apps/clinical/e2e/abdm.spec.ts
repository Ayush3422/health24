import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { LAKSHMI, openNav, seededAbdm, signIn } from './fixture';

/** The search is live and the row's link is the hospital number, not the name. */
async function openPatient(page: Page): Promise<void> {
  await openNav(page, 'Patients', 'Patients');
  await page.getByLabel('Search patients').fill('Lakshmi');
  await page.getByRole('row', { name: new RegExp(LAKSHMI) }).getByRole('link').click();
}

/**
 * ABDM, as the desk sees it (sp8-plan.md, T31, T34).
 *
 * The record these screens read was arranged the way it happens: the desk
 * confirmed her ABHA against the mock gateway, offered a visit to the
 * national network, and she answered a code (`seed-sp8.ts`). What this test
 * checks is that the screens then say the true thing about it — in
 * particular the distinction the whole of Phase 1 is about, between an ABHA
 * somebody typed and one the registry confirmed.
 */
test.describe('the ABDM tab', () => {
  test('says the ABHA is confirmed, and which visit the country can find', async ({ page }) => {
    const { abhaAddress, careContextDisplay } = seededAbdm();

    await signIn(page, 'cityDesk');
    await openPatient(page);

    // The overview says it before anybody opens the tab: an ABHA that was
    // confirmed and one that was typed must never look the same.
    await expect(page.getByText('Verified', { exact: true })).toBeVisible();

    await page.getByRole('link', { name: 'ABDM' }).click();

    const abha = page.locator('section', { has: page.getByRole('heading', { name: 'ABHA' }) });
    await expect(abha).toContainText(abhaAddress);
    await expect(abha).toContainText('Verified with the patient');
    // And it cannot be edited afterwards, which the screen says rather than
    // leaving somebody to find out by trying.
    await expect(abha).toContainText('cannot be edited');

    const visits = page.locator('section', {
      has: page.getByRole('heading', { name: 'Visits shared with ABDM' }),
    });

    await expect(visits).toContainText(careContextDisplay);
    await expect(visits.getByText(/^Shared since /)).toBeVisible();

    // What sharing a visit actually means, said on the screen that does it.
    await expect(visits).toContainText('any hospital in the country');
    await expect(visits).toContainText('Nothing is shared until the patient answers a code');
  });

  test('a shared visit can be withdrawn, and the screen is honest about what that does', async ({
    page,
  }) => {
    await signIn(page, 'cityDesk');
    await openPatient(page);
    await page.getByRole('link', { name: 'ABDM' }).click();

    const visits = page.locator('section', {
      has: page.getByRole('heading', { name: 'Visits shared with ABDM' }),
    });

    await visits.getByRole('button', { name: 'Stop sharing' }).first().click();

    // The caveat before the button, not after: unlinking stops this hospital
    // offering the visit; a consent the patient already gave ends in their
    // ABHA app.
    await expect(visits).toContainText('ended in their ABHA app, not here');

    await visits.getByLabel('Why it is being unshared').fill('She asked us to stop');
    await visits.getByRole('button', { name: 'Stop sharing' }).click();

    await expect(visits.getByText('Not shared').first()).toBeVisible();
  });
});
