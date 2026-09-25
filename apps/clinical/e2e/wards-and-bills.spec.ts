import { expect, test } from '@playwright/test';
import { LAKSHMI, openNav, rupees, seeded, signIn } from './fixture';

/**
 * The ward board and the money screens (sp6-plan.md, T25).
 *
 * The two things a front desk looks at all day: where the patients are, and
 * what is still owed. Both are read here as the desk reads them, and the
 * figures are checked against what the API actually recorded.
 */
test.describe('the ward board', () => {
  test('shows who is in which bed, and which beds are free', async ({ page }) => {
    await signIn(page, 'cityDesk');
    await openNav(page, 'Wards', 'Wards and beds');

    const ward = page.locator('section.card', { hasText: seeded().ward });
    await expect(ward).toBeVisible();
    await expect(ward.getByText('1 occupied · 1 free')).toBeVisible();

    const occupied = ward.locator('.bed--occupied');
    await expect(occupied).toHaveCount(1);
    await expect(occupied).toContainText(seeded().bed);
    await expect(occupied.getByRole('link', { name: LAKSHMI })).toBeVisible();

    // The bed she left is free again, and offered for the next patient.
    await expect(ward.locator('.bed--free')).toHaveCount(1);
  });
});

test.describe('the price list', () => {
  test('shows what the hospital charges, at the price in force', async ({ page }) => {
    await signIn(page, 'cityAdmin');
    await openNav(page, 'Price list', 'Price list');

    const bedDay = page.getByRole('row', { name: /BED-DAY/ });
    await expect(bedDay).toContainText('General ward bed');
    await expect(bedDay).toContainText(rupees(120000));
    await expect(bedDay).toContainText('In force');

    await expect(page.getByRole('row', { name: /LAB-LFT/ })).toContainText(rupees(60000));
  });
});

test.describe('the bills screen', () => {
  test('shows what is still owed, to the paisa, and the invoice behind it', async ({ page }) => {
    const { invoiceNumber, invoiceTotalPaise } = seeded();
    const paid = Math.floor(invoiceTotalPaise / 2);

    await signIn(page, 'cityDesk');
    await openNav(page, 'Bills', 'Bills');

    const row = page.getByRole('row', { name: new RegExp(invoiceNumber.replace('/', '\\/')) });
    await expect(row).toContainText(LAKSHMI);
    await expect(row).toContainText(rupees(invoiceTotalPaise));
    await expect(row).toContainText(rupees(invoiceTotalPaise - paid));
    await expect(row).toContainText('Part paid');

    // Opening it shows the lines it was made of, and the money taken so far.
    await row.getByRole('button', { name: invoiceNumber }).click();
    await expect(page.getByText('Endoscopic procedure')).toBeVisible();
    await expect(page.getByText(rupees(paid)).first()).toBeVisible();
  });
});
