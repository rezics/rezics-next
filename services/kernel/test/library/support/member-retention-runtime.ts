import { readFileSync } from 'node:fs';
import { createPool } from '../../../src/database/pool.ts';
import { libraryWorkModule } from '../../../src/library/work-module.ts';
import { createWorkClient } from '../../../src/work/client.ts';
import { composeWork } from '../../../src/work/registry.ts';
import { observeRetentionQueries } from '../entry-retention-worker-runtime.ts';

// Each test owns this child and its streams. No SDK reset or unrelated executor is touched.
if (import.meta.main) {
  const [mode, executorId, timePath] = process.argv.slice(2);
  if (!executorId || !timePath) throw new Error('Member runtime requires executor identity and clock path');
  const pool = createPool(process.env.DATABASE_URL!);
  const client = await createWorkClient(process.env.DATABASE_URL!);
  let parked = false;
  if (mode !== 'recover') {
    const written = new WeakSet<object>();
    await observeRetentionQueries(pool, async ({ connection, sql, result }) => {
      if (/member-retention: physical exact episode/i.test(sql) && result.rows.some((row) => row.purged))
        written.add(connection);
      const source = mode === 'park' && /member-retention: due-key seek/i.test(sql) && result.rows.length > 0;
      const committed = mode === 'crash' && written.has(connection) && /^COMMIT$/i.test(sql.trim());
      if (/^(COMMIT|ROLLBACK)$/i.test(sql.trim())) written.delete(connection);
      if (!parked && (source || committed)) {
        parked = true;
        console.log(source ? 'source-parked' : 'native-committed');
        await new Promise<void>((resolve) => process.stdin.once('data', () => resolve()));
      }
    });
  }
  const work = await composeWork([libraryWorkModule], {
    pool,
    client,
    databaseUrl: process.env.DATABASE_URL!,
    executorId,
    clock: () => new Date(Number(readFileSync(timePath, 'utf8'))),
    env: {},
  });
  await work.launch();
  console.log('worker-ready');
  process.once(
    'SIGTERM',
    () =>
      void (async () => {
        await work.shutdown();
        await client.close();
        await pool.end();
        process.exit(0);
      })(),
  );
}
