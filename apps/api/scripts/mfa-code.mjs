// Prints the current two-factor code for a development account whose
// authenticator secret the smoke scripts cached in scripts/.smoke-secrets.json.
//
// Development only: that file exists because the smoke scripts enrol dev
// accounts themselves. Real accounts enrol with a phone, and no such file
// exists for them.
//
//   pnpm --filter @health24/api mfa:code curator.anjali@health24.example.in

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

if (!email || !secrets[email]) {
  console.error(email ? `No cached secret for ${email}.` : 'Usage: mfa:code <email>');
  console.error('Accounts with a cached secret:');
  for (const known of Object.keys(secrets)) console.error(`  ${known}`);
  process.exit(1);
}

const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secrets[email]) });
const secondsLeft = 30 - (Math.floor(Date.now() / 1000) % 30);

console.log(`${totp.generate()}  (valid for ${secondsLeft}s more)`);
