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

  /*
   * The check that was missing, and that a review found in a browser
   * (sp7-plan.md, T23).
   *
   * Every document is read back from object storage and uploaded straight to
   * it, so a policy that names only the app's own origin leaves the viewer
   * blank and an upload unable to start — silently, because a refused subresource
   * is a console message nobody is watching.
   */
  test('lets a document be loaded from storage, which is where documents are', async ({ page }) => {
    await page.goto('/');

    const refusals: string[] = [];
    page.on('console', (message) => {
      if (/Content Security Policy/i.test(message.text())) refusals.push(message.text());
    });

    const storage = process.env.STORAGE_ENDPOINT ?? 'http://localhost:7070';

    // The request itself will 404 — there is no such object — but a refusal by
    // the policy is a different thing, and it is the thing being checked.
    await page.evaluate(async (origin) => {
      await new Promise((resolve) => {
        const image = new Image();
        image.onload = resolve;
        image.onerror = resolve;
        image.src = `${origin}/health24-documents/probe.png`;
        setTimeout(resolve, 2000);
      });

      await new Promise((resolve) => {
        const frame = document.createElement('iframe');
        frame.onload = resolve;
        frame.onerror = resolve;
        frame.src = `${origin}/health24-documents/probe.pdf`;
        document.body.appendChild(frame);
        setTimeout(resolve, 2000);
      });

      await fetch(`${origin}/health24-documents/probe.png`, { method: 'HEAD' }).catch(() => null);
    }, storage);

    expect(refusals, 'the policy refused something a document needs').toEqual([]);
  });
});
