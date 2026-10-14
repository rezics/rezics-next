import { expect, test } from 'bun:test';
import { integrationStackAdmitsWorkScope, qaStackEnvironment, qaPostgresMaxLocksPerTransaction } from './stack-environment.ts';
import { stackMemorySettings } from '../dev/config.ts';
import { startPostgresCluster } from '../../tests/qa/support/postgres-cluster.ts';
import { Client } from 'pg';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { integrationResourceClass, qaResourceClasses } from './resource-classes.ts';
import { rawSparqlIntegrationFiles } from './isolated-integration-files.ts';

const discoveryReplay = 'tests/qa/integration/discovery-read-isolation.test.ts';
const commandOnly = 'tests/qa/integration/profile-corpus-restore.test.ts';

test('model custody maintenance uses persistent harness owners within its existing test budget', () => {
  const name = integrationResourceClass(['tests/qa/integration/model-custody-backfill.test.ts']);
  expect(qaResourceClasses[name].storage).toBe('scale');
  expect(qaResourceClasses[name].budgetMs).toBe(qaResourceClasses.ordinary.budgetMs);
});

test('QA saves the measured lock allocation for disposable and restored PostgreSQL', () => {
  const env = qaStackEnvironment({ REZICS_POSTGRES_MAX_LOCKS_PER_TRANSACTION: '64' });
  expect(env.REZICS_POSTGRES_MAX_LOCKS_PER_TRANSACTION).toBe('256');
  expect(stackMemorySettings({ profile: 'qa' }, env).REZICS_POSTGRES_MAX_LOCKS_PER_TRANSACTION).toBe('256');
  expect(stackMemorySettings({ profile: 'dev' }, env).REZICS_POSTGRES_MAX_LOCKS_PER_TRANSACTION).toBeUndefined();
  const compose = readFileSync(join(import.meta.dir, '../../infra/dev/compose.yaml'), 'utf8');
  expect(compose).toContain('max_locks_per_transaction=${REZICS_POSTGRES_MAX_LOCKS_PER_TRANSACTION:-64}');
  const qa = readFileSync(join(import.meta.dir, '../../infra/dev/compose.qa-resources.yaml'), 'utf8');
  expect(qa).toContain('mem_limit: ${REZICS_POSTGRES_MEMORY_LIMIT:-2g}');
});

test('QA PostgreSQL holds the ranked fixture lock set inside its existing memory allocation', async () => {
  const cluster = await startPostgresCluster({ serverSettings: `max_locks_per_transaction=${qaPostgresMaxLocksPerTransaction}` });
  const client = new Client(cluster.connection);
  try {
    await client.connect();
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('read-ranking-work:' || work, 0))
      FROM generate_series(1, 22004) work`);
    const locks = await client.query("SELECT count(*)::int AS count FROM pg_locks WHERE pid = pg_backend_pid() AND locktype = 'advisory'");
    expect(locks.rows[0].count).toBe(22004);
    const memory = await client.query("SELECT pg_size_bytes(current_setting('shared_memory_size')) AS bytes");
    console.log(`QA PostgreSQL shared memory: ${memory.rows[0].bytes} bytes for 22004 Work locks`);
    expect(Number(memory.rows[0].bytes)).toBeLessThan(2 * 1024 ** 3);
    await client.query('ROLLBACK');
  } finally { await client.end(); cluster.remove(); }
}, 30_000);

test('discovery replay selects the fixture assembler through the derived raw-update scan', () => {
  expect(rawSparqlIntegrationFiles().has(discoveryReplay)).toBe(true);
  expect(integrationStackAdmitsWorkScope([discoveryReplay], false)).toBe(false);
});

test('command-only files keep the exclusive assembler unless raw maintenance is requested', () => {
  expect(rawSparqlIntegrationFiles().has(commandOnly)).toBe(false);
  expect(integrationStackAdmitsWorkScope([commandOnly], false)).toBe(true);
  expect(integrationStackAdmitsWorkScope([commandOnly], true)).toBe(false);
});
