import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { startPostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { appendContentEvent, ContentConflict, ContentCore, ContentUnavailable, type ContentOutboxEvent } from '../src/core.ts';
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

async function rebuildScenario() {
  const f = await scenario();
  const first = await f.draft();
  const second = await f.draft(first.target);
  await f.retain(first);
  await f.retain(second);
  const rebuildConsumer = `rebuild-${randomUUID()}`;
  await f.cursor.initialize(rebuildConsumer);
  while (true) {
    const scan = await f.cursor.readScan(rebuildConsumer);
    const events = await f.core.readOutbox(scan.dataEpoch, scan.sequence, 100);
    if (!events.length) break;
    let expected = scan;
    for (const event of events) {
      await f.cursor.acknowledge(rebuildConsumer, expected, event.position);
      expected = event.position;
    }
  }
  const cut = await f.core.ownerPosition();
  const resolveTarget = async (event: ContentOutboxEvent) => {
    // Cursor has reconstructed this exact immutable event; Main's resolver uses
    // the original settled publication pin rather than a current mutable head.
    const source = [first, second].find(source => source.event.id === event.id);
    if (!source) throw new Error('original projection source missing');
    expect(event).toEqual(source.event);
    return source.target;
  };
  const adopt = (resolve = resolveTarget, activation = async () => undefined) =>
    f.cursor.adoptRebuildCheckpoint(f.consumer, rebuildConsumer, cut, resolve, activation);
  return { ...f, first, second, rebuildConsumer, cut, resolveTarget, adopt };
}

test('[SEARCH20/OPS16] Content adopts a verified rebuild prefix and retires only its parked live sources', async () => {
  const f = await rebuildScenario();
  const unrelatedConsumer = `unrelated-${randomUUID()}`;
  await f.cursor.initialize(unrelatedConsumer);
  const unrelatedBefore = (await f.pool.query(`SELECT * FROM content.projection_checkpoint
    WHERE consumer = $1`, [unrelatedConsumer])).rows;
  const resolved: string[] = [];
  let verified = 0;
  await f.adopt(async event => { resolved.push(event.id); return f.resolveTarget(event); }, async () => { verified++; });
  expect(resolved).toEqual([f.first.event.id, f.second.event.id]);
  expect(verified).toBe(1);
  expect(await f.cursor.read(f.consumer)).toEqual(f.cut);
  expect(await f.cursor.readScan(f.consumer)).toEqual(f.cut);
  const after = await f.snapshot();
  expect(after.pending).toHaveLength(0);
  expect(after.targets).toHaveLength(0);
  expect(after.checkpoint[0]?.pending_count).toBe('0');
  expect((await f.pool.query(`SELECT * FROM content.projection_checkpoint WHERE consumer = $1`,
    [unrelatedConsumer])).rows).toEqual(unrelatedBefore);
  await f.adopt();
  expect(await f.snapshot()).toEqual(after);
}, 60_000);

test('[SEARCH20/OPS16] Content refuses wrong targets, foreign or missing exact sources and inconsistent parked counts', async () => {
  const mutations = [
    async (f: Awaited<ReturnType<typeof rebuildScenario>>) => {
      await f.pool.query(`UPDATE content.projection_pending SET target = 'urn:rezics:variant:wrong'
        WHERE consumer = $1 AND event_id = $2`, [f.consumer, f.first.event.id]);
    },
    async (f: Awaited<ReturnType<typeof rebuildScenario>>) => {
      await f.pool.query(`UPDATE content.projection_pending SET event_id = $2
        WHERE consumer = $1 AND sequence = $3`, [f.consumer, f.second.event.id, f.first.event.position.sequence]);
    },
    async (f: Awaited<ReturnType<typeof rebuildScenario>>) => {
      await f.pool.query(`DELETE FROM content.projection_target WHERE consumer = $1`, [f.consumer]);
      await f.pool.query(`UPDATE content.projection_pending SET data_epoch = $2 WHERE consumer = $1`,
        [f.consumer, randomUUID()]);
    },
    async (f: Awaited<ReturnType<typeof rebuildScenario>>) => {
      await f.pool.query(`UPDATE content.projection_pending SET target = '' WHERE consumer = $1`, [f.consumer]);
    },
    async (f: Awaited<ReturnType<typeof rebuildScenario>>) => {
      await f.pool.query(`UPDATE content.projection_checkpoint SET pending_count = 0 WHERE consumer = $1`, [f.consumer]);
    },
    async (f: Awaited<ReturnType<typeof rebuildScenario>>) => {
      await f.pool.query(`UPDATE content.projection_target SET first_sequence = $2 WHERE consumer = $1`,
        [f.consumer, f.second.event.position.sequence]);
    },
    async (f: Awaited<ReturnType<typeof rebuildScenario>>) => {
      await f.pool.query(`DELETE FROM content.projection_target WHERE consumer = $1`, [f.consumer]);
      await f.pool.query(`UPDATE content.projection_pending SET sequence = $2
        WHERE consumer = $1 AND event_id = $3`,
      [f.consumer, (BigInt(f.cut.sequence) + 1n).toString(), f.second.event.id]);
    },
  ];
  for (const mutate of mutations) {
    const f = await rebuildScenario();
    await mutate(f);
    const before = await f.snapshot();
    await expect(f.adopt()).rejects.toBeInstanceOf(ContentConflict);
    expect(await f.snapshot()).toEqual(before);
  }
}, 60_000);

test('[SEARCH20/OPS16] Content requires exact owner, both cursor bounds and a completely closed replay', async () => {
  const mutations = [
    async (f: Awaited<ReturnType<typeof rebuildScenario>>) => { await f.draft(); },
    async (f: Awaited<ReturnType<typeof rebuildScenario>>) => {
      await f.pool.query(`UPDATE content.projection_checkpoint SET scan_sequence = $2 WHERE consumer = $1`,
        [f.rebuildConsumer, (BigInt(f.cut.sequence) + 1n).toString()]);
    },
    async (f: Awaited<ReturnType<typeof rebuildScenario>>) => {
      await f.pool.query(`UPDATE content.projection_checkpoint SET data_epoch = $2 WHERE consumer = $1`,
        [f.consumer, randomUUID()]);
    },
    async (f: Awaited<ReturnType<typeof rebuildScenario>>) => {
      await f.pool.query(`INSERT INTO content.projection_pending(consumer,data_epoch,sequence,event_id,target)
        VALUES($1,$2,$3,$4,$5)`, [f.rebuildConsumer, randomUUID(), f.first.event.position.sequence,
        f.first.event.id, f.first.target]);
    },
  ];
  for (const mutate of mutations) {
    const f = await rebuildScenario();
    await mutate(f);
    const before = await f.snapshot();
    await expect(f.adopt()).rejects.toBeInstanceOf(ContentConflict);
    expect(await f.snapshot()).toEqual(before);
  }
}, 60_000);

test('[SEARCH20/OPS16] Content rolls back parked rows, targets and counts when activation or promotion fails', async () => {
  const f = await rebuildScenario();
  const before = await f.snapshot();
  await expect(f.adopt(async () => { throw new Error('settled source unavailable'); }))
    .rejects.toThrow('settled source unavailable');
  expect(await f.snapshot()).toEqual(before);
  await expect(f.adopt(f.resolveTarget, async () => { throw new Error('activation control moved'); }))
    .rejects.toThrow('activation control moved');
  expect(await f.snapshot()).toEqual(before);
  await f.pool.query(`CREATE FUNCTION content.fail_cursor_adoption() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.consumer = TG_ARGV[0] THEN RAISE EXCEPTION 'forced adoption rollback'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER fail_cursor_adoption BEFORE UPDATE ON content.projection_checkpoint
      FOR EACH ROW EXECUTE FUNCTION content.fail_cursor_adoption('${f.consumer}')`);
  try {
    await expect(f.adopt()).rejects.toThrow('forced adoption rollback');
    expect(await f.snapshot()).toEqual(before);
  } finally {
    await f.pool.query(`DROP TRIGGER fail_cursor_adoption ON content.projection_checkpoint;
      DROP FUNCTION content.fail_cursor_adoption()`);
  }
  await f.adopt();
  expect(await f.cursor.read(f.consumer)).toEqual(f.cut);
}, 60_000);

test('[SEARCH20/OPS16] Content serializes adoption, retry completion and a competing adoption under checkpoint locks', async () => {
  const f = await rebuildScenario();
  let releaseActivation!: () => void;
  const activationHeld = new Promise<void>(resolve => { releaseActivation = resolve; });
  let locked!: () => void;
  const locksHeld = new Promise<void>(resolve => { locked = resolve; });
  const first = f.adopt(f.resolveTarget, async () => { locked(); await activationHeld; });
  await locksHeld;
  const retry = f.cursor.finishRetry(f.consumer, f.first.event, true);
  const second = f.adopt();
  releaseActivation();
  await Promise.all([first, retry, second]);
  expect(await f.cursor.read(f.consumer)).toEqual(f.cut);
  const after = await f.snapshot();
  expect(after.pending).toHaveLength(0);
  expect(after.targets).toHaveLength(0);
  expect(after.checkpoint[0]?.pending_count).toBe('0');
}, 60_000);

test('[SEARCH20/OPS16] Content refuses activation recovery while a committed source has no owner position', async () => {
  const f = await rebuildScenario();
  const before = await f.snapshot();
  const client = await f.pool.connect();
  try {
    await client.query('BEGIN');
    await appendContentEvent(client, { operationId: `cursor-unsequenced:${randomUUID()}`,
      requestDigest: '0'.repeat(64), action: 'draft.save', outcome: 'rejected',
      reason: 'fixture-retained-event', eventType: 'content.draft.stale',
      recipe: f.first.event.recipe, payload: { reason: 'fixture-retained-event' } });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
  try {
    expect(await f.core.ownerPosition()).toEqual(f.cut);
    expect(await f.core.hasUnsequencedEvents()).toBe(true);
    await expect(f.adopt()).rejects.toThrow('committed Content events remain unsequenced');
    expect(await f.snapshot()).toEqual(before);
    expect(await f.core.ownerPosition()).toEqual(f.cut);
  } finally { await f.core.sequencePending(); }
  expect(await f.core.hasUnsequencedEvents()).toBe(false);
  expect((await f.core.ownerPosition()).sequence).toBe((BigInt(f.cut.sequence) + 1n).toString());
  await expect(f.adopt()).rejects.toThrow('Content owner moved before checkpoint promotion');
  expect(await f.snapshot()).toEqual(before);
}, 60_000);
