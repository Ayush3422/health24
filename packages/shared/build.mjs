/**
 * Builds @health24/shared twice.
 *
 * The NestJS API consumes this package as CommonJS; the browser app consumes
 * it as ESM. Shipping only CommonJS worked in the Vite dev server, which
 * pre-bundles dependencies, and then failed the production build — Rollup
 * cannot read named exports from a CommonJS file that lives outside
 * node_modules. Emitting both formats removes the interop problem rather than
 * working around it in each consumer's bundler config.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// Resolve the compiler and run it with node directly. Spawning `npx` would
// need a shell on Windows, where .cmd files cannot be exec'd — and a shell in
// a build script is a portability problem waiting to happen.
const require = createRequire(import.meta.url);
const tsc = require.resolve('typescript/bin/tsc');

for (const config of ['tsconfig.cjs.json', 'tsconfig.esm.json']) {
  execFileSync(process.execPath, [tsc, '-p', config], { cwd: here, stdio: 'inherit' });
}

// Node decides a file's module system from the nearest package.json, so each
// output directory declares its own. Without these, the .js files in dist/esm
// would be treated as CommonJS and fail on their own import statements.
fs.writeFileSync(
  path.join(here, 'dist/cjs/package.json'),
  JSON.stringify({ type: 'commonjs' }, null, 2),
);
fs.writeFileSync(
  path.join(here, 'dist/esm/package.json'),
  JSON.stringify({ type: 'module' }, null, 2),
);

console.log('Built @health24/shared for CommonJS and ESM.');
