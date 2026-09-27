import { describe, expect, it } from 'vitest';
import { securityHeaders } from './security-headers.js';

/**
 * The policy itself (sp7-plan.md, T10).
 *
 * A content security policy is easy to write and easy to weaken by accident —
 * one `'unsafe-inline'` added to make a screen work, and the protection is
 * gone for every screen. These assertions are the ones that would notice.
 */
describe('security headers', () => {
  describe('for an app in production', () => {
    const headers = securityHeaders('clinical');

    it('refuses to be framed, sniffed, or to leak a URL', () => {
      expect(headers['X-Frame-Options']).toBe('DENY');
      expect(headers['X-Content-Type-Options']).toBe('nosniff');
      expect(headers['Referrer-Policy']).toBe('no-referrer');
      expect(headers['Content-Security-Policy']).toContain("frame-ancestors 'none'");
    });

    it('allows no script but its own, and no plugin at all', () => {
      const policy = headers['Content-Security-Policy']!;

      expect(policy).toContain("script-src 'self'");
      expect(policy).not.toContain('unsafe-eval');
      // An inline style is the bundler's; an inline script is an injection.
      expect(policy).not.toMatch(/script-src[^;]*unsafe-inline/);
      expect(policy).toContain("object-src 'none'");
    });

    it('asks for HTTPS, and keeps asking', () => {
      expect(headers['Strict-Transport-Security']).toContain('max-age=63072000');
      expect(headers['Strict-Transport-Security']).toContain('includeSubDomains');
      expect(headers['Content-Security-Policy']).toContain('upgrade-insecure-requests');
    });
  });

  describe('for an app in development', () => {
    const headers = securityHeaders('portal', { development: true });

    it('keeps the storage origin while relaxing for the dev server', () => {
      // The development branch rewrites `connect-src` wholesale, and the first
      // version of it dropped the storage origin on the way — so an upload
      // worked in production and not on a laptop, which is the wrong way round
      // for finding out (sp7-plan.md, T23).
      const local = securityHeaders('clinical', {
        development: true,
        storageOrigin: 'http://localhost:7070',
      })['Content-Security-Policy']!;

      expect(local).toContain("connect-src 'self' http://localhost:7070 ws: wss:");
      expect(local).toContain('img-src');
      expect(local).toContain('http://localhost:7070');
    });

    it('relaxes exactly what the dev server needs, and nothing else', () => {
      const policy = headers['Content-Security-Policy']!;

      expect(policy).toContain('unsafe-eval');
      expect(policy).toContain('ws:');

      // Everything that is not about the bundler still applies on a laptop.
      expect(headers['X-Frame-Options']).toBe('DENY');
      expect(policy).toContain("object-src 'none'");
      expect(policy).toContain("frame-ancestors 'none'");
    });

    it('does not pin a browser to HTTPS it cannot reach', () => {
      expect(headers['Strict-Transport-Security']).toBeUndefined();
      expect(headers['Content-Security-Policy']).not.toContain('upgrade-insecure-requests');
    });
  });

  describe('where documents live', () => {
    const headers = securityHeaders('clinical', { storageOrigin: 'https://bucket.example' });
    const policy = headers['Content-Security-Policy']!;

    /*
     * Found by the Phase 6 review, in a browser: the policy as first written
     * refused every one of these, which left the document viewer blank and an
     * upload unable to start. A policy that breaks a screen is a policy
     * somebody switches off.
     */
    it('lets a document be read back from storage', () => {
      expect(policy).toContain("img-src 'self' data: blob: https://bucket.example");
      expect(policy).toContain("frame-src 'self' blob: https://bucket.example");
    });

    it('lets a file be uploaded straight to storage', () => {
      expect(policy).toContain("connect-src 'self' https://bucket.example");
    });

    it('names no origin when there is none to name', () => {
      const without = securityHeaders('clinical')['Content-Security-Policy']!;

      expect(without).toContain("img-src 'self' data: blob:;");
      expect(without).toContain("connect-src 'self';");
    });

    it('does not widen anything else', () => {
      expect(policy).toContain("script-src 'self'");
      expect(policy).toContain("default-src 'self'");
      expect(policy).toContain("object-src 'none'");
    });
  });

  describe('for the API', () => {
    const headers = securityHeaders('api');

    it('allows nothing at all: it serves JSON, which is never rendered', () => {
      const policy = headers['Content-Security-Policy']!;

      expect(policy).toContain("default-src 'none'");
      expect(policy).toContain('sandbox');
      expect(policy).toContain("form-action 'none'");
      expect(headers['X-Frame-Options']).toBe('DENY');
    });
  });
});
