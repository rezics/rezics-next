import { migrateAccount } from '../../../scripts/ops/migrate.ts';
import { cleanEnv } from 'envalid';
import { accountCoreSpec } from './config.ts';

const env = cleanEnv(process.env, accountCoreSpec);
// QA and direct installs retain the release runner's session lock across
// provider DDL, online index builds and completion receipts.
await migrateAccount({
  ACCOUNT_BASE_URL: env.ACCOUNT_BASE_URL,
  ACCOUNT_SECRET: env.ACCOUNT_SECRET,
  ACCOUNT_MAIN_RESOURCE: env.ACCOUNT_MAIN_RESOURCE,
  ACCOUNT_DATABASE_URL: env.ACCOUNT_DATABASE_URL,
});
console.log('Account schema current');
