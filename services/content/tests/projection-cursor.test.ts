import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { startPostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { ContentConflict, ContentCore, ContentUnavailable, type ContentOutboxEvent } from '../src/core.ts';
import { migrateContent } from '../src/migrate.ts';
import { ContentProjectionCursor, CONTENT_PROJECTION_COST } from '../src/projection-cursor.ts';

async function startFixture() {
  const cluster = await startPostgresCluster();
  const pool = new Pool({ ...cluster.connection, max: 8 });
  await migrateContent(pool);
  return { pool, core: new ContentCore(pool), async stop() {
    try { await pool.end(); }
    finally { cluster.remove(); }
  } };
}

let shared: Awaited<ReturnType<typeof startFixture>> | undefined;
beforeAll(async () => { shared = await startFixture(); });
afterAll(async () => { await shared?.stop(); shared = undefined; });

async function scenario() {
  if (!shared) throw new Error('projection cursor fixture is not ready');
  const { pool, core } = shared;
  const cursor = new ContentProjectionCursor(pool);
  const consumer = `cursor-${randomUUID()}`;
  await cursor.initialize(consumer);
  // Each consumer starts at the real source origin; earlier cases leave only
  // genuine immutable events, which this independent consumer evaluates first.
  while (true) {
    const scan = await cursor.readScan(consumer);
    const events = await core.readOutbox(scan.dataEpoch, scan.sequence, 100);
    if (!events.length) break;
    let expected = scan;
    for (const event of events) {
      await cursor.acknowledge(consumer, expected, event.position);
      expected = event.position;
    }
  }
  const heads = new Map<string, string>();
  const draft = async (target = `urn:rezics:variant:${randomUUID()}`) => {
    const operationId = `cursor-draft:${randomUUID()}`;
    const saved = await core.saveDraft({ operationId,
      variant: { id: target, resourceId: target.replace(':variant:', ':work:'),
        language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr' },
      expectedHead: heads.get(target) ?? null, model: 'content-shape-v1', sourceRevision: null,
      provenance: { source: 'projection-cursor-test' }, serializedJson: '{"body":"cursor proof"}' });
    if (!saved.revisionId) throw new Error('draft produced no revision');
    heads.set(target, saved.revisionId);
    const event = (await core.readOutbox(saved.position.dataEpoch,
      (BigInt(saved.position.sequence) - 1n).toString(), 1))[0];
    if (!event || event.operationId !== operationId
      || event.position.sequence !== saved.position.sequence) throw new Error('draft event is missing');
    return { event, target };
  };
  const retain = async (source: { event: ContentOutboxEvent; target: string }) => {
    await cursor.acknowledge(consumer, await cursor.readScan(consumer), source.event.position, source);
  };
  const snapshot = async () => ({
    checkpoint: (await pool.query(`SELECT data_epoch, sequence::text, scan_sequence::text, pending_count::text
      FROM content.projection_checkpoint WHERE consumer = $1`, [consumer])).rows,
    pending: (await pool.query(`SELECT sequence::text, event_id, target FROM content.projection_pending
      WHERE consumer = $1 ORDER BY sequence`, [consumer])).rows,
    targets: (await pool.query(`SELECT target, first_sequence::text, attempted_at FROM content.projection_target
      WHERE consumer = $1 ORDER BY target`, [consumer])).rows,
  });
  return { pool, core, cursor, consumer, draft, retain, snapshot };
}

test('Content retries only the oldest same-target source and duplicate completion preserves its successor', async () => {
  const f = await scenario();
  const first = await f.draft();
  const later = await f.draft(first.target);
  await f.retain(first);
  await f.retain(later);
  const before = await f.snapshot();
  expect((await f.cursor.retries(f.consumer)).map(event => event.id)).toEqual([first.event.id]);
  await expect(f.cursor.finishRetry(f.consumer, later.event, true)).rejects.toBeInstanceOf(ContentConflict);
  await expect(f.cursor.finishRetry(f.consumer, later.event, false)).rejects.toBeInstanceOf(ContentConflict);
  expect(await f.snapshot()).toEqual(before);

  await Promise.all([
    f.cursor.finishRetry(f.consumer, first.event, true),
    f.cursor.finishRetry(f.consumer, first.event, true),
  ]);
  expect((await f.cursor.retries(f.consumer)).map(event => event.id)).toEqual([later.event.id]);
  expect((await f.cursor.read(f.consumer)).sequence).toBe((BigInt(later.event.position.sequence) - 1n).toString());
  const promoted = await f.snapshot();
  expect(promoted.checkpoint[0]?.pending_count).toBe('1');
  await f.cursor.finishRetry(f.consumer, first.event, false);
  expect(await f.snapshot()).toEqual(promoted);
  await f.cursor.finishRetry(f.consumer, later.event, true);
  expect(await f.cursor.read(f.consumer)).toEqual(later.event.position);
  expect((await f.snapshot()).checkpoint[0]?.pending_count).toBe('0');
}, 60_000);

test('Content serializes source acknowledgement against retry completion and retains the next target head', async () => {
  const f = await scenario();
  const first = await f.draft();
  await f.retain(first);
  const later = await f.draft(first.target);
  const expected = await f.cursor.readScan(f.consumer);
  await Promise.all([
    f.cursor.acknowledge(f.consumer, expected, later.event.position, later),
    f.cursor.finishRetry(f.consumer, first.event, true),
  ]);
  expect((await f.cursor.retries(f.consumer)).map(event => event.id)).toEqual([later.event.id]);
  const state = await f.snapshot();
  expect(state.pending).toHaveLength(1);
  expect(state.targets).toHaveLength(1);
  expect(state.targets[0]?.first_sequence).toBe(later.event.position.sequence);
  expect(state.checkpoint[0]?.pending_count).toBe('1');
  expect((await f.cursor.read(f.consumer)).sequence).toBe(first.event.position.sequence);
  await f.cursor.finishRetry(f.consumer, later.event, true);
  expect(await f.cursor.read(f.consumer)).toEqual(later.event.position);
}, 60_000);

test('Content rolls back retry removal, target promotion, pending count and coverage together', async () => {
  const f = await scenario();
  const first = await f.draft();
  const later = await f.draft(first.target);
  await f.retain(first);
  await f.retain(later);
  const before = await f.snapshot();
  await f.pool.query(`CREATE FUNCTION content.fail_cursor_retry() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.consumer = TG_ARGV[0] THEN RAISE EXCEPTION 'forced retry rollback'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER fail_cursor_retry BEFORE UPDATE ON content.projection_checkpoint
      FOR EACH ROW EXECUTE FUNCTION content.fail_cursor_retry('${f.consumer}')`);
  try {
    await expect(f.cursor.finishRetry(f.consumer, first.event, true)).rejects.toThrow('forced retry rollback');
    expect(await f.snapshot()).toEqual(before);
    expect((await f.cursor.retries(f.consumer)).map(event => event.id)).toEqual([first.event.id]);
  } finally {
    await f.pool.query(`DROP TRIGGER fail_cursor_retry ON content.projection_checkpoint;
      DROP FUNCTION content.fail_cursor_retry()`);
  }
  await f.cursor.finishRetry(f.consumer, first.event, true);
  expect((await f.cursor.retries(f.consumer)).map(event => event.id)).toEqual([later.event.id]);
}, 60_000);

test('Content refuses foreign, forged, missing and unscanned retry sources without changing retained coverage', async () => {
  const f = await scenario();
  const first = await f.draft();
  await f.retain(first);
  const before = await f.snapshot();
  await expect(f.cursor.finishRetry(f.consumer, { ...first.event,
    position: { ...first.event.position, dataEpoch: randomUUID() } }, true)).rejects.toBeInstanceOf(ContentConflict);
  await expect(f.cursor.finishRetry(f.consumer, { ...first.event, id: randomUUID() }, true))
    .rejects.toBeInstanceOf(ContentConflict);
  const missing = { ...first.event, position: { ...first.event.position,
    sequence: (BigInt(first.event.position.sequence) + 1n).toString() } };
  await expect(f.cursor.finishRetry(f.consumer, missing, true)).rejects.toBeInstanceOf(ContentUnavailable);
  expect(await f.snapshot()).toEqual(before);

  const unscanned = await f.draft();
  await expect(f.cursor.finishRetry(f.consumer, unscanned.event, true)).rejects.toBeInstanceOf(ContentConflict);
  expect(await f.snapshot()).toEqual(before);
}, 60_000);

test('Content bounds retries by target and rotates unresolved heads without exposing their successors', async () => {
  const f = await scenario();
  const sources: Array<Awaited<ReturnType<typeof f.draft>>> = [];
  for (let n = 0; n < CONTENT_PROJECTION_COST.retryEvents + 2; n++) {
    const source = await f.draft();
    sources.push(source);
    await f.retain(source);
  }
  const later = await f.draft(sources[0]!.target);
  await f.retain(later);
  const first = await f.cursor.retries(f.consumer);
  expect(first).toHaveLength(CONTENT_PROJECTION_COST.retryEvents);
  expect(first.some(event => event.id === later.event.id)).toBe(false);
  for (const event of first) await f.cursor.finishRetry(f.consumer, event, false);
  const second = await f.cursor.retries(f.consumer);
  expect(second).toHaveLength(CONTENT_PROJECTION_COST.retryEvents);
  expect(second.some(event => event.id === later.event.id)).toBe(false);
  const visited = new Set([...first, ...second].map(event => event.id));
  expect(visited.size).toBe(sources.length);
  expect((await f.snapshot()).checkpoint[0]?.pending_count).toBe(String(sources.length + 1));
  expect((await f.cursor.read(f.consumer)).sequence)
    .toBe((BigInt(sources[0]!.event.position.sequence) - 1n).toString());
}, 60_000);
