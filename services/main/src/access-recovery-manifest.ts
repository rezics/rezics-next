import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { assertPgRecoveryFrontier, capturePgRecoveryFrontier,
  type PgRecoveryFrontier, type RowCoverage } from './modules/work/pg-recovery-frontier.ts';
import { accessOutboxCoverage, accessStateTables } from
  './modules/work/access-recovery-coverage.ts';
import { openRecoveryPayload, sealRecoveryPayload } from
  '../../account/src/recovery-envelope.ts';

/** Version 5 derives the Access table set from the catalog; `state` folds `tables`. */
export interface AccessRecoveryManifest {
  version: 5;
  pg: PgRecoveryFrontier;
  outbox: RowCoverage;
  state: RowCoverage;
  catalogDigest: string;
  tables: Record<string, RowCoverage>;
  excluded: Record<string, string>;
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
    const pg = await capturePgRecoveryFrontier(pool);
    const outbox = await accessOutboxCoverage(pool);
    const { state, catalogDigest, tables, excluded } = await accessStateTables(pool);
    const manifest: AccessRecoveryManifest = { version: 5, pg, outbox, state,
      catalogDigest, tables, excluded };
    console.log(JSON.stringify(sealRecoveryPayload(manifest, key, 'access-recovery-manifest')));
  } else {
    const manifest = openRecoveryPayload<AccessRecoveryManifest>(
      readFileSync(process.argv[3]!, 'utf8'), key, 'access-recovery-manifest');
    if (manifest?.version !== 5) {
      throw new Error(`Access recovery manifest version ${String(manifest?.version ?? 4)
      } is not version 5; capture a fresh manifest from the quiesced source`);
    }
    await assertPgRecoveryFrontier(pool, manifest.pg);
    const outbox = await accessOutboxCoverage(pool);
    const actual = await accessStateTables(pool);
    const differing = [...new Set([...Object.keys(manifest.tables ?? {}), ...Object.keys(actual.tables)])]
      .filter(name => JSON.stringify(manifest.tables?.[name]) !== JSON.stringify(actual.tables[name]))
      .sort();
    if (outbox.count !== manifest.outbox?.count || outbox.digest !== manifest.outbox?.digest
      || actual.state.count !== manifest.state?.count || actual.state.digest !== manifest.state?.digest
      || actual.catalogDigest !== manifest.catalogDigest || differing.length) {
      throw new Error(`Access rows differ from retained recovery manifest${
        differing.length ? `: ${differing.join(', ')}` : ''}`);
    }
    console.log('Access restore matches retained WAL and row coverage');
  }
} finally {
  await pool.end();
}
