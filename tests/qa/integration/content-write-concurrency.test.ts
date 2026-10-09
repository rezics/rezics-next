import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { startPostgresCluster } from '../support/postgres-cluster.ts';
import { ContentComments, contentCommentIntentDigest } from '../../../services/content/src/comments.ts';
import { appendContentEvent, ContentCore, contentEventPosition, ContentPositionPending,
  type ContentEvent } from '../../../services/content/src/core.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { ContentProjectionCursor } from '../../../services/content/src/projection-cursor.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { relayContentProjectionOnce } from '../../../services/main/src/modules/content-publication/relay.ts';
import { StructureProgressStore } from '../../../services/main/src/modules/progress/store.ts';

const root = resolve(import.meta.dir, '../../..');
const id = () => `https://rezics.com/id/${randomUUID()}`;
const principal = { issuer: 'https://content-write-concurrency.test', subject: randomUUID() };
// Every event here is acknowledged without a graph effect, so no graph is contacted.
const environment = { fuseki: new FusekiClient('http://127.0.0.1:9'),
  lineage: { dataEpoch: 'unused-for-owner-events', routingEpoch: '1' }, objectDirectory: '.temp' };

/** A disposable loopback cluster. A fresh one starts at a low transaction counter. */
async function cluster(name: string) {
  const state = join(root, '.temp', `content-write-concurrency-${name}-${randomUUID()}`);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const started = await startPostgresCluster();
  const pool = new Pool({ ...started.connection, max: 8 });
  return { state, port: started.port, pool, async stop() {
    await pool.end();
    try { started.remove(); }
    finally { rmSync(state, { recursive: true, force: true }); }
  } };
}

async function within<T>(ms: number, work: Promise<T>): Promise<{ value: T; elapsed: number }> {
  const started = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`write did not commit within ${ms} ms`)), ms);
    })]);
    return { value, elapsed: performance.now() - started };
  } finally { clearTimeout(timer); }
}

/** Run the Content projection relay until it is caught up; returns delivered positions. */
async function deliver(content: ContentCore, cursor: ContentProjectionCursor, consumer: string) {
  const delivered: string[] = [];
  for (let step = 0; step < 100; step++) {
    const result = await relayContentProjectionOnce(environment, content, cursor, consumer);
    if (!result) return delivered;
    delivered.push(result.sourceSequence);
  }
  throw new Error('relay did not catch up');
}

async function events(pool: Pool, dataEpoch: string, after: string) {
  return (await pool.query<{ sequence: string; event_type: string; operation_id: string }>(
    `SELECT sequence::text, event_type, operation_id FROM content.outbox
     WHERE data_epoch = $1 AND sequence > $2::bigint ORDER BY sequence`, [dataEpoch, after])).rows;
}

/** A writer whose process stopped after commit, before numbering its event. */
async function stoppedWriter(pool: Pool, operationId: string): Promise<void> {
  const event: ContentEvent = { operationId, requestDigest: 'b'.repeat(64), action: 'export.create',
    outcome: 'rejected', reason: 'stopped after commit', eventType: 'export.create.cancelled',
    recipe: 'export-v1', payload: {} };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await appendContentEvent(client, event);
    await client.query('COMMIT');
  } finally { client.release(); }
}

const progressSave = (store: StructureProgressStore, key: string, library?: { agent: string; work: string }) =>
  store.write({ principal, structure: id(), occurrence: id(), completed: true, position: 'p1',
    expectedVersion: 0, idempotencyKey: key, ...(library ? { library } : {}) });

