import { expect, test } from '@playwright/test';
import { LAKSHMI, openNav, seeded, signIn } from './fixture';

/**
 * The lab's worklist in a browser (sp6-plan.md, T25).
 *
 * What the desk actually does: opens the list, sees what is waiting and how
 * long it has waited, and moves one order along as the sample reaches them.
 */
test.describe('the order worklist', () => {
  test('shows what is outstanding, and moves an order along', async ({ page }) => {
    await signIn(page, 'cityDesk');
    await openNav(page, 'Orders', 'Order worklist');

    const order = page.locator('.entry', { hasText: seeded().orderDisplay }).first();

    await expect(order).toBeVisible();
    await expect(order.getByText('Urgent')).toBeVisible();
    await expect(order.getByRole('link', { name: LAKSHMI })).toBeVisible();
    await expect(order.getByText('Ordered', { exact: true })).toBeVisible();

    // The sample arrives, and the list says so.
    await order.getByRole('button', { name: 'Sample collected' }).click();
    await expect(order.getByText('Sample collected', { exact: true })).toBeVisible();

    // Work starts, and the order is still outstanding until a result lands.
    await order.getByRole('button', { name: 'Start work' }).click();
    await expect(order.getByText('In progress', { exact: true })).toBeVisible();

    // Filtering to finished work leaves it out, which is the point of the list.
    await page.getByLabel('Step').selectOption('resulted');
    await expect(page.locator('.entry', { hasText: seeded().orderDisplay })).toHaveCount(0);
  });
});
