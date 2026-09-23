import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { assertPgRecoveryFrontier, capturePgRecoveryFrontier,
  type PgRecoveryFrontier } from '../../main/src/modules/work/pg-recovery-frontier.ts';
import { accountRecoveryCoverage, assertAccountRecoveryCoverage,
  type AccountRecoveryCoverage } from './recovery-coverage.ts';
import { openRecoveryPayload, sealRecoveryPayload } from './recovery-envelope.ts';

interface AccountRecoveryManifest {
  pg: PgRecoveryFrontier;
  account: AccountRecoveryCoverage;
}

const mode = process.argv[2];
const databaseUrl = Bun.env.ACCOUNT_RECOVERY_DATABASE_URL;
const key = Bun.env.RECOVERY_MANIFEST_HMAC_KEY;
if (!databaseUrl || !key || !['capture', 'verify'].includes(mode ?? '')
  || (mode === 'verify' && !process.argv[3])) {
  throw new Error('usage: ACCOUNT_RECOVERY_DATABASE_URL=... RECOVERY_MANIFEST_HMAC_KEY=<64 hex characters> bun recovery-manifest.ts capture|verify [manifest.json]');
}

const pool = new Pool({ connectionString: databaseUrl });
try {
  if (mode === 'capture') {
    const manifest: AccountRecoveryManifest = {
      pg: await capturePgRecoveryFrontier(pool),
      account: await accountRecoveryCoverage(pool),
    };
    console.log(JSON.stringify(sealRecoveryPayload(manifest, key, 'account-recovery-manifest')));
  } else {
    const manifest = openRecoveryPayload<AccountRecoveryManifest>(
      readFileSync(process.argv[3]!, 'utf8'), key, 'account-recovery-manifest');
    await assertPgRecoveryFrontier(pool, manifest.pg);
    await assertAccountRecoveryCoverage(pool, manifest.account);
    console.log('Account restore matches retained WAL and row coverage');
  }
} finally {
  await pool.end();
}