test('Content writes on unrelated targets commit while one writer holds its transaction, and its later commit is delivered without a gap', async () => {
  const source = await cluster('held');
  const { pool } = source;
  const blocker = await pool.connect();
  try {
    await migrateContent(pool);
    const content = new ContentCore(pool);
    const comments = new ContentComments(pool);
    const progress = new StructureProgressStore(pool);
    const cursor = new ContentProjectionCursor(pool);
    const consumer = 'content-write-concurrency';
    const initial = await cursor.initialize(consumer);

    const work = id();
    const paragraph = 'Commented paragraph';
    const draft = await content.saveDraft({ operationId: `draft-${randomUUID()}`,
      variant: { id: `urn:rezics:variant:${randomUUID()}`, resourceId: work,
        language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr' },
      expectedHead: null, model: 'content-shape-v1', sourceRevision: null, provenance: {},
      serializedJson: JSON.stringify({ body: `First paragraph\n${paragraph}\nLast paragraph` }) });
    expect(draft.position.sequence).toBe('1');

    // The held writer blocks on its Library row after its receipt and event insert.
    const agent = id(), heldWork = id();
    await pool.query('INSERT INTO reader.library_status (agent, work, version) VALUES ($1, $2, 1)',
      [agent, heldWork]);
    await blocker.query('BEGIN');
    await blocker.query('SELECT 1 FROM reader.library_status WHERE agent = $1 AND work = $2 FOR UPDATE',
      [agent, heldWork]);
    const held = progressSave(progress, 'held-progress', { agent, work: heldWork });
    for (let attempt = 0; ; attempt++) {
      const waiting = await pool.query(`SELECT 1 FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND query LIKE 'UPDATE reader.library_status%'`);
      if (waiting.rowCount) break;
      if (attempt === 200) throw new Error('held progress save did not reach its Library projection');
      await Bun.sleep(10);
    }

    const other = await within(1_000, progressSave(progress, 'other-progress', { agent, work: id() }));
    const input = { revisionId: draft.revisionId!, resourceId: work, author: id(), exact: paragraph,
      body: 'Committed while another writer was open' };
    const comment = await within(1_000, comments.create({ ...input, admissionId: randomUUID(),
      authorityEpoch: '1', scope: `content:comment:${work}`, requestDigest: contentCommentIntentDigest(input) }));
    expect(other.elapsed).toBeLessThan(1_000);
    expect(comment.elapsed).toBeLessThan(1_000);
    expect(comment.value.sourcePosition).toEqual({ owner: 'content', dataEpoch: initial.dataEpoch, sequence: '3' });
    expect(await content.ownerPosition()).toEqual({ owner: 'content', dataEpoch: initial.dataEpoch, sequence: '3' });

    await blocker.query('ROLLBACK');
    await held;
    // The held writer took its transaction id first and committed last.
    const xids = (await pool.query<{ idempotency_key: string; xid: string }>(`SELECT idempotency_key,
      xmin::text AS xid FROM structure.progress_command WHERE idempotency_key = ANY($1)`,
    [['held-progress', 'other-progress']])).rows;
    const xid = (key: string) => BigInt(xids.find(row => row.idempotency_key === key)!.xid);
    expect(xid('held-progress')).toBeLessThan(xid('other-progress'));

    expect(await deliver(content, cursor, consumer)).toEqual(['1', '2', '3', '4']);
    const delivered = await events(pool, initial.dataEpoch, initial.sequence);
    expect(delivered.map(row => row.event_type)).toEqual(['content.revision.saved',
      'structure.progress.written', 'content.comment.created', 'structure.progress.written']);
    const heldOperation = (await pool.query<{ content_operation: string }>(`SELECT content_operation
      FROM structure.progress_command WHERE idempotency_key = 'held-progress'`)).rows[0]!.content_operation;
    expect(delivered.at(-1)!.operation_id).toBe(heldOperation);
    expect(await cursor.read(consumer)).toEqual(await content.ownerPosition());
    expect((await pool.query('SELECT 1 FROM content.receipt WHERE sequence IS NULL')).rowCount).toBe(0);

    // While the position row is held (a rebuild activation), writers still commit;
    // the event is numbered once the holder releases it.
    await blocker.query('BEGIN');
    await blocker.query('SELECT 1 FROM content.owner_control WHERE singleton FOR UPDATE');
    await stoppedWriter(pool, 'committed-while-fenced');
    await expect(contentEventPosition(pool, 'committed-while-fenced', 100))
      .rejects.toBeInstanceOf(ContentPositionPending);
    expect(await deliver(content, cursor, consumer)).toEqual([]);
    await blocker.query('ROLLBACK');
    expect(await deliver(content, cursor, consumer)).toEqual(['5']);
    expect(await contentEventPosition(pool, 'committed-while-fenced'))
      .toEqual({ owner: 'content', dataEpoch: initial.dataEpoch, sequence: '5' });
  } finally {
    await blocker.query('ROLLBACK').catch(() => undefined);
    blocker.release();
    await source.stop();
  }
}, 60_000);

test('A logical restore into a fresh cluster keeps numbering and delivering, and a new epoch starts contiguous', async () => {
  const source = await cluster('dump');
  let restored: Awaited<ReturnType<typeof cluster>> | undefined;
  try {
    await migrateContent(source.pool);
    const progress = new StructureProgressStore(source.pool);
    const cursor = new ContentProjectionCursor(source.pool);
    const consumer = 'content-write-concurrency-restore';
    const initial = await cursor.initialize(consumer);
    await progressSave(progress, 'before-dump');
    expect(await deliver(new ContentCore(source.pool), cursor, consumer)).toEqual(['1']);
    // Production clusters run far ahead of a fresh one: one subtransaction id per write.
    await source.pool.query(`DO $$ BEGIN
      CREATE TEMP TABLE burn (x integer);
      FOR i IN 1..20000 LOOP BEGIN INSERT INTO burn VALUES (i); EXCEPTION WHEN OTHERS THEN NULL; END; END LOOP;
    END $$`);
    await stoppedWriter(source.pool, 'committed-before-dump');
    const sourceCounter = BigInt((await source.pool.query<{ xid: string }>(
      'SELECT pg_current_xact_id()::text AS xid')).rows[0]!.xid);

    // pg_dump carries rows and sequences but not the transaction counter.
    const archive = join(source.state, 'content.dump');
    execFileSync('pg_dump', ['-Fc', '-f', archive, '-h', '127.0.0.1', '-p', String(source.port),
      '-U', process.env.USER!, 'postgres'], { cwd: source.state, stdio: 'pipe' });
    restored = await cluster('restore');
    execFileSync('pg_restore', ['--no-owner', '--no-acl', '-h', '127.0.0.1', '-p', String(restored.port),
      '-U', process.env.USER!, '-d', 'postgres', archive], { cwd: restored.state, stdio: 'pipe' });
    const pool = restored.pool;
    expect(BigInt((await pool.query<{ xid: string }>('SELECT pg_current_xact_id()::text AS xid'))
      .rows[0]!.xid)).toBeLessThan(sourceCounter);
    const content = new ContentCore(pool);
    const restoredCursor = new ContentProjectionCursor(pool);
    expect(await content.ownerPosition()).toEqual({ ...initial, sequence: '1' });
    expect(await restoredCursor.read(consumer)).toEqual({ ...initial, sequence: '1' });

    await progressSave(new StructureProgressStore(pool), 'after-restore');
    expect(await deliver(content, restoredCursor, consumer)).toEqual(['2', '3']);
    expect((await events(pool, initial.dataEpoch, '1')).map(row => row.operation_id)[0])
      .toBe('committed-before-dump');

    // A new epoch: positions restart contiguous, an event pending at the cut is
    // numbered in the new epoch, and the old checkpoint is refused.
    await stoppedWriter(pool, 'committed-before-cut');
    await pool.query('UPDATE content.owner_control SET data_epoch = gen_random_uuid(), sequence = 0 WHERE singleton');
    await expect(restoredCursor.read(consumer)).rejects.toThrow('owner epoch changed');
    const next = await restoredCursor.initialize(`${consumer}-next`);
    expect(next.dataEpoch).not.toBe(initial.dataEpoch);
    await progressSave(new StructureProgressStore(pool), 'after-cut');
    expect(await deliver(content, restoredCursor, `${consumer}-next`)).toEqual(['1', '2']);
    expect((await events(pool, next.dataEpoch, '0')).map(row => row.operation_id)[0]).toBe('committed-before-cut');
    expect((await pool.query('SELECT 1 FROM content.receipt WHERE sequence IS NULL')).rowCount).toBe(0);
  } finally {
    await restored?.stop();
    await source.stop();
  }
}, 60_000);
