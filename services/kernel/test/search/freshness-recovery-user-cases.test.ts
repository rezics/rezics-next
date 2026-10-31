import { afterAll, beforeAll, expect, test } from 'bun:test';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { parseText } from '../../src/search/text.ts';
import {
  createReleasedDiscoveryFixture,
  type CreatedSubject,
  type ReleasedDiscoveryFixture,
} from '../support/released-discovery.ts';
import type { ReleasedNativeBoundRequest } from './support/released-discovery-runtime.ts';

let fixture: ReleasedDiscoveryFixture;
let witness: CreatedSubject;
const marker = `Wallclock${crypto.randomUUID().replaceAll('-', '')}`;
const DAY_MS = 24 * 60 * 60 * 1000;
const SOURCE_LAG_THRESHOLD_MS = 300_000;
// Fixture precondition only: lets a genuinely committed envelope age beyond the existing threshold.
// Request, repair, lease and preparation budgets keep their production values.
const SOURCE_LAG_PRECONDITION_GUARD_MS = SOURCE_LAG_THRESHOLD_MS + 15_000;
const context = () => ({ deadline: Date.now() + 10_000 });

beforeAll(async () => {
  fixture = await createReleasedDiscoveryFixture({ version: 1, search: 'native' });
  await fixture.setup.openFeatures(['search']);
  witness = await fixture.createSubject('schema:Book', marker);
  await fixture.search!.converge([witness]);
}, 120_000);

afterAll(async () => {
  await fixture?.close();
}, 180_000);

async function databaseNow(): Promise<number> {
  const result = await fixture.inspect<{ now: Date }>('SELECT statement_timestamp() AS now');
  return result.rows[0]!.now.getTime();
}

async function caughtUp(): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const observed = await fixture.search!.freshness();
    if (observed.behind === 0) {
      expect(observed.catchingUp).toBe(false);
      return;
    }
    if (Date.now() >= deadline) throw new Error(`Native consumer did not catch up: ${JSON.stringify(observed)}`);
    await Bun.sleep(25);
  }
}

test('a genuine explicit retain expiry releases native work without claiming the HTTP 24-hour default elapsed', async () => {
  const native = fixture.search!;
  const bound: ReleasedNativeBoundRequest[] = [];
  // Different admitted plans produce distinct native jobs; re-retaining one key must not rewrite its expiry.
  try {
    for (const size of [2, 3]) {
      bound.push(await native.bindRequest({
        plan: { filterDocument: undefined, text: parseText(marker), sort: 'id', size },
        snapshot: 'pit',
      }, context()));
    }
    const [ordinary, short] = bound.map(({ capture }) => {
      if (capture.status !== 'captured' && capture.status !== 'preparing')
        throw new Error(`Original native producer did not admit repair work: ${JSON.stringify(capture)}`);
      return capture.repair;
    });
    expect(ordinary).toBeDefined();
    expect(short).toBeDefined();
    expect(short).not.toEqual(ordinary);
    await native.indexing('paused');
    try {
      const beforeDefault = Date.now();
      const ordinaryId = await native.preparePublic(ordinary!);
      const afterDefault = Date.now();
      const ordinaryRecord = await native.readPreparation(ordinaryId);
      expect(ordinaryRecord).not.toBeNull();
      expect(ordinaryRecord!.locator).toEqual({ kind: 'repair', key: JSON.stringify(ordinary), job: ordinary });
      expect(Number(ordinaryRecord!.expires_at)).toBeGreaterThanOrEqual(beforeDefault + DAY_MS);
      expect(Number(ordinaryRecord!.expires_at)).toBeLessThanOrEqual(afterDefault + DAY_MS);

      for (const expiresAt of [NaN, Infinity, -Infinity, 0, Date.now() - 1, Date.now() + 0.5,
        Number.MAX_SAFE_INTEGER + 1, Date.now() + DAY_MS + 60_000]) {
        await expect(native.preparePublic(short!, { expiresAt })).rejects.toThrow('safe future instant within 24 hours');
      }

      const expiresAt = Date.now() + 1_000;
      const shortId = await native.preparePublic(short!, { expiresAt });
      expect(shortId).not.toBe(ordinaryId);
      const shortRecord = await native.readPreparation(shortId);
      expect(shortRecord).not.toBeNull();
      expect(shortRecord!.locator).toEqual({ kind: 'repair', key: JSON.stringify(short), job: short });
      expect(Number(shortRecord!.expires_at)).toBe(expiresAt);
      expect(shortRecord!.revision).toBe('1');
      // Same-key retain keeps the actual frontier/revision/expiry rather than editing a stored row.
      expect(await native.preparePublic(short!)).toBe(shortId);
      expect(await native.readPreparation(shortId)).toEqual(shortRecord);

      const expiryGuard = Date.now() + 5_000;
      while (Date.now() <= expiresAt) {
        if (Date.now() >= expiryGuard) throw new Error('Explicit native retain expiry did not elapse');
        await Bun.sleep(Math.min(50, expiresAt - Date.now() + 1));
      }
      // Merely reading an expired locator never deletes it or certifies successful repair.
      expect(await native.readPreparation(shortId)).toEqual(shortRecord);
      expect(await native.readPreparation(ordinaryId)).toEqual(ordinaryRecord);
      expect(Number(ordinaryRecord!.expires_at)).toBeGreaterThan(Date.now());

      await native.indexing('running');
      const cleanupDeadline = Date.now() + 15_000;
      while (await native.readPreparation(shortId)) {
        if (Date.now() >= cleanupDeadline) throw new Error('Native worker did not release the expired preparation');
        await Bun.sleep(25);
      }
      // Expiry of scheduling state is not Source publication, coverage or an expired success response.
      const response = await fixture.request('anonymous', 'POST', '/v1/subjects:search', { text: marker, limit: 1 });
      expect(response.status).toBe(200);
      expect((response.body.subjects as { id: string }[]).map(({ id }) => id)).toEqual([witness.id]);
    } finally {
      await native.indexing('running');
    }
  } finally {
    for (const request of bound) {
      try {
        if (request.capture.status === 'captured')
          await request.operations.closeObservation(request.capture.queried, context());
      } finally {
        await request.operations.close();
      }
    }
  }
}, 60_000);

