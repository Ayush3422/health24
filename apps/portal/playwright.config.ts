import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import { PORTAL_PORT } from './e2e/global-setup';

/**
 * The portal in a browser (sp5-plan.md, T23).
 *
 * On a phone, because that is where a patient reads their record: a 360-pixel
 * screen is the width the portal is designed for (DF9), and these tests fail
 * if it stops working there.
 *
 * One worker, in order. The tests share one seeded record and change it —
 * sharing is granted and stopped, a card is made and turned off — and a second
 * worker would be a second person on the same phone.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: './e2e',
  globalSetup: path.resolve(HERE, 'e2e/global-setup.ts'),
  outputDir: './test-results/artifacts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: `http://localhost:${PORTAL_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
  },
  projects: [
    {
      name: 'phone',
      use: { ...devices['Pixel 7'], viewport: { width: 360, height: 780 } },
    },
  ],
});
