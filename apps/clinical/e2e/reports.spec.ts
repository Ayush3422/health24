import { expect, test } from '@playwright/test';
import { openNav, rupees, seeded, signIn } from './fixture';

/**
 * The hospital's own numbers, and the return it owes (sp6-plan.md, T25).
 *
 * The administrator's screens: what the month looked like, what the record
 * has left unfinished, and the Ayush morbidity return generated, read and
 * recorded as submitted.
 */
test.describe('reports', () => {
  test('counts the month, and each tab answers its own question', async ({ page }) => {
    await signIn(page, 'cityAdmin');
    await openNav(page, 'Reports', 'Reports');

    // Visits: two inpatient encounters today, and a chart of the days.
    await expect(page.getByRole('img', { name: /Encounters:/ })).toBeVisible();

    // Both of this stay's encounters, beside whatever else the month held.
    const visits = page.locator('.figure', { hasText: 'Encounters in the period' });
    await expect(visits.locator('.figure__value')).toHaveText(/[1-9]\d*/);

    await page.getByLabel('Broken down by').selectOption('class');
    await expect(page.getByRole('row', { name: /^Inpatient/ })).toContainText('2');

    // Money: the invoice that was raised, and the half that was paid.
    const { invoiceTotalPaise } = seeded();
    await page.getByRole('tab', { name: 'Money' }).click();

    await expect(
      page.locator('.figure', { hasText: 'Invoiced' }).locator('.figure__value'),
    ).toHaveText(rupees(invoiceTotalPaise));
    await expect(
      page.locator('.figure', { hasText: 'Still owed' }).locator('.figure__value'),
    ).toHaveText(rupees(invoiceTotalPaise - Math.floor(invoiceTotalPaise / 2)));
    await expect(page.getByRole('row', { name: /Cash/i })).toBeVisible();

    // What is unfinished: the order nobody has resulted, said plainly.
    await page.getByRole('tab', { name: 'What is unfinished' }).click();
    await expect(page.getByText('As the record stands now')).toBeVisible();
    await expect(page.locator('.quality-list li').first()).toBeVisible();
  });

  test('refuses a period that ends before it starts, rather than counting one', async ({
    page,
  }) => {
    await signIn(page, 'cityAdmin');
    await openNav(page, 'Reports', 'Reports');

    await page.getByLabel('From').fill('2027-01-01');
    await expect(page.getByText('The period ends before it starts')).toBeVisible();
  });
});

test.describe('the Ayush morbidity return', () => {
  test('is generated, read, and recorded as submitted', async ({ page }) => {
    await signIn(page, 'ayushAdmin');
    await openNav(page, 'Returns', 'Statutory returns');

    await expect(page.getByText('No return has been generated yet.')).toBeVisible();

    // Her Amlapitta was recorded two months ago, so the period reaches back.
    await page.getByLabel('From').fill(monthsAgo(3));
    await page.getByLabel('To').fill(today());
    await page.getByRole('button', { name: 'Generate it' }).click();

    const counted = page.locator('section.card').getByRole('row', { name: /AYU-AMLAPITTA/ });
    await expect(counted).toContainText('Amlapitta');
    await expect(counted).toContainText('Not mapped');
    await expect(page.getByRole('row', { name: /Not yet/ })).toBeVisible();

    // Sent to the ministry, and the acknowledgement written down.
    await page.getByLabel('Acknowledgement number').fill('AYUSH/2026/01192');
    await page.getByRole('button', { name: 'It was submitted' }).click();

    await expect(page.getByRole('row', { name: /Submitted/ })).toBeVisible();
    await expect(page.getByText('AYUSH/2026/01192').first()).toBeVisible();

    // And what was sent cannot be sent again.
    await expect(page.getByRole('button', { name: 'It was submitted' })).toHaveCount(0);
  });
});

const istDay = (offsetDays = 0): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(
    new Date(Date.now() + offsetDays * 86_400_000),
  );

const today = () => istDay();
const monthsAgo = (months: number) => istDay(-months * 31);
