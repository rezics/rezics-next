// sql-relations-allow: reader.library_import_source_erasure_probe -- Test-only foreign-key probe that blocks one source deletion to prove the agent transaction rolls back.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { deleteLibraryUploads, eraseLibraryImportsForPrincipals } from
  '../../../services/main/src/modules/library-import/privacy.ts';
import { cloneQaOwnerDatabases } from '../support/fake-delivery.ts';

const root = resolve(import.meta.dir, '../../..');
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const agentIri = () => `https://rezics.com/id/${randomUUID()}`;
const evidence = ['library_import_source', 'library_import_source_row', 'library_import_file',
  'library_import_session_effect', 'library_import_step', 'library_import_upload_command'] as const;
type Evidence = Record<(typeof evidence)[number], number>;
type Kind = 'person' | 'organization' | 'service';
const empty: Evidence = {
  library_import_source: 0, library_import_source_row: 0, library_import_file: 0,
  library_import_session_effect: 0, library_import_step: 0, library_import_upload_command: 0 };

let databases: Awaited<ReturnType<typeof cloneQaOwnerDatabases>>;
let content: Pool;
let access: Pool;

beforeAll(async () => {
  const runId = Bun.env.REZICS_QA_RUN_ID;
  if (!runId) throw new Error('Run through the isolated QA integration tier');
  databases = await cloneQaOwnerDatabases(runId, ['access', 'content']);
  content = new Pool({ connectionString: databases.urls.content, max: 4, connectionTimeoutMillis: 1_500 });
  access = new Pool({ connectionString: databases.urls.access, max: 4, connectionTimeoutMillis: 1_500 });
  // The QA content template is empty; Access is already migrated.
  await migrateContent(content);
}, 120_000);

afterAll(async () => {
  await Promise.allSettled([content?.end(), access?.end()]);
  await databases?.close();
}, 30_000);

async function principal(active: boolean, fenced: boolean): Promise<string> {
  const id = randomUUID();
  await access.query(`INSERT INTO access.principal (id, account_issuer, account_subject, active)
    VALUES ($1,$2,$3,$4)`, [id, `https://accounts.test/${id}`, id, active]);
  if (fenced) await access.query(`INSERT INTO access.outbox (id, kind, principal_id, authority_epoch)
    VALUES ($1,'account.deletion_fenced',$2,0)`, [randomUUID(), id]);
  return id;
}

async function provision(principalId: string, kind: Kind): Promise<string> {
  const agent = agentIri();
  await access.query(`INSERT INTO access.agent_provision
    (id, principal_id, idempotency_key, request_digest, agent_id, agent_kind, display_name, principal_epoch)
    VALUES ($1,$2,$3,$4,$5,$6,$7,0)`,
  [randomUUID(), principalId, `${kind}:${randomUUID()}`, digest(`${principalId}:${agent}`), agent, kind, kind]);
  return agent;
}

async function inventory(agent: string): Promise<Evidence> {
  const counts = await Promise.all(evidence.map(async table => (await content.query<{ n: number }>(
    `SELECT count(*)::integer AS n FROM reader.${table} WHERE agent=$1`, [agent])).rows[0]!.n));
  return Object.fromEntries(evidence.map((table, index) => [table, counts[index]!])) as Evidence;
}

/** A source with no file. Upload deletion never selects it. */
async function orphan(agent: string, label: string): Promise<string> {
  const sourceDigest = digest(`${agent}:${label}`);
  await content.query(`INSERT INTO reader.library_import_source (agent, digest, source)
    VALUES ($1,$2,$3::jsonb)`, [agent, sourceDigest, JSON.stringify({ kind: 'entry', sourceId: label })]);
  return sourceDigest;
}

