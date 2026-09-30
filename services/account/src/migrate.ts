import { Pool } from 'pg';
import { getMigrations } from 'better-auth/db/migration';
import { accountAuthOptions } from './auth.ts';
import { installConsentRefreshFence } from './consent-fence.ts';
import { cleanEnv } from 'envalid';
import { accountCoreSpec } from './config.ts';

const { ACCOUNT_BASE_URL: baseURL, ACCOUNT_SECRET: secret, ACCOUNT_MAIN_RESOURCE: resource,
  ACCOUNT_DATABASE_URL: databaseURL } = cleanEnv(process.env, accountCoreSpec);
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
