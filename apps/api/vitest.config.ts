import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    // Nest's dependency injection reads `design:paramtypes`, which esbuild —
    // vitest's default transformer — does not emit. Without SWC the container
    // resolves every constructor parameter to undefined, which surfaces as
    // baffling "cannot read properties of undefined" errors rather than
    // anything pointing at decorators.
    swc.vite({ module: { type: 'es6' } }),
  ],
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts', 'test/**/*.e2e-spec.ts'],
    // Integration specs share one Postgres database, so they must not run
    // concurrently — parallel suites would see each other's rows and the
    // failures would look like isolation bugs in the application.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    globalSetup: ['test/global-setup.ts'],
  },
});
