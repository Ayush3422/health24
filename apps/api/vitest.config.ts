import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    // Nest's DI relies on `design:paramtypes` metadata, which esbuild does not
    // emit. Tests here therefore cover pure logic and services constructed by
    // hand; end-to-end coverage of the wired application lives in the smoke
    // scripts, which drive the compiled server over HTTP.
  },
});
