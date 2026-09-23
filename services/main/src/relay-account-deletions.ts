import { Pool } from 'pg';
import { mirrorAccountDeletionIntents } from './modules/outbox/account-deletion-journal.ts';

const accessUrl = Bun.env.ACCESS_DATABASE_URL;
const relayUrl = Bun.env.MAIN_RELAY_DATABASE_URL;
if (process.argv[2] !== 'once' || !accessUrl || !relayUrl) {
  throw new Error('usage: ACCESS_DATABASE_URL=... MAIN_RELAY_DATABASE_URL=... bun relay-account-deletions.ts once');
}
const access = new Pool({ connectionString: accessUrl });
const relay = new Pool({ connectionString: relayUrl });
try {
  console.log(`retained ${await mirrorAccountDeletionIntents(access, relay)} Account deletion intents`);
} finally {
  await Promise.all([access.end(), relay.end()]);
}
