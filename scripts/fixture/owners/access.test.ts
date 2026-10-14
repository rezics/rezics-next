import { expect, test } from 'bun:test';
import { Pool } from 'pg';
import { startPostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { migrateTracked, migrationDirectories, repositoryRoot } from '../../ops/migrate.ts';
import { fixtureCorpus } from '../corpus.ts';
import { accessOwner } from './access.ts';
import type { LoadTarget } from './types.ts';

test('medium Access fixture preserves every key with default PostgreSQL advisory-lock capacity', async () => {
  const cluster = await startPostgresCluster();
  const pool = new Pool({ ...cluster.connection, max: 1 });
  try {
    const url = `postgresql://${cluster.user}@${cluster.host}:${cluster.port}/${cluster.database}`;
    await migrateTracked(url, repositoryRoot, migrationDirectories.access);
    expect((await pool.query('SHOW max_locks_per_transaction')).rows[0].max_locks_per_transaction).toBe('64');
    const corpus = fixtureCorpus('medium');
    const target: LoadTarget = { root: repositoryRoot, apps: {}, pools: { access: pool, content: pool },
      fusekiOffline: async () => { throw new Error('Access fixture must not use Fuseki'); } };
    await accessOwner.load(corpus, target);
    const planned = accessOwner.summarize(corpus).counts;
    expect(await accessOwner.verify(corpus, target)).toEqual(planned);
    expect((await pool.query(`SELECT count(*)::int AS n FROM pg_locks
      WHERE pid = pg_backend_pid() AND locktype = 'advisory'`)).rows[0].n).toBe(0);
    const expanded = { ...corpus, works: corpus.works + 1 };
    expect(await accessOwner.verify(expanded, target)).not.toEqual(accessOwner.summarize(expanded).counts);
  } finally {
    await pool.end();
    cluster.remove();
  }
}, 120_000);
