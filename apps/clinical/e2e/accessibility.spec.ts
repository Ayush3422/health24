import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { openNav, signIn } from './fixture';

/**
 * WCAG 2.2 AA on the SP6 screens (sp6-plan.md, T25).
 *
 * The clinical app is used all day, often by somebody tired, on whatever
 * machine the ward has. axe finds what a machine can find — contrast, names,
 * roles, order — which is not everything, but it is the part that regresses
 * silently as screens change.
 *
 * Desktop-sized rather than a phone: this is what a ward or a front desk has
 * in front of them, so the 44-pixel target rule the portal holds itself to is
 * not applied here.
 */

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/**
 * The screens SP6 added, by the person who has them.
 *
 * The navigation is filtered by the permission matrix, so no one account sees
 * all of these: the lab worklist is the desk's, the reports are the
 * administrator's, and the wards and the bills are both.
 */
const SCREENS: Array<[string, Array<[string, string]>]> = [
  [
    'cityDesk',
    [
      ['Orders', 'Order worklist'],
      ['Wards', 'Wards and beds'],
      ['Bills', 'Bills'],
    ],
  ],
  [
    'cityAdmin',
    [
      ['Price list', 'Price list'],
      ['Reports', 'Reports'],
      ['Returns', 'Statutory returns'],
    ],
  ],
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

test.describe('the SP6 screens', () => {
  for (const [who, screens] of SCREENS) {
    test(`meet WCAG 2.2 AA for the ${who} account`, async ({ page }) => {
      await signIn(page, who);

      for (const [label, heading] of screens) {
        await openNav(page, label, heading);
        expect(await failures(page), `${label} has accessibility failures`).toEqual([]);
      }
    });
  }

  test('say what each report is, in words, not only as a picture', async ({ page }) => {
    await signIn(page, 'cityAdmin');
    await openNav(page, 'Reports', 'Reports');

    // The chart carries a description, and the numbers behind it are in a
    // table anybody can open — the shape is never the only copy.
    await expect(page.getByRole('img', { name: /Encounters: .* at most, on / })).toBeVisible();

    await page.getByText('The numbers, day by day').click();
    await expect(page.getByRole('table', { name: 'Encounters', exact: true })).toBeVisible();
  });
});