/** One upload. The same digest may be named by another file of this agent. */
async function upload(agent: string, label: string, digests: readonly string[]): Promise<{ id: string; key: string }> {
  if (!digests.length) throw new Error('An upload names at least one source');
  const id = randomUUID();
  const key = `file:${label}:${id}`;
  await content.query(`INSERT INTO reader.library_import_batch (agent, import_key, request_digest, row_count)
    VALUES ($1,$2,$3,$4)`, [agent, key, digest(key), digests.length]);
  await content.query(`INSERT INTO reader.library_import_file (agent, id, import_key, format, file_digest)
    VALUES ($1,$2,$3,'generic-csv',$4)`, [agent, id, key, digest(`bytes:${agent}:${label}`)]);
  for (const [index, sourceDigest] of digests.entries()) {
    await content.query(`INSERT INTO reader.library_import_source (agent, digest, source)
      VALUES ($1,$2,$3::jsonb) ON CONFLICT DO NOTHING`,
    [agent, sourceDigest, JSON.stringify({ kind: 'entry', sourceId: sourceDigest })]);
    await content.query(`INSERT INTO reader.library_import_source_row (agent, file_id, row_number, source_digest)
      VALUES ($1,$2,$3,$4)`, [agent, id, index, sourceDigest]);
  }
  await content.query(`INSERT INTO reader.library_import_step (agent, import_key, row_number, step_key, plan)
    VALUES ($1,$2,0,'apply',$3::jsonb)`, [agent, key, JSON.stringify({ label })]);
  await content.query(`INSERT INTO reader.library_import_session_effect
    (agent, source_identity, session_id, desired_digest) VALUES ($1,$2,$3,$4)`,
  [agent, key, randomUUID(), digest(key)]);
  await content.query(`INSERT INTO reader.library_import_upload_command
    (agent, idempotency_key, request_digest, file_id) VALUES ($1,$2,$3,$4)`,
  [agent, key, digest(`command:${key}`), id]);
  return { id, key };
}

async function withContent<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await content.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

async function transactionIdentity(client: PoolClient) {
  return (await client.query<{ pid: number; transaction: string }>(
    'SELECT pg_backend_pid() AS pid, txid_current()::text AS transaction')).rows[0]!;
}

async function uploadLockAvailable(agent: string): Promise<boolean> {
  const held = await content.connect();
  try {
    await held.query('BEGIN');
    return (await held.query<{ available: boolean }>(
      'SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS available',
      [JSON.stringify(['library-upload', agent])])).rows[0]!.available;
  } finally { await held.query('ROLLBACK'); held.release(); }
}

test('account erasure removes an orphan library import source that no file names', async () => {
  const deleted = await principal(false, true);
  const agent = await provision(deleted, 'person');
  const keeperId = await principal(false, true);
  const keeper = await provision(keeperId, 'person');
  const sourceDigest = await orphan(agent, 'no-file');
  await orphan(keeper, 'no-file');
  await upload(agent, 'rolls-back', [digest(`${agent}:held`)]);
  // No matching file: upload deletion returns before it looks at sources.
  await withContent(client => deleteLibraryUploads(client, agent, [randomUUID()]));
  expect(await inventory(agent)).toMatchObject({ library_import_source: 2, library_import_file: 1 });

  // A source that cannot be removed aborts the whole agent transaction, so the
  // upload deleted earlier in that transaction comes back.
  await content.query(`CREATE TABLE reader.library_import_source_erasure_probe (
    agent text NOT NULL, digest text NOT NULL, PRIMARY KEY (agent, digest),
    FOREIGN KEY (agent, digest) REFERENCES reader.library_import_source(agent, digest))`);
  try {
    await content.query('INSERT INTO reader.library_import_source_erasure_probe (agent, digest) VALUES ($1,$2)',
      [agent, sourceDigest]);
    const beforeFailure = await inventory(agent);
    await expect(eraseLibraryImportsForPrincipals(content, access, [deleted])).rejects.toThrow(/library_import_source/);
    expect(await inventory(agent)).toEqual(beforeFailure);
    expect((await inventory(keeper)).library_import_source).toBe(1);
  } finally {
    await content.query('DROP TABLE IF EXISTS reader.library_import_source_erasure_probe');
  }

  await eraseLibraryImportsForPrincipals(content, access, [deleted]);
  expect(await inventory(agent)).toEqual(empty);
  expect((await inventory(keeper)).library_import_source).toBe(1);
  // A restored copy of the same orphan is erased by the same cleanup.
  await orphan(agent, 'no-file');
  await eraseLibraryImportsForPrincipals(content, access, [deleted]);
  expect(await inventory(agent)).toEqual(empty);
  expect((await inventory(keeper)).library_import_source).toBe(1);
}, 60_000);

