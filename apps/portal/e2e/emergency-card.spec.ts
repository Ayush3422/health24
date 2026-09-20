import { expect, test } from '@playwright/test';
import { LAKSHMI, openMenu, signIn } from './fixture';

/**
 * The emergency card (sp5-plan.md, Decision L1): she chooses what it carries,
 * its code opens a page without signing in, every opening is in her history,
 * and turning it off stops the code at once.
 */
test('her emergency card, from making it to turning it off', async ({ page, context }) => {
  await signIn(page);
  await openMenu(page, 'Emergency card', 'Your emergency card');

  // Everything her record holds is offered; she carries two of them.
  await page.getByRole('checkbox', { name: 'Blood group' }).check();
  await page.getByRole('checkbox', { name: 'Allergies' }).check();
  await page.getByRole('checkbox', { name: 'Medicines' }).uncheck();
  await page.getByRole('checkbox', { name: 'Health problems being treated' }).uncheck();

  const created = page.waitForResponse(
    (response) =>
      response.url().endsWith('/portal/emergency-card') && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Create my card' }).click();
  await expect(page.getByRole('status')).toContainText('Your emergency card is ready');

  await expect(page.getByRole('article', { name: 'Your emergency card' })).toBeVisible();

  // The address the QR code carries. A phone reads it off the card; a test
  // takes it from the answer that made the card.
  const { token } = (await (await created).json()) as { token: string };

  // Whoever is treating her has the card in their hand, not her session.
  const casualty = await context.browser()!.newContext();
  const theirs = await casualty.newPage();
  await theirs.goto(new URL(`/e/${token}`, page.url()).toString());

  await expect(
    theirs.getByRole('heading', { name: 'Emergency medical information' }),
  ).toBeVisible();
  await expect(theirs.getByRole('heading', { name: LAKSHMI })).toBeVisible();
  await expect(theirs.getByText('Penicillin V')).toBeVisible();
  await expect(theirs.getByText('B+')).toBeVisible();
  // Only what she chose: her medicines were not on the card.
  await expect(theirs.getByText('Avipattikar churna')).toHaveCount(0);

  await openMenu(page, 'Who saw my record', 'Who saw my record');
  await expect(page.getByText('Someone opened your emergency card').first()).toBeVisible();

  await openMenu(page, 'Emergency card', 'Your emergency card');
  await page.getByRole('button', { name: 'Turn off my card' }).click();
  await page.getByRole('button', { name: 'Yes, turn it off' }).click();
  await expect(page.getByRole('status')).toContainText('Your emergency card is turned off');

  await theirs.reload();
  await expect(theirs.getByRole('alert')).toContainText('not in use');

  await casualty.close();
});
