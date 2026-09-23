import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { assertPgRecoveryFrontier, capturePgRecoveryFrontier,
  type PgRecoveryFrontier } from './modules/work/pg-recovery-frontier.ts';
import { accessOutboxCoverage, accessStateCoverage } from
  './modules/work/access-recovery-coverage.ts';
import { openRecoveryPayload, sealRecoveryPayload } from
  '../../account/src/recovery-envelope.ts';

export interface AccessRecoveryManifest {
  pg: PgRecoveryFrontier;
  outbox: { count: string; digest: string };
  state: { count: string; digest: string };
}

const mode = process.argv[2];
const databaseUrl = Bun.env.ACCESS_RECOVERY_DATABASE_URL;
const key = Bun.env.RECOVERY_MANIFEST_HMAC_KEY;
if (!databaseUrl || !key || !['capture', 'verify'].includes(mode ?? '')
  || (mode === 'verify' && !process.argv[3])) {
  throw new Error('usage: ACCESS_RECOVERY_DATABASE_URL=... RECOVERY_MANIFEST_HMAC_KEY=<64 hex characters> bun access-recovery-manifest.ts capture|verify [manifest.json]');
}

const pool = new Pool({ connectionString: databaseUrl });
try {
  if (mode === 'capture') {
    const manifest: AccessRecoveryManifest = {
      pg: await capturePgRecoveryFrontier(pool),
      outbox: await accessOutboxCoverage(pool),
      state: await accessStateCoverage(pool),
    };
    console.log(JSON.stringify(sealRecoveryPayload(manifest, key, 'access-recovery-manifest')));
  } else {
    const manifest = openRecoveryPayload<AccessRecoveryManifest>(
      readFileSync(process.argv[3]!, 'utf8'), key, 'access-recovery-manifest');
    await assertPgRecoveryFrontier(pool, manifest.pg);
    const outbox = await accessOutboxCoverage(pool);
    const state = await accessStateCoverage(pool);
    if (outbox.count !== manifest.outbox?.count || outbox.digest !== manifest.outbox?.digest
      || state.count !== manifest.state?.count || state.digest !== manifest.state?.digest) {
      throw new Error('Access rows differ from retained recovery manifest');
    }
    console.log('Access restore matches retained WAL and row coverage');
  }
} finally {
  await pool.end();
}
