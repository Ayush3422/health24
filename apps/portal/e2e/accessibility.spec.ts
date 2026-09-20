import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { openMenu, signIn } from './fixture';

/**
 * WCAG 2.2 AA, on a 360-pixel screen (sp5-plan.md, DF9).
 *
 * A patient portal that a person cannot read, or cannot hit the buttons of, is
 * not a patient portal. axe finds what a machine can find — contrast, names,
 * roles, order — and the target check below holds the portal to the 44-pixel
 * promise, which is stricter than the 24 pixels WCAG asks for.
 */

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/** Every screen behind the menu, and the heading that says it has arrived. */
const SCREENS: Array<[string, string]> = [
  ['Home', 'Hello, Lakshmi'],
  ['History', 'Your health history'],
  ['Medicines', 'Your medicines'],
  ['Health problems', 'Your health problems'],
  ['Allergies', 'Your allergies'],
  ['Reports', 'Your reports'],
  ['Test results', 'Your test results'],
  ['Sharing', 'Sharing your record'],
  ['Who saw my record', 'Who saw my record'],
  ['Emergency card', 'Your emergency card'],
  ['My data', 'My data'],
  ['Switch record', 'Switch record'],
  ['Signed-in devices', 'Signed-in devices'],
];

/** What axe found, as lines a person can act on. */
async function failures(page: Page): Promise<string[]> {
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze();

  return violations.map(
    (violation) =>
      `${violation.id} (${violation.impact ?? 'unknown'}): ${violation.nodes
        .map((node) => node.target.join(' '))
        .join(', ')}`,
  );
}

/**
 * Buttons and links smaller than 44 pixels either way.
 *
 * Links inside a sentence are left out: WCAG exempts a target in a line of
 * text, and growing one would break the paragraph around it.
 */
async function smallTargets(page: Page): Promise<string[]> {
  return page.$$eval('main button, main a[href], header button, header a[href]', (elements) =>
    elements
      .filter((element) => {
        const styles = getComputedStyle(element);
        if (styles.display === 'none' || styles.visibility === 'hidden') return false;
        return !element.classList.contains('link') && !element.classList.contains('inline-link');
      })
      .map((element) => {
        const box = element.getBoundingClientRect();
        return { text: (element.textContent ?? '').trim().slice(0, 40), ...box.toJSON() };
      })
      .filter((box) => box.width > 0 && (box.height < 44 || box.width < 44))
      .map((box) => `${box.text}: ${Math.round(box.width)}×${Math.round(box.height)}`),
  );
}

test.describe('accessibility', () => {
  test('the sign-in screens', async ({ page }) => {
    await page.goto('/');
    expect(await failures(page)).toEqual([]);
    expect(await smallTargets(page)).toEqual([]);

    // And with a message on it, which is the moment colour is leaned on.
    await page.getByLabel('Mobile number').fill('9820000000');
    await page.getByRole('button', { name: 'Send code' }).click();
    await expect(page.getByRole('heading', { name: 'Enter your code' })).toBeVisible();
    expect(await failures(page)).toEqual([]);
  });

  test('every screen of her record', async ({ page }) => {
    await signIn(page);

    for (const [label, heading] of SCREENS) {
      await openMenu(page, label, heading);
      expect(await failures(page), `axe on ${heading}`).toEqual([]);
      expect(await smallTargets(page), `touch targets on ${heading}`).toEqual([]);
    }
  });

  test('a lab value over time, chart and all', async ({ page }) => {
    await signIn(page);
    await openMenu(page, 'Test results', 'Your test results');
    await page
      .getByRole('link', { name: /ALT \(SGPT\): see how it has changed/ })
      .first()
      .click();
    await expect(page.getByRole('heading', { name: 'ALT (SGPT)', level: 1 })).toBeVisible();

    expect(await failures(page)).toEqual([]);
  });

  test('the emergency page, which a stranger reads under pressure', async ({ page, context }) => {
    await signIn(page);
    await openMenu(page, 'Emergency card', 'Your emergency card');

    const created = page.waitForResponse(
      (response) =>
        response.url().endsWith('/portal/emergency-card') && response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Create my card' }).click();
    await expect(page.getByRole('status')).toContainText('Your emergency card is ready');
    const { token } = (await (await created).json()) as { token: string };

    expect(await failures(page), 'axe on the card itself').toEqual([]);

    const stranger = await context.browser()!.newContext();
    const theirs = await stranger.newPage();

    try {
      await theirs.goto(new URL(`/e/${token}`, page.url()).toString());
      await expect(
        theirs.getByRole('heading', { name: 'Emergency medical information' }),
      ).toBeVisible();
      expect(await failures(theirs)).toEqual([]);

      // And when the code no longer works, which is a page of its own.
      await theirs.goto(new URL('/e/not-a-card-anybody-has', page.url()).toString());
      await expect(theirs.getByRole('alert')).toContainText('not in use');
      expect(await failures(theirs)).toEqual([]);
    } finally {
      await stranger.close();
    }

    // Left as it was found: the next test makes its own card.
    await page.getByRole('button', { name: 'Turn off my card' }).click();
    await page.getByRole('button', { name: 'Yes, turn it off' }).click();
    await expect(page.getByRole('status')).toContainText('Your emergency card is turned off');
  });
});
