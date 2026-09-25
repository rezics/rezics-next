import { Pool } from 'pg';
import { getMigrations } from 'better-auth/db/migration';
import { accountAuthOptions } from './auth.ts';
import { installConsentRefreshFence } from './consent-fence.ts';

const baseURL = Bun.env.ACCOUNT_BASE_URL;
const secret = Bun.env.ACCOUNT_SECRET;
const resource = Bun.env.ACCOUNT_MAIN_RESOURCE;
const databaseURL = Bun.env.ACCOUNT_DATABASE_URL;
if (!baseURL || !secret || !resource || !databaseURL) {
  throw new Error('ACCOUNT_BASE_URL, ACCOUNT_SECRET, ACCOUNT_MAIN_RESOURCE and ACCOUNT_DATABASE_URL are required');
}
const pool = new Pool({ connectionString: databaseURL });
try {
  const plan = await getMigrations(accountAuthOptions({
    baseURL, secret, resource, pool, operatorUserIds: new Set(),
  }));
  if (plan.unsafeChanges.length || plan.schemaProblems.length) {
    throw new Error(`Unsafe Account migration: ${[...plan.unsafeChanges, ...plan.schemaProblems].join('; ')}`);
  }
  await plan.runMigrations();
  await installConsentRefreshFence(pool);
  console.log('Account schema current');
} finally {
  await pool.end();
}
