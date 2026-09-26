import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { contextSelectionCandidates, contextSelectionScopeKey,
  type ContextSelectionScope } from '../src/modules/context/schema.ts';
import { PRIVATE_SELECTION_LOOKUP_SQL, privateSelectionLookupKeys,
  type PrivateSelectionCandidateRow } from '../src/modules/context/private-selection-schema.ts';

const root = resolve(import.meta.dir, '../../..');
const migrations = join(root, 'services/main/migrations/access');
const OWN = '100_context_selection.sql';
const native = () => `https://rezics.com/id/${Bun.randomUUIDv7()}`;
const digest = 'c'.repeat(64);

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no PostgreSQL test port'));
      server.close(() => resolvePort(address.port));
    });
  });
}

async function apply(pool: Pool, files: readonly string[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const file of files) await client.query(readFileSync(join(migrations, file), 'utf8'));
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

async function inTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

function scopeColumns(scope: ContextSelectionScope): [string, string | null, string | null, string | null] {
  return [scope.kind, scope.kind === 'object' || scope.kind === 'object-relation' ? scope.object : null,
    scope.kind === 'object-relation' ? scope.relation : null, scope.kind === 'domain' ? scope.domain : null];
}

/** The owning command's first write: head, generation 1 and receipt in one transaction. */
async function createSelection(pool: Pool, principal: string, scope: ContextSelectionScope,
  context: string, key: string): Promise<{ selection: string; revision: string }> {
  const selection = Bun.randomUUIDv7();
  const revision = Bun.randomUUIDv7();
  await inTransaction(pool, async (client) => {
    await client.query(`INSERT INTO access.context_selection
      (id, principal_id, scope_profile, scope_kind, scope_object, scope_relation, scope_domain, head_revision)
      VALUES ($1, $2, 'context-selection-scope-v1', $3, $4, $5, $6, $7)`,
    [selection, principal, ...scopeColumns(scope), revision]);
    await client.query(`INSERT INTO access.context_selection_revision
      (id, selection_id, generation, state, context, semantic_revision) VALUES ($1, $2, 1, 'selected', $3, $4)`,
    [revision, selection, context, native()]);
    await client.query(`INSERT INTO access.context_selection_receipt
      (principal_id, idempotency_key, request_digest, selection_id, revision_id) VALUES ($1, $2, $3, $4, $5)`,
    [principal, key, digest, selection, revision]);
  });
  return { selection, revision };
}

/** Compare-and-swap: insert generation n+1, then move the head from its expected revision. */
async function advance(client: PoolClient, selection: string, expected: string, generation: number,
  state: 'selected' | 'cleared', context: string | null): Promise<string> {
  const revision = Bun.randomUUIDv7();
  await client.query(`INSERT INTO access.context_selection_revision
    (id, selection_id, generation, predecessor_generation, state, context, semantic_revision)
    VALUES ($1, $2, $3, $4, $5, $6, $7)`, [revision, selection, generation, generation - 1, state, context,
    context === null ? null : native()]);
  const moved = await client.query(`UPDATE access.context_selection SET head_revision = $1
    WHERE id = $2 AND head_revision = $3`, [revision, selection, expected]);
  if (moved.rowCount !== 1) throw new Error('stale Context selection head');
  return revision;
}

test('CTX03: schema foundation Access private Context selections install empty, upgrade head and guard CAS', async () => {
  const state = join(root, '.temp', `context-schema-${Bun.randomUUIDv7()}`);
  const data = join(state, 'pgdata');
  const socketDirectory = join(root, '.temp', 'pg-sock');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  mkdirSync(socketDirectory, { recursive: true, mode: 0o700 });
  execFileSync('initdb', ['-D', data, '-A', 'trust', '--no-instructions'], { cwd: state });
  const port = await freePort();
  execFileSync('pg_ctl', ['-D', data, '-l', join(state, 'postgres.log'),
    '-o', `-h 127.0.0.1 -p ${port} -k ${socketDirectory}`, '-w', 'start'], { cwd: state });
  const admin = new Pool({ host: '127.0.0.1', port, user: process.env.USER, database: 'postgres', max: 1 });
  const pools: Pool[] = [];
  try {
    const files = [...new Bun.Glob('*.sql').scanSync({ cwd: migrations })].sort();
    expect(files).toContain(OWN);
    const head = files.filter(file => file < OWN);
    const later = files.filter(file => file > OWN);
    for (const name of ['context_empty', 'context_upgrade']) await admin.query(`CREATE DATABASE ${name}`);
    const database = (name: string) => {
      const pool = new Pool({ host: '127.0.0.1', port, user: process.env.USER, database: name, max: 4 });
      pools.push(pool);
      return pool;
    };

    // Empty install: every Access migration in file-name order in one transaction.
    const empty = database('context_empty');
    await apply(empty, files);
    const tables = await empty.query<{ table_name: string }>(`SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'access' AND table_name LIKE 'context_selection%' ORDER BY table_name`);
    expect(tables.rows.map(row => row.table_name)).toEqual(['context_selection',
      'context_selection_receipt', 'context_selection_revision']);

    // Upgrade: a populated current-head Access database gains the tables without touching prior rows.
    const pool = database('context_upgrade');
    await apply(pool, head);
    const principal = Bun.randomUUIDv7();
    const other = Bun.randomUUIDv7();
    await pool.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
      VALUES ($1, 'https://account.context.test', 'reader'), ($2, 'https://account.context.test', 'other')`,
    [principal, other]);
    await pool.query(`INSERT INTO access.acting_context_preference (principal_id, task, acting_subject, revision)
      VALUES ($1, 'work.create', NULL, $2)`, [principal, Bun.randomUUIDv7()]);
    const before = (await pool.query('SELECT to_jsonb(p)::text AS row FROM access.principal p ORDER BY id')).rows;
    await apply(pool, [OWN, ...later]);
    expect((await pool.query('SELECT to_jsonb(p)::text AS row FROM access.principal p ORDER BY id')).rows).toEqual(before);
    expect((await pool.query('SELECT count(*)::int AS n FROM access.acting_context_preference')).rows[0].n).toBe(1);

    const object = native();
    const relation = 'https://rezics.com/vocab/genre';
    const domain = native();
    const realmContext = native();
    const created = await createSelection(pool, principal, { kind: 'object', object }, realmContext, 'object-1');
    await createSelection(pool, principal, { kind: 'default' }, 'urn:rezics:semantic-context:global', 'default-1');
    await createSelection(pool, principal, { kind: 'domain', domain }, native(), 'domain-1');
    await createSelection(pool, other, { kind: 'object', object }, native(), 'other-object-1');

    // The generated key is the helper's canonical key; one scope has one row per principal.
    const keys = await pool.query<{ scope_key: string }>(`SELECT scope_key FROM access.context_selection
      WHERE id = $1`, [created.selection]);
    expect(keys.rows[0]!.scope_key).toBe(contextSelectionScopeKey({ kind: 'object', object }));
    await expect(createSelection(pool, principal, { kind: 'object', object }, native(), 'object-dup'))
      .rejects.toMatchObject({ code: '23505' });
    await expect(pool.query(`INSERT INTO access.context_selection
      (id, principal_id, scope_profile, scope_kind, scope_object, head_revision)
      VALUES ($1, $2, 'context-selection-scope-v1', 'default', $3, $4)`,
    [Bun.randomUUIDv7(), principal, object, Bun.randomUUIDv7()])).rejects.toMatchObject({ code: '23514' });
    await expect(createSelection(pool, principal, { kind: 'object-relation', object,
      relation: 'not an IRI' }, native(), 'bad-relation')).rejects.toMatchObject({ code: '23514' });

    // A head must resolve to one of its own revisions at commit.
    await expect(inTransaction(pool, client => client.query(`INSERT INTO access.context_selection
      (id, principal_id, scope_profile, scope_kind, scope_object, head_revision)
      VALUES ($1, $2, 'context-selection-scope-v1', 'object', $3, $4)`,
    [Bun.randomUUIDv7(), principal, native(), Bun.randomUUIDv7()]))).rejects.toMatchObject({ code: '23503' });

    // Explicit state: cleared carries no Context; selected needs its pinned semantic revision.
    await expect(inTransaction(pool, client => client.query(`INSERT INTO access.context_selection_revision
      (id, selection_id, generation, predecessor_generation, state, context)
      VALUES ($1, $2, 2, 1, 'cleared', $3)`, [Bun.randomUUIDv7(), created.selection, realmContext])))
      .rejects.toMatchObject({ code: '23514' });
    await expect(inTransaction(pool, client => client.query(`INSERT INTO access.context_selection_revision
      (id, selection_id, generation, predecessor_generation, state, context)
      VALUES ($1, $2, 2, 1, 'selected', $3)`, [Bun.randomUUIDv7(), created.selection, realmContext])))
      .rejects.toMatchObject({ code: '23514' });

    // An orphan future revision cannot commit without becoming the head.
    await expect(inTransaction(pool, client => client.query(`INSERT INTO access.context_selection_revision
      (id, selection_id, generation, predecessor_generation, state) VALUES ($1, $2, 2, 1, 'cleared')`,
    [Bun.randomUUIDv7(), created.selection]))).rejects.toMatchObject({ code: '23514' });
    // A skipped generation has no predecessor.
    await expect(inTransaction(pool, client => client.query(`INSERT INTO access.context_selection_revision
      (id, selection_id, generation, predecessor_generation, state) VALUES ($1, $2, 3, 2, 'cleared')`,
    [Bun.randomUUIDv7(), created.selection]))).rejects.toMatchObject({ code: '23503' });

    // Concurrent compare-and-swap: both prepare generation 2 from generation 1; one wins.
    const first = await pool.connect();
    const second = await pool.connect();
    let cleared: string;
    try {
      await first.query('BEGIN');
      await second.query('BEGIN');
      cleared = await advance(first, created.selection, created.revision, 2, 'cleared', null);
      const racing = advance(second, created.selection, created.revision, 2, 'selected', native());
      racing.catch(() => undefined);
      await first.query(`INSERT INTO access.context_selection_receipt
        (principal_id, idempotency_key, request_digest, selection_id, revision_id) VALUES ($1, 'clear-1', $2, $3, $4)`,
      [principal, digest, created.selection, cleared]);
      await first.query('COMMIT');
      await expect(racing).rejects.toMatchObject({ code: '23505' });
      await second.query('ROLLBACK');
    } finally {
      first.release();
      second.release();
    }
    // A stale expected head moves nothing.
    await expect(inTransaction(pool, client => advance(client, created.selection, created.revision, 3,
      'selected', native()))).rejects.toThrow('stale Context selection head');
    // The head neither moves backwards nor skips, and its scope identity is fixed.
    await expect(pool.query('UPDATE access.context_selection SET head_revision = $1 WHERE id = $2',
      [created.revision, created.selection])).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query('UPDATE access.context_selection SET scope_object = $1 WHERE id = $2',
      [native(), created.selection])).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query('DELETE FROM access.context_selection WHERE id = $1', [created.selection]))
      .rejects.toMatchObject({ code: '23514' });
    const reselected = await inTransaction(pool, client => advance(client, created.selection, cleared!, 3,
      'selected', native()));

    // History and receipts are immutable; a receipt cannot bind another principal's selection.
    await expect(pool.query(`UPDATE access.context_selection_revision SET state = 'cleared', context = NULL,
      semantic_revision = NULL WHERE id = $1`, [created.revision])).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query('DELETE FROM access.context_selection_revision WHERE id = $1', [created.revision]))
      .rejects.toMatchObject({ code: '23514' });
    await expect(pool.query(`UPDATE access.context_selection_receipt SET request_digest = $1
      WHERE principal_id = $2 AND idempotency_key = 'object-1'`, ['d'.repeat(64), principal]))
      .rejects.toMatchObject({ code: '23514' });
    await expect(pool.query(`INSERT INTO access.context_selection_receipt
      (principal_id, idempotency_key, request_digest, selection_id, revision_id) VALUES ($1, 'steal', $2, $3, $4)`,
    [other, digest, created.selection, reselected])).rejects.toMatchObject({ code: '23503' });
    await expect(pool.query(`INSERT INTO access.context_selection_receipt
      (principal_id, idempotency_key, request_digest, selection_id, revision_id) VALUES ($1, 'again', $2, $3, $4)`,
    [principal, digest, created.selection, created.revision])).rejects.toMatchObject({ code: '23505' });

    // Bounded resolver lookup: one probe of the scope index with the candidate keys only.
    const scopes = contextSelectionCandidates(object, relation, [domain]).flat();
    const lookupKeys = privateSelectionLookupKeys(scopes);
    const found = await pool.query<PrivateSelectionCandidateRow>(PRIVATE_SELECTION_LOOKUP_SQL, [principal, lookupKeys]);
    expect(found.rows.map(row => row.scope_key).sort()).toEqual([
      contextSelectionScopeKey({ kind: 'default' }), contextSelectionScopeKey({ kind: 'domain', domain }),
      contextSelectionScopeKey({ kind: 'object', object })].sort());
    expect(found.rows.find(row => row.scope_key.startsWith('object|'))).toMatchObject({
      head_revision: reselected, generation: '3', state: 'selected' });
    const plan = await inTransaction(pool, async (client) => {
      await client.query('SET LOCAL enable_seqscan = off');
      return client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${PRIVATE_SELECTION_LOOKUP_SQL}`
        .replace('$1', `'${principal}'::uuid`).replace('$2', `'{${lookupKeys.map(key => `"${key}"`).join(',')}}'`));
    });
    const text = plan.rows.map(row => row['QUERY PLAN']).join('\n');
    expect(text).toContain('context_selection_scope_once');
    expect(text).not.toMatch(/Seq Scan/);
    expect(() => privateSelectionLookupKeys([...scopes, ...Array.from({ length: 8 },
      () => ({ kind: 'domain' as const, domain: native() }))])).toThrow(RangeError);
  } finally {
    for (const pool of pools) await pool.end();
    await admin.end();
    execFileSync('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop'], { cwd: state });
    rmSync(state, { recursive: true, force: true });
  }
}, 120_000);
