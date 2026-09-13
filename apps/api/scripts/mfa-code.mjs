// Prints current two-factor codes for development accounts whose authenticator
// secrets the smoke scripts cached in scripts/.smoke-secrets.json.
//
// Development only: that file exists because the smoke scripts enrol dev
// accounts themselves. Real accounts enrol with a phone, and no such file
// exists for them.
//
//   pnpm --filter @health24/api mfa:code                 every account's code
//   pnpm --filter @health24/api mfa:code <email>         one account's code
//
// A code works only for its own account: each account has its own secret.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as OTPAuth from 'otpauth';

const here = path.dirname(fileURLToPath(import.meta.url));
const secretsFile = path.join(here, '.smoke-secrets.json');
const email = process.argv[2]?.trim().toLowerCase();

const secrets = fs.existsSync(secretsFile)
  ? JSON.parse(fs.readFileSync(secretsFile, 'utf8'))
  : {};

const codeFor = (address) =>
  new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secrets[address]) }).generate();
const secondsLeft = 30 - (Math.floor(Date.now() / 1000) % 30);

if (email) {
  if (!secrets[email]) {
    console.error(`No cached secret for ${email}. Run without an email to see every account.`);
    process.exit(1);
  }

  console.log(`${codeFor(email)}  for ${email}  (valid for ${secondsLeft}s more)`);
  process.exit(0);
}

// Throwaway accounts the smoke scripts create are left out of the list.
const accounts = Object.keys(secrets)
  .filter((address) => !address.startsWith('smoke.'))
  .sort();

if (accounts.length === 0) {
  console.error('No cached secrets. Run the smoke scripts first: pnpm smoke');
  process.exit(1);
}

const width = Math.max(...accounts.map((address) => address.length));

console.log(`Codes valid for ${secondsLeft}s more. Use the code on the same row as your email.\n`);
for (const address of accounts) {
  console.log(`  ${address.padEnd(width)}   ${codeFor(address)}`);
}
