import { Pool } from 'pg';
import { settleAccountErasures } from './modules/erasure/account.ts';
import { mirrorAccountDeletionIntents } from './modules/outbox/account-deletion-journal.ts';

const accessUrl = Bun.env.ACCESS_DATABASE_URL;
const relayUrl = Bun.env.MAIN_RELAY_DATABASE_URL;
// Optional: with the Account owner, also settle journaled Account erasures.
const accountUrl = Bun.env.ACCOUNT_DATABASE_URL;
const contentUrl = Bun.env.CONTENT_DATABASE_URL;
if (process.argv[2] !== 'once' || !accessUrl || !relayUrl) {
  throw new Error('usage: ACCESS_DATABASE_URL=... MAIN_RELAY_DATABASE_URL=... [ACCOUNT_DATABASE_URL=... CONTENT_DATABASE_URL=...] bun relay-account-deletions.ts once');
}
const access = new Pool({ connectionString: accessUrl });
const relay = new Pool({ connectionString: relayUrl });
const account = accountUrl ? new Pool({ connectionString: accountUrl }) : null;
const content = contentUrl ? new Pool({ connectionString: contentUrl }) : null;
try {
  console.log(`retained ${await mirrorAccountDeletionIntents(access, relay)} Account deletion intents`);
  if (account && !content) throw new Error('CONTENT_DATABASE_URL is required to settle Account erasures with private Library uploads');
  if (account) console.log(`settled ${await settleAccountErasures(relay, access, account,100,content!)} Account erasures`);
} finally {
  await Promise.all([access.end(), relay.end(), account?.end(),content?.end()]);
}
