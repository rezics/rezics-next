import { expect, test } from 'bun:test';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from 'pg';
import { sha256 } from './corpus.ts';
import { inventoryDirectory } from './manifest.ts';
import { repairCopiedPostgresCollations } from './postgres-collation.ts';
import { RetainedSources, type RetainedSourceAdapter } from '../qa/retained-source.ts';
import { startPostgresCluster, startPreparedPostgresCluster, type PostgresCluster } from '../../tests/qa/support/postgres-cluster.ts';

const root = resolve(import.meta.dir, '../..');

async function phase<T>(name: string, work: () => T | Promise<T>): Promise<T> {
  const started = performance.now();
  console.error(`PostgreSQL collation: ${name} started`);
  try { return await work(); }
  finally { console.error(`PostgreSQL collation: ${name} finished (${Math.round(performance.now() - started)} ms)`); }
}

test('retained PostgreSQL repairs stale template indexes on its disposable copy and preserves published custody', async () => {
  const source = await phase('initialize source cluster', () => startPostgresCluster());
  const directory = mkdtempSync(join(root, '.temp/collation-restore-'));
  const admin = new Client(source.connection);
  const template = 'retained "template';
  const quoted = '"retained ""template"';
  let clone: PostgresCluster | undefined;
  try {
    await admin.connect();
    const provider = (await admin.query('SELECT datlocprovider, datlocale FROM pg_database WHERE datname=current_database()')).rows[0];
    expect(provider).toEqual({ datlocprovider: 'b', datlocale: 'C.UTF-8' });
    await admin.query(`CREATE DATABASE ${quoted} TEMPLATE template0 LOCALE_PROVIDER libc LOCALE 'en_US.UTF-8'`);
    const data = new Client({ ...source.connection, database: template });
    await data.connect();
    let indexFile: string;
    try {
      await data.query("CREATE TABLE retained_words (word text); INSERT INTO retained_words VALUES ('中文'), ('é'), ('a'); CREATE INDEX retained_word_idx ON retained_words(word)");
      indexFile = (await data.query("SELECT pg_relation_filenode('retained_word_idx')::text AS file")).rows[0].file;
    } finally { await data.end(); }
    const actual = (await admin.query('SELECT pg_database_collation_actual_version(oid) AS version FROM pg_database WHERE datname=$1', [template])).rows[0].version;
    expect(actual).toBeString();
    await admin.query('UPDATE pg_database SET datcollversion=$1 WHERE datname=$2', ['before-host-update', template]);
    await expect(admin.query(`CREATE DATABASE refused TEMPLATE ${quoted}`)).rejects.toThrow('collation version mismatch');
    await admin.query(`ALTER DATABASE ${quoted} ALLOW_CONNECTIONS false`);
    await admin.end();
    await phase('stop source cluster', () => source.stop());
    const adapter: RetainedSourceAdapter<{ template: string }, PostgresCluster> = {
      specification: { producer: 'collation-restore', version: '1', files: { fixture: sha256('stale collation') }, inputs: {}, compatibility: {} },
      async build(context) {
        await phase('publish physical backup', () => cpSync(source.dataDirectory, join(context.backup, 'postgres'), { recursive: true }));
        return { metadata: { template }, rdfDigest: sha256('no graph'), ownerState: {},
          producerRevision: 'fixture', qaIdentity: 'collation-restore', phases: {} };
      },
      async verify() { return []; },
      async restore(context) {
        const copy = join(directory, 'copy');
        await phase('copy physical backup', () => cpSync(join(context.backup, 'postgres'), copy, { recursive: true }));
        return phase('start copy and repair indexes', () => startPreparedPostgresCluster(copy));
      },
      async dispose(candidate) { candidate.remove(); },
      async remove() {},
    };
    const store = new RetainedSources(join(directory, 'sources'));
    const prepared = await phase('prepare retained source', () => store.prepare(adapter));
    const publication = join(directory, 'sources', prepared.manifest.key);
    const before = inventoryDirectory(publication);
    const lease = await phase('restore retained source', () => store.restore(adapter));
    clone = lease.candidate;
    expect(clone.collationRepairs).toEqual([{ database: template, recordedVersion: 'before-host-update',
      actualVersion: actual, collations: [], reindexed: true }]);
    try {
      const copied = new Client(clone.connection);
      await copied.connect();
      try {
        expect((await copied.query('SELECT datcollversion, datallowconn FROM pg_database WHERE datname=$1', [template])).rows)
          .toEqual([{ datcollversion: actual, datallowconn: false }]);
        await copied.query(`CREATE DATABASE restored TEMPLATE ${quoted}`);
        const restored = new Client({ ...clone.connection, database: 'restored' });
        await restored.connect();
        try {
          expect((await restored.query("SELECT pg_relation_filenode('retained_word_idx')::text AS file")).rows[0].file).not.toBe(indexFile!);
          expect((await restored.query('SELECT word FROM retained_words ORDER BY word')).rows).toHaveLength(3);
        } finally { await restored.end(); }
        expect(await repairCopiedPostgresCollations(clone.connection)).toEqual([]);
      } finally { await copied.end(); }
    } finally { await lease.dispose(); clone = undefined; }
    expect(inventoryDirectory(publication)).toEqual(before);
    expect((await store.select(adapter)).digest).toBe(prepared.manifest.digest);
  } finally {
    await admin.end();
    clone?.remove();
    source.remove();
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);

test('repair rebuilds indexes using a stale named collation and skips unused catalog locales', async () => {
  const cluster = await phase('initialize source cluster', () => startPostgresCluster());
  const client = new Client(cluster.connection);
  try {
    await client.connect();
    await client.query(`CREATE COLLATION used_locale (provider=icu, locale='en');
      CREATE COLLATION unused_locale (provider=icu, locale='en');
      CREATE TABLE named_words (word text COLLATE used_locale);
      INSERT INTO named_words VALUES ('é'), ('a');
      CREATE INDEX named_word_idx ON named_words(word)`);
    const original = (await client.query("SELECT pg_relation_filenode('named_word_idx')::text AS file")).rows[0].file;
    const actual = (await client.query("SELECT pg_collation_actual_version('used_locale'::regcollation) AS version")).rows[0].version;
    await client.query("UPDATE pg_collation SET collversion='before-icu-update' WHERE collname IN ('used_locale', 'unused_locale')");
    const connectionString = `postgresql://${cluster.connection.user}@${cluster.connection.host}:${cluster.connection.port}/postgres`;
    const repairs = await repairCopiedPostgresCollations({ connectionString });
    expect(repairs).toEqual([{ database: 'postgres', recordedVersion: '1', actualVersion: '1',
      collations: [{ name: 'public.used_locale', recordedVersion: 'before-icu-update', actualVersion: actual }],
      reindexed: true }]);
    expect((await client.query("SELECT pg_relation_filenode('named_word_idx')::text AS file")).rows[0].file).not.toBe(original);
    expect((await client.query("SELECT collname, collversion FROM pg_collation WHERE collname IN ('used_locale', 'unused_locale') ORDER BY collname")).rows)
      .toEqual([{ collname: 'unused_locale', collversion: 'before-icu-update' }, { collname: 'used_locale', collversion: actual }]);
    expect(await repairCopiedPostgresCollations({ connectionString })).toEqual([]);
  } finally { await client.end(); cluster.remove(); }
}, 30_000);

test('a failed index rebuild leaves the recorded version stale and emits no successful repair', async () => {
  const cluster = await phase('initialize source cluster', () => startPostgresCluster());
  const client = new Client(cluster.connection);
  const repairs: unknown[] = [];
  try {
    await client.connect();
    await client.query("CREATE TABLE duplicate_words (word text); INSERT INTO duplicate_words VALUES ('same'), ('same'); CREATE INDEX duplicate_word_idx ON duplicate_words(word)");
    // Model an old unique index whose keys collide under the new collation.
    await client.query("UPDATE pg_index SET indisunique=true WHERE indexrelid='duplicate_word_idx'::regclass");
    await client.query("UPDATE pg_database SET datcollversion='before-host-update' WHERE datname='postgres'");
    await expect(repairCopiedPostgresCollations(cluster.connection, repair => repairs.push(repair)))
      .rejects.toThrow('could not create unique index');
    expect((await client.query("SELECT datcollversion FROM pg_database WHERE datname='postgres'")).rows)
      .toEqual([{ datcollversion: 'before-host-update' }]);
    expect(repairs).toEqual([]);
  } finally { await client.end(); cluster.remove(); }
}, 30_000);

