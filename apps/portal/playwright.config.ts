import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import { CLINICAL_PORT, PORTAL_PORT } from './e2e/global-setup';

/**
 * The two apps in a browser (sp5-plan.md T23, sp6-plan.md T25).
 *
 * The portal on a phone, because that is where a patient reads their record: a
 * 360-pixel screen is the width it is designed for (DF9), and those tests fail
 * if it stops working there. The clinical app on a desktop, because that is
 * what a ward or a front desk has.
 *
 * Both run against one stack, started once by the global setup, which is why
 * the runner lives here rather than in each app: two configurations would mean
 * two databases, two APIs and twice the wait.
 *
 * One worker, in order. The tests share one seeded record and change it —
 * sharing is granted and stopped, a card is made and turned off, an order is
 * worked through the lab — and a second worker would be a second pair of hands
 * on the same record.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
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
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
  },
  projects: [
    {
      name: 'phone',
      testDir: './e2e',
      use: {
        ...devices['Pixel 7'],
        viewport: { width: 360, height: 780 },
        baseURL: `http://localhost:${PORTAL_PORT}`,
      },
    },
    {
      name: 'desk',
      testDir: path.resolve(HERE, '..', 'clinical', 'e2e'),
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
        baseURL: `http://localhost:${CLINICAL_PORT}`,
      },
    },
  ],
});
