import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { assertPgRecoveryFrontier, capturePgRecoveryFrontier,
  type PgRecoveryFrontier } from './modules/work/pg-recovery-frontier.ts';

const mode = process.argv[2];
const databaseUrl = Bun.env.PG_RECOVERY_DATABASE_URL;
if (!databaseUrl || !['capture', 'verify'].includes(mode ?? '')
  || (mode === 'verify' && !process.argv[3])) {
  throw new Error('usage: PG_RECOVERY_DATABASE_URL=... bun pg-recovery-frontier.ts capture|verify [frontier.json]');
}

const pool = new Pool({ connectionString: databaseUrl });
try {
  if (mode === 'capture') {
    console.log(JSON.stringify(await capturePgRecoveryFrontier(pool)));
  } else {
    const frontier = JSON.parse(readFileSync(process.argv[3]!, 'utf8')) as PgRecoveryFrontier;
    await assertPgRecoveryFrontier(pool, frontier);
    console.log('PostgreSQL restore reached retained WAL frontier');
  }
} finally {
  await pool.end();
}
