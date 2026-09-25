import { expect, test } from '@playwright/test';
import { openNav, signIn } from './fixture';
/**
 * The headers the browser is actually told to enforce (sp7-plan.md, T10).
 *
 * Asserted against the running dev server rather than the configuration that
 * produces it: a content security policy that breaks a screen breaks it
 * silently, so the suite that drives the screens is the right place to notice.
 */
test.describe('what the browser is told', () => {
  test('arrives with a policy, and the screens still work under it', async ({ page }) => {
    const response = await page.goto('/');
    const headers = response!.headers();

    expect(headers['content-security-policy']).toContain("default-src 'self'");
    expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(headers['content-security-policy']).toContain("object-src 'none'");
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['referrer-policy']).toBe('no-referrer');

    // And nothing the policy refused stopped the app from rendering.
    await expect(page.getByRole('heading', { name: 'Health24' })).toBeVisible();

    const refusals = [] as string[];
    page.on('console', (message) => {
      if (message.text().includes('Content Security Policy')) refusals.push(message.text());
    });

    await signIn(page, 'cityDesk');
    await openNav(page, 'Wards', 'Wards and beds');

    expect(refusals, 'the policy refused something the app needed').toEqual([]);
  });
});
