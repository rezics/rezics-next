import { Pool } from 'pg';
import { backfillAccountSubjectDeletions } from './modules/outbox/account-subject-deletion.ts';

const accountUrl = Bun.env.ACCOUNT_RECOVERY_DATABASE_URL;
const accessUrl = Bun.env.ACCESS_RECOVERY_DATABASE_URL;
const relayUrl = Bun.env.RELAY_RECOVERY_DATABASE_URL;
if (process.argv[2] !== 'once' || !accountUrl || !accessUrl || !relayUrl) {
  throw new Error('usage: ACCOUNT_RECOVERY_DATABASE_URL=... ACCESS_RECOVERY_DATABASE_URL=... RELAY_RECOVERY_DATABASE_URL=... bun relay-account-subject-backfill.ts once');
}
const account = new Pool({ connectionString: accountUrl });
const access = new Pool({ connectionString: accessUrl });
const relay = new Pool({ connectionString: relayUrl });
try {
  console.log(`retained ${await backfillAccountSubjectDeletions(
    account, access, relay)} Account subject tombstones`);
} finally {
  await Promise.all([account.end(), access.end(), relay.end()]);
}