test('account erasure removes a file-backed source and keeps one another file or agent still names', async () => {
  const deleted = await principal(false, true);
  const agent = await provision(deleted, 'person');
  const keeperId = await principal(true, false);
  const keeper = await provision(keeperId, 'person');
  const shared = digest('shared-source');
  const onlyDeleted = digest(`${agent}:only`);
  const first = await upload(agent, 'first', [shared, onlyDeleted]);
  const second = await upload(agent, 'second', [shared]);
  await upload(keeper, 'same-digest', [shared, digest(`${keeper}:only`)]);
  const leftover = await orphan(agent, 'beside-files');
  await orphan(keeper, 'beside-files');
  const keeperBefore = await inventory(keeper);

  await withContent(client => deleteLibraryUploads(client, agent, [first.id]));
  // The deleted upload's own source and replay plan go. The digest the other
  // file still names, its applied-session receipt and the orphan stay.
  expect(await inventory(agent)).toMatchObject({
    library_import_file: 1, library_import_source_row: 1, library_import_step: 1,
    library_import_session_effect: 2, library_import_upload_command: 2, library_import_source: 2 });
  expect(new Set((await content.query<{ digest: string }>(
    'SELECT digest FROM reader.library_import_source WHERE agent=$1', [agent])).rows.map(row => row.digest)))
    .toEqual(new Set([shared, leftover]));
  expect((await content.query(
    'SELECT 1 FROM reader.library_import_source WHERE agent=$1 AND digest=$2', [agent, onlyDeleted])).rowCount).toBe(0);
  expect((await content.query(
    'SELECT file_id FROM reader.library_import_upload_command WHERE agent=$1 AND idempotency_key=$2',
    [agent, first.key])).rows[0]!.file_id).toBeNull();
  expect((await content.query(
    'SELECT 1 FROM reader.library_import_session_effect WHERE agent=$1 AND source_identity=$2',
    [agent, first.key])).rowCount).toBe(1);
  expect((await content.query(
    'SELECT 1 FROM reader.library_import_step WHERE agent=$1 AND import_key=$2',
    [agent, first.key])).rowCount).toBe(0);
  expect((await content.query(
    'SELECT 1 FROM reader.library_import_step WHERE agent=$1 AND import_key=$2',
    [agent, second.key])).rowCount).toBe(1);
  expect(await inventory(keeper)).toEqual(keeperBefore);

  await eraseLibraryImportsForPrincipals(content, access, [deleted]);
  expect(await inventory(agent)).toEqual(empty);
  expect(await inventory(keeper)).toEqual(keeperBefore);
  expect((await content.query(
    'SELECT 1 FROM reader.library_import_source WHERE agent=$1 AND digest=$2', [keeper, shared])).rowCount).toBe(1);
}, 60_000);

test('account erasure removes only a deleted own Person and leaves active and delegated agents', async () => {
  const deleted = await principal(false, true);
  const own = await provision(deleted, 'person');
  const ownAgain = await provision(deleted, 'person');
  const organization = await provision(deleted, 'organization');
  const service = await provision(deleted, 'service');
  const activeId = await principal(true, true);
  const active = await provision(activeId, 'person');
  const unfencedId = await principal(false, false);
  const unfenced = await provision(unfencedId, 'person');
  const outsiderId = await principal(false, true);
  const outsider = await provision(outsiderId, 'person');
  await orphan(own, 'own');
  await upload(ownAgain, 'own-file', [digest(`${ownAgain}:file`)]);
  await upload(organization, 'delegated', [digest(`${organization}:file`)]);
  await orphan(service, 'delegated');
  await orphan(active, 'active');
  await orphan(unfenced, 'unfenced');
  await orphan(outsider, 'outsider');
  const kept = {
    organization: await inventory(organization), service: await inventory(service),
    active: await inventory(active), unfenced: await inventory(unfenced), outsider: await inventory(outsider) };

  await eraseLibraryImportsForPrincipals(content, access, [deleted, activeId, unfencedId]);
  expect(await inventory(own)).toEqual(empty);
  expect(await inventory(ownAgain)).toEqual(empty);
  expect(await inventory(organization)).toEqual(kept.organization);
  expect(await inventory(service)).toEqual(kept.service);
  expect(await inventory(active)).toEqual(kept.active);
  expect(await inventory(unfenced)).toEqual(kept.unfenced);
  expect(await inventory(outsider)).toEqual(kept.outsider);
}, 60_000);