test('actual PostgreSQL Source lag over five minutes gives readiness and recovers through the same native worker', async () => {
  const native = fixture.search!;
  const prefix = native.indexPrefix;
  await caughtUp();
  await native.indexing('paused');
  let committed: CreatedSubject;
  try {
    const beforeCommit = await databaseNow();
    committed = await fixture.createSubject('schema:Book', `${marker} delayed`);
    const partition = partitionOf(routeOf(committed.id)!);
    const head = await fixture.inspect<{ position: string }>(
      'SELECT position::text FROM core.partition WHERE partition_no = $1', [partition],
    );
    const envelope = await fixture.inspect<{ recorded_at: Date }>(
      'SELECT recorded_at FROM core.outbox WHERE partition_no = $1 AND position = $2 AND event_seq = 0',
      [partition, head.rows[0]!.position],
    );
    const recordedAt = envelope.rows[0]!.recorded_at.getTime();
    expect(recordedAt).toBeGreaterThanOrEqual(beforeCommit);
    expect(recordedAt).toBeLessThanOrEqual(await databaseNow());
    const initial = await native.freshness();
    expect(initial.behind).toBeGreaterThan(0);
    expect(initial.asOf.getTime()).toBeLessThanOrEqual(recordedAt);

    const preconditionDeadline = Date.now() + SOURCE_LAG_PRECONDITION_GUARD_MS;
    for (;;) {
      const observed = await native.freshness();
      const now = await databaseNow();
      expect(observed.behind).toBeGreaterThan(0);
      expect(observed.asOf).toEqual(initial.asOf);
      if (now - recordedAt > SOURCE_LAG_THRESHOLD_MS && Date.now() - recordedAt > SOURCE_LAG_THRESHOLD_MS) {
        expect(now - observed.asOf.getTime()).toBeGreaterThan(SOURCE_LAG_THRESHOLD_MS);
        expect(observed.catchingUp).toBe(true);
        break;
      }
      if (Date.now() >= preconditionDeadline)
        throw new Error(`Real database Source lag did not age past its threshold: ${JSON.stringify(observed)}`);
      await Bun.sleep(Math.min(1_000, Math.max(1, recordedAt + SOURCE_LAG_THRESHOLD_MS + 1 - now)));
    }
    const stale = await fixture.request('anonymous', 'POST', '/v1/subjects:search', { text: marker, limit: 10 });
    expect(stale.status).toBe(503);
    expect(stale.body.code).toBe('index_not_ready');
    expect(stale.headers.get('retry-after')).toBeTruthy();
    expect(stale.body).not.toHaveProperty('subjects');
    expect(stale.body).not.toHaveProperty('as_of');
  } finally {
    await native.indexing('running');
  }
  await native.converge([witness, committed!]);
  await caughtUp();
  const beforeRead = await databaseNow();
  const recovered = await native.freshness();
  expect(recovered).toMatchObject({ behind: 0, catchingUp: false });
  expect(recovered.asOf.getTime()).toBeGreaterThanOrEqual(beforeRead);
  expect(recovered.asOf.getTime()).toBeLessThanOrEqual(await databaseNow());
  expect(native.indexPrefix).toBe(prefix);
  const response = await fixture.request('anonymous', 'POST', '/v1/subjects:search', { text: marker, limit: 10 });
  expect(response.status).toBe(200);
  expect((response.body.subjects as { id: string }[]).map(({ id }) => id).sort()).toEqual([witness.id, committed!.id].sort());
}, SOURCE_LAG_PRECONDITION_GUARD_MS + 60_000);
