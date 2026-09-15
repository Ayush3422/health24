// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Node globals.
 *
 * Declared explicitly rather than pulling in the `globals` package for one
 * short list. Without these, `console` and `process` read as undefined
 * identifiers in every script and every service.
 */
const nodeGlobals = {
  console: 'readonly',
  process: 'readonly',
  Buffer: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  fetch: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
  module: 'readonly',
  require: 'readonly',
};

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/dist-worker/**',
      '**/node_modules/**',
      '**/coverage/**',
      // Generated SQL and drizzle metadata.
      '**/drizzle/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: nodeGlobals,
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    // Smoke scripts are plain ESM run by node, not part of the compiled app.
    files: ['**/scripts/**/*.mjs'],
    languageOptions: {
      globals: nodeGlobals,
    },
    rules: {
      // They are executable documentation; top-level await is the point.
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
);
