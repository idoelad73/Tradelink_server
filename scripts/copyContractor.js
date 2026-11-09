/**
 * Copies ONE contractor account (by email) from the development database to the
 * production database — so you can log in to production with the same email and
 * password. Run from server/ directory:
 *
 *   node scripts/copyContractor.js you@example.com            (dry run)
 *   node scripts/copyContractor.js you@example.com --apply
 *   node scripts/copyContractor.js you@example.com --from=.env.dev --apply
 *
 * Source = MONGO_URI in .env (or the file given with --from=)   (development)
 * Target = MONGO_URI in .env.production                          (production)
 *
 * Copied as-is: _id, companyName, email, password hash, phone, address,
 * expertise, user_type (admin stays admin), terms acceptance.
 *
 * Reset, because it only makes sense in development:
 *   sites            — the dev projects don't exist in production
 *   stripe*          — Stripe test-mode customer / card, invalid against live keys
 *   avgGrade/gradeCount, login stats, refresh / reset tokens
 *
 * Refuses to overwrite: if the email already exists in production, nothing is written.
 */

import fs from 'fs';
import mongoose from 'mongoose';

const email = process.argv.slice(2).find((a) => !a.startsWith('--'))?.toLowerCase().trim();
const APPLY = process.argv.includes('--apply');
if (!email) { console.error('Usage: node scripts/copyContractor.js <email> [--apply]'); process.exit(1); }

// Read MONGO_URI from an env file without loading the rest into process.env
function uriFrom(file) {
  if (!fs.existsSync(file)) { console.error(`${file} not found`); process.exit(1); }
  const line = fs.readFileSync(file, 'utf8').split(/\r?\n/).find((l) => /^\s*MONGO_URI\s*=/.test(l));
  if (!line) { console.error(`No MONGO_URI in ${file}`); process.exit(1); }
  return line.replace(/^\s*MONGO_URI\s*=\s*/, '').trim().replace(/^['"]|['"]$/g, '');
}

const fromArg    = process.argv.find((a) => a.startsWith('--from='));
const SOURCE_URI = uriFrom(fromArg ? fromArg.slice('--from='.length) : '.env');
const TARGET_URI = uriFrom('.env.production');

const source = await mongoose.createConnection(SOURCE_URI).asPromise();
const target = await mongoose.createConnection(TARGET_URI).asPromise();
try {
  const where = (c) => `${c.host} / "${c.name}"`;
  console.log(`From: ${where(source)}`);
  console.log(`To:   ${where(target)}${APPLY ? '' : '   (dry run — add --apply to write)'}\n`);

  if (target.name === 'test') { console.error('Target database is "test" — add /tradelink to the URI in .env.production.'); process.exit(1); }
  if (source.host === target.host && source.name === target.name) {
    console.error('.env and .env.production point at the same database — nothing to copy.'); process.exit(1);
  }

  const src = await source.db.collection('contractors').findOne({ email });
  if (!src) { console.error(`No contractor with email ${email} in the source database.`); process.exit(1); }

  const exists = await target.db.collection('contractors').findOne(
    { $or: [{ email }, { _id: src._id }] }, { projection: { _id: 1, email: 1 } });
  if (exists) { console.error(`Already in production (${exists.email}) — not overwriting.`); process.exit(1); }

  const now = new Date();
  const doc = {
    _id:             src._id,
    companyName:     src.companyName,
    email:           src.email,
    password:        src.password,        // bcrypt hash — same password works
    phone:           src.phone,
    address:         src.address,
    expertise:       src.expertise ?? [],
    user_type:       src.user_type ?? 'user',
    termsAcceptedAt: src.termsAcceptedAt ?? null,
    termsVersion:    src.termsVersion ?? null,
    // fresh production state
    sites:                      [],
    isLoggedIn:                 false,
    lastLogin:                  null,
    loginCount:                 0,
    avgGrade:                   null,
    gradeCount:                 0,
    stripeCustomerId:           null,
    stripeDefaultPaymentMethod: null,
    passwordResetTokenHash:     null,
    passwordResetExpiresAt:     null,
    refreshTokenHash:           null,
    refreshTokenExpiresAt:      null,
    createdAt:                  src.createdAt ?? now,
    updatedAt:                  now,
    __v:                        0,
  };

  const { password, ...shown } = doc;
  console.log('Will insert into contractors:');
  console.log({ ...shown, password: password ? '(bcrypt hash copied)' : '(MISSING)' });

  if (APPLY) {
    await target.db.collection('contractors').insertOne(doc);
    console.log(`\nCopied. Log in to production with ${email} and your existing password.`);
  }
} finally {
  await source.close();
  await target.close();
}