test('account erasure reuses one borrowed Access client and existing callers pass that client', async () => {
  const compact = (path: string) => readFileSync(resolve(root, path), 'utf8').replaceAll(/\s+/g, '');
  expect(compact('services/main/src/modules/erasure/account.ts'))
    .toContain('eraseLibraryImportsForPrincipals(content,access,[principal.id])');
  expect(compact('services/main/src/modules/library-import/retention-worker.ts'))
    .toContain('eraseLibraryImportsForPrincipals(this.content,this.access,inactive)');
  expect(compact('services/main/src/modules/erasure/reconcile.ts'))
    .toContain('eraseLibraryImportsForPrincipals(restored.content,accessClient,principals)');
  const privacy = compact('services/main/src/modules/library-import/privacy.ts');
  expect(privacy).toContain('access:Pool|PoolClient');
  expect(privacy).not.toContain('access.connect');

  const deleted = await principal(false, true);
  const agent = await provision(deleted, 'person');
  const keeperId = await principal(false, true);
  const keeper = await provision(keeperId, 'person');
  await orphan(agent, 'borrowed');
  await orphan(keeper, 'borrowed');
  // The only Access connection is the caller's. A second checkout would time out.
  const limited = new Pool({ connectionString: databases.urls.access, max: 1, connectionTimeoutMillis: 1_500 });
  try {
    const client = await limited.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '11s'");
      await client.query("SET LOCAL statement_timeout = '13s'");
      const identity = await transactionIdentity(client);
      await client.query('SAVEPOINT caller_owned');
      const marker = randomUUID();
      await client.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
        VALUES ($1,$2,$3)`, [marker, `https://accounts.test/marker-${marker}`, marker]);
      await eraseLibraryImportsForPrincipals(content, client, [deleted]);
      expect(await inventory(agent)).toEqual(empty);
      expect((await inventory(keeper)).library_import_source).toBe(1);
      expect(await transactionIdentity(client)).toEqual(identity);
      expect((await client.query<{ lock_timeout: string }>('SHOW lock_timeout')).rows[0]!.lock_timeout).toBe('11s');
      expect((await client.query<{ statement_timeout: string }>('SHOW statement_timeout')).rows[0]!.statement_timeout).toBe('13s');
      expect((await access.query('SELECT 1 FROM access.principal WHERE id=$1', [marker])).rowCount).toBe(0);
      expect((await client.query('SELECT 1 FROM access.principal WHERE id=$1', [marker])).rowCount).toBe(1);
      expect(await uploadLockAvailable(agent)).toBe(true);
      await client.query('ROLLBACK TO SAVEPOINT caller_owned');
      expect((await client.query('SELECT 1 FROM access.principal WHERE id=$1', [marker])).rowCount).toBe(0);
      expect(await inventory(agent)).toEqual(empty);
    } finally { await client.query('ROLLBACK'); client.release(); }
    await orphan(agent, 'restored-through-pool');
    await eraseLibraryImportsForPrincipals(content, limited, [deleted]);
    expect(await inventory(agent)).toEqual(empty);
    expect((await inventory(keeper)).library_import_source).toBe(1);
    await limited.query('SELECT 1');
  } finally { await limited.end(); }
}, 60_000);
