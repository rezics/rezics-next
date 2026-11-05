import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { Pool, PoolClient, QueryConfig } from 'pg';
import { Value } from 'typebox/value';
import { applyRatingChanges, readAggregate, type RatingChange } from '../../src/rating/aggregate-effect.ts';
import { POPULATION_TOTAL_DELIVERY, RATING_EVENTS, type PopulationTotalDelivery } from '../../src/rating/events.ts';
import { createPopulationTotalEffect } from '../../src/rating/population-total.ts';
import {
  createPublicFigureDrainEffect,
  drainPublicFigures,
  readPublicFigures,
} from '../../src/rating/public-figure.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import type { CloudEvent } from '../../src/events/log.ts';
import { effectWorkflowId } from '../../src/events/effects.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { workerTestEnv } from '../support/worker-env.ts';

// All observations and faults wrap actual pg IO. No writer, relay or destination is replaced.
const questionId = newId(0x3140);
const targetRoute = 0x5270;
const otherTargetRoute = 0x6380;
const populationRoute = 0x7490;
const at = '2026-11-01T08:00:00.000Z';
const key = (shard: number) => shard.toString(16).padStart(2, '0').padEnd(64, '0');
let database: GrowthDatabase;
let pool: Pool;
type Statement = { text: string; values: readonly unknown[]; checkout: number; target: boolean };
const statements: Statement[] = [];
let checkout = 0;
let fault: ((text: string, values: readonly unknown[]) => boolean) | undefined;
let faultAfterCommit = false;

beforeAll(async () => {
  database = await openGrowthDatabase();
  pool = database.openPool({ max: 1, connectionTimeoutMillis: 1000 });
  pool.on('acquire', () => checkout++);
  pool.on('connect', (client) => {
    const original = client.query.bind(client) as (...args: unknown[]) => unknown;
    let target = false;
    let sourceWritten = false;
    client.query = ((query: string | QueryConfig, ...args: unknown[]) => {
      const text = typeof query === 'string' ? query : query.text;
      const values = ((typeof query === 'string' ? args[0] : query.values) ?? []) as unknown[];
      if (/^BEGIN/i.test(text)) {
        target = false;
        sourceWritten = false;
      }
      if (/INSERT INTO rating\.population_vote|DELETE FROM rating\.population_vote/i.test(text)) {
        target = true;
        sourceWritten = true;
      }
      statements.push({ text, values, checkout, target });
      if (fault?.(text, values)) {
        fault = undefined;
        return Promise.reject(new Error('injected durable boundary'));
      }
      const result = original(query, ...args);
      // pg Pool.query uses callbacks internally; direct checked-out command queries use promises.
      if (!result || typeof (result as Promise<unknown>).then !== 'function') return result;
      return (result as Promise<unknown>).then((result) => {
        if (/^COMMIT/i.test(text) && sourceWritten && faultAfterCommit) {
          faultAfterCommit = false;
          throw new Error('injected after source commit');
        }
        return result;
      });
    }) as PoolClient['query'];
  });
  await database.admin.query(
    `INSERT INTO rating.question(id,revision,label,grain,minimum_units,maximum_units,step_units)
     VALUES($1,1,'Population home outcome','work',0,20,1)`,
    [questionId],
  );
});
afterAll(async () => {
  await database?.close();
});

function vote(
  populationId = newId(populationRoute),
  targetId = newId(targetRoute),
  patch: Partial<RatingChange> = {},
): RatingChange {
  return {
    voterId: newId(0x2180),
    countingKey: key(1),
    questionId,
    populationId,
    targetId,
    units: 10,
    revision: 1,
    at,
    ...patch,
  } as RatingChange;
}
async function totals(populationId: string, question = questionId) {
  const result = await database.admin.query<{ count: string; sum: string }>(
    `SELECT coalesce(sum(count),0)::text AS count,coalesce(sum(sum),0)::text AS sum
     FROM rating.population_total_component WHERE route=$1 AND question_id=$2 AND population_id=$3`,
    [routeOf(populationId), question, populationId],
  );
  return { count: BigInt(result.rows[0]!.count), sum: BigInt(result.rows[0]!.sum) };
}
async function events(populationId: string, action: 'deliver' | 'received' = 'deliver'): Promise<CloudEvent[]> {
  const result = await database.admin.query<{
    id: string;
    partition_no: number;
    epoch: number;
    position: string;
    data: unknown;
    time: string;
  }>(
    `SELECT id,partition_no,epoch,position::text,data,recorded_at::text AS time FROM core.outbox
      WHERE type=$1 AND data->>'populationId'=$2 AND data->>'action'=$3
      ORDER BY partition_no,position,event_seq`,
    [POPULATION_TOTAL_DELIVERY, populationId, action],
  );
  return result.rows.map((row) => ({
    specversion: '1.0',
    id: row.id,
    source: `urn:rezics:log:${row.partition_no}.${row.epoch}`,
    sequence: row.position.padStart(19, '0'),
    time: row.time,
    type: POPULATION_TOTAL_DELIVERY,
    datacontenttype: 'application/json',
    data: row.data,
  }));
}
async function interruptSource(changes: RatingChange[]) {
  faultAfterCommit = true;
  await expect(applyRatingChanges(pool, changes)).rejects.toThrow('injected after source commit');
  expect(faultAfterCommit).toBe(false);
}
async function pending(populationId: string) {
  return (
    await database.admin.query(
      `SELECT serial::text FROM rating.population_total_delivery WHERE population_id=$1 AND pending ORDER BY serial`,
      [populationId],
    )
  ).rows;
}
async function replay(populationId: string) {
  for (const event of await events(populationId)) await createPopulationTotalEffect(pool).run(event);
}

const outcome =
  'Default rating writes touch only their target home and durably deliver exact counted population totals to their own home without loss on crash replay rekey or reordering';
test(outcome, async () => {
  statements.length = 0;
  const first = vote();
  const later = vote(first.populationId, first.targetId, { units: 18, at: '2026-11-01T09:00:00.000Z' });
  expect(new Set([questionId, first.populationId, first.targetId].map((id) => partitionOf(routeOf(id)!))).size).toBe(3);
  await applyRatingChanges(pool, [first, later]);
  expect(await totals(first.populationId)).toEqual({ count: 1n, sum: 18n });
  const source = statements.find(({ text }) => /INSERT INTO rating\.population_vote/.test(text))!;
  const targetStatements = statements.filter((statement) => statement.checkout === source.checkout);
  expect(targetStatements.some(({ text }) => /INSERT INTO rating\.aggregate_component/.test(text))).toBe(true);
  for (const { text } of targetStatements) {
    expect(text).not.toMatch(/rating\.question|rating\.population_total_(?:component|inbox|received)/);
  }
  const scale = statements.find(({ text }) => /FROM rating\.question/.test(text))!;
  expect(scale.checkout).toBeLessThan(source.checkout);
  const updates = statements.filter(({ text }) => /UPDATE rating\.population_total_component/.test(text));
  expect(updates).toHaveLength(1);
  expect(updates.every(({ values }) => values.includes(populationRoute))).toBe(true);
  expect(updates.every(({ checkout: destination }) => destination !== source.checkout)).toBe(true);
  const sourceEvents = await events(first.populationId);
  expect(sourceEvents).toHaveLength(1);
  expect(Value.Check(RATING_EVENTS()[POPULATION_TOTAL_DELIVERY], sourceEvents[0]!.data)).toBe(true);
  expect((sourceEvents[0]!.data as PopulationTotalDelivery).deltas).toEqual([
    { questionId, shard: 1, count: '1', sum: '18' },
  ]);
  // Clear the winning controller account: the other account's current vote is revealed.
  await applyRatingChanges(pool, [{ ...later, units: null, revision: 2 } as RatingChange]);
  expect(await totals(first.populationId)).toEqual({ count: 1n, sum: 10n });
  await applyRatingChanges(pool, [{ ...first, remove: true, units: undefined, revision: 2 } as RatingChange]);
  expect(await totals(first.populationId)).toEqual({ count: 0n, sum: 0n });
  await replay(first.populationId);
  expect(await totals(first.populationId)).toEqual({ count: 0n, sum: 0n });
  expect(await pending(first.populationId)).toEqual([]);
});

test('rekey moves the actual old and new controller winners across two shards including controller collapse', async () => {
  const old = vote();
  const sameController = vote(old.populationId, old.targetId, { units: 4, at: '2026-11-01T07:00:00Z' });
  const newController = vote(old.populationId, old.targetId, {
    countingKey: key(2),
    units: 16,
    at: '2026-11-01T07:30:00Z',
  });
  await applyRatingChanges(pool, [old, sameController, newController]);
  expect(await totals(old.populationId)).toEqual({ count: 2n, sum: 26n });
  const moved = {
    ...old,
    countingKey: key(2),
    rekey: true,
    rekeyAt: '2026-11-01T10:00:00Z',
    rekeyAllowMissing: false,
  } as RatingChange;
  await applyRatingChanges(pool, [moved]);
  // Old shard reveals 4; the newly moved latest account replaces 16 with 10.
  expect(await totals(old.populationId)).toEqual({ count: 2n, sum: 14n });
  await applyRatingChanges(pool, [
    {
      ...sameController,
      countingKey: key(2),
      rekey: true,
      rekeyAt: '2026-11-01T10:00:00Z',
      rekeyAllowMissing: false,
    } as RatingChange,
  ]);
  expect(await totals(old.populationId)).toEqual({ count: 1n, sum: 10n });
  await applyRatingChanges(pool, [moved]);
  await replay(old.populationId);
  expect(await totals(old.populationId)).toEqual({ count: 1n, sum: 10n });
  const rows = await database.admin.query(
    `SELECT shard,count::text,sum::text FROM rating.population_total_component
     WHERE population_id=$1 ORDER BY shard`,
    [old.populationId],
  );
  expect(rows.rows).toEqual([
    { shard: 1, count: '0', sum: '0' },
    { shard: 2, count: '1', sum: '10' },
  ]);
});

test('source crash, newer-before-older delivery and repeated receipts retain every earlier delta', async () => {
  const first = vote();
  await interruptSource([first]);
  expect(await totals(first.populationId)).toEqual({ count: 0n, sum: 0n });
  await interruptSource([{ ...first, units: null, revision: 2 } as RatingChange]);
  const [add, clear] = await events(first.populationId);
  const effect = createPopulationTotalEffect(pool);
  await effect.run(clear!);
  expect(await pending(first.populationId)).toHaveLength(2);
  expect(await totals(first.populationId)).toEqual({ count: 0n, sum: 0n });
  await effect.run(clear!);
  await effect.run(add!);
  expect(await totals(first.populationId)).toEqual({ count: 1n, sum: 10n });
  // The committed destination event supplies the bounded successor continuation after the gap closes.
  for (const received of await events(first.populationId, 'received')) await effect.run(received);
  expect(await totals(first.populationId)).toEqual({ count: 0n, sum: 0n });
  expect(await pending(first.populationId)).toEqual([]);
  await effect.run(add!);
  await effect.run(clear!);
  expect(await totals(first.populationId)).toEqual({ count: 0n, sum: 0n });
  const cursor = await database.admin.query(
    'SELECT serial::text FROM rating.population_total_received WHERE population_id=$1',
    [first.populationId],
  );
  expect(cursor.rows).toEqual([{ serial: '2' }]);
});

test('destination commit before acknowledgment, rollback and partial multi-population failure recover exactly', async () => {
  const first = vote();
  const other = { ...first, populationId: newId(populationRoute + 16) } as RatingChange;
  fault = (text) => /UPDATE rating\.population_total_delivery SET pending=false/.test(text);
  await expect(applyRatingChanges(pool, [first, other])).rejects.toThrow('injected durable boundary');
  const all = [...(await events(first.populationId)), ...(await events(other.populationId))];
  const applied = await database.admin.query(
    `SELECT population_id FROM rating.population_total_inbox WHERE population_id=ANY($1::uuid[]) AND applied`,
    [[first.populationId, other.populationId]],
  );
  expect(applied.rows).toHaveLength(1);
  // One real committed destination plus two still-durable source obligations.
  expect((await pending(first.populationId)).length + (await pending(other.populationId)).length).toBe(2);
  for (const event of all) await createPopulationTotalEffect(pool).run(event);
  for (const populationId of [first.populationId, other.populationId]) {
    expect(await totals(populationId)).toEqual({ count: 1n, sum: 10n });
    expect(await pending(populationId)).toEqual([]);
  }
  const rollback = vote();
  await interruptSource([rollback]);
  const event = (await events(rollback.populationId))[0]!;
  fault = (text) => /UPDATE rating\.population_total_inbox SET applied=true/.test(text);
  await expect(createPopulationTotalEffect(pool).run(event)).rejects.toThrow('injected durable boundary');
  expect(await totals(rollback.populationId)).toEqual({ count: 0n, sum: 0n });
  expect(
    (
      await database.admin.query('SELECT applied FROM rating.population_total_inbox WHERE population_id=$1', [
        rollback.populationId,
      ])
    ).rows,
  ).toEqual([{ applied: false }]);
  await createPopulationTotalEffect(pool).run(event);
  expect(await totals(rollback.populationId)).toEqual({ count: 1n, sum: 10n });
});

test('source capture failure rolls back counted winners, components and the durable obligation together', async () => {
  const first = vote();
  fault = (text) => /INSERT INTO rating\.population_total_delivery/.test(text);
  await expect(applyRatingChanges(pool, [first])).rejects.toThrow('injected durable boundary');
  expect(await events(first.populationId)).toEqual([]);
  expect(await pending(first.populationId)).toEqual([]);
  expect(await totals(first.populationId)).toEqual({ count: 0n, sum: 0n });
  expect(
    (await database.admin.query('SELECT 1 FROM rating.population_vote WHERE population_id=$1', [first.populationId]))
      .rows,
  ).toEqual([]);
  expect(await readAggregate(database.pool, first)).toMatchObject({ count: 0n, sum: 0n });
  await applyRatingChanges(pool, [first]);
  expect(await totals(first.populationId)).toEqual({ count: 1n, sum: 10n });
  expect(((await events(first.populationId))[0]!.data as PopulationTotalDelivery).serial).toBe('1');
});

test('independent target streams concurrently update the same shard without overwriting one another', async () => {
  const populationId = newId(populationRoute);
  const first = vote(populationId);
  const second = vote(populationId, newId(otherTargetRoute), { units: 17 });
  await interruptSource([first]);
  await interruptSource([second]);
  const concurrent = database.openPool({ max: 4 });
  const deliveries = await events(populationId);
  await Promise.all(deliveries.map((event) => createPopulationTotalEffect(concurrent).run(event)));
  expect(await totals(populationId)).toEqual({ count: 2n, sum: 27n });
  await Promise.all(
    deliveries.flatMap((event) => [event, event]).map((event) => createPopulationTotalEffect(concurrent).run(event)),
  );
  expect(await totals(populationId)).toEqual({ count: 2n, sum: 27n });
});

test('nonzero cutover baseline survives old applied history, old unapplied vote events and new signed removals', async () => {
  const existing = vote();
  // Fixture represents a previously committed old counted winner and its nonzero population total.
  await database.admin.query(
    `INSERT INTO rating.population_vote(route,question_id,population_id,target_id,voter_id,counting_key,units,at,revision)
     VALUES($1,$2,$3,$4,$5,$6,10,$7,1)`,
    [targetRoute, questionId, existing.populationId, existing.targetId, existing.voterId, key(1), at],
  );
  await database.admin.query(
    `INSERT INTO rating.aggregate_component(route,question_id,population_id,target_id,shard,count,sum,histogram,applied_at)
     VALUES($1,$2,$3,$4,1,1,10,ARRAY(SELECT CASE WHEN n=10 THEN 1::bigint ELSE 0::bigint END FROM generate_series(0,20) n),$5)`,
    [targetRoute, questionId, existing.populationId, existing.targetId, at],
  );
  await database.admin.query(
    `WITH writer AS MATERIALIZED (SELECT set_config('rating.population_total_writer','population-home-v1',true))
     INSERT INTO rating.population_total_component(route,question_id,population_id,shard,count,sum)
     SELECT $1,$2,$3,1,1,10 FROM writer`,
    [populationRoute, questionId, existing.populationId],
  );
  await applyRatingChanges(pool, [existing]); // in-flight already applied source event: no delta
  expect(await events(existing.populationId)).toEqual([]);
  expect(await totals(existing.populationId)).toEqual({ count: 1n, sum: 10n });
  const unseen = vote(existing.populationId, newId(targetRoute), { units: 6 });
  await applyRatingChanges(pool, [unseen]); // in-flight unapplied source event: one new delta
  expect(await totals(existing.populationId)).toEqual({ count: 2n, sum: 16n });
  await applyRatingChanges(pool, [{ ...existing, remove: true, units: undefined, revision: 2 } as RatingChange]);
  expect(await totals(existing.populationId)).toEqual({ count: 1n, sum: 6n });
  await replay(existing.populationId);
  expect(await totals(existing.populationId)).toEqual({ count: 1n, sum: 6n });
  // Migration's native writer fence also rolls an old source transaction back, including its target mutation.
  const legacy = await database.admin.connect();
  try {
    await legacy.query('BEGIN');
    await legacy.query('UPDATE rating.population_vote SET units=20 WHERE population_id=$1', [existing.populationId]);
    await expect(
      legacy.query('UPDATE rating.population_total_component SET sum=sum+1 WHERE population_id=$1', [
        existing.populationId,
      ]),
    ).rejects.toThrow('Rating population totals require population-home delivery');
    await legacy.query('ROLLBACK');
  } finally {
    legacy.release();
  }
  expect(await totals(existing.populationId)).toEqual({ count: 1n, sum: 6n });
  expect(
    (
      await database.admin.query('SELECT units FROM rating.population_vote WHERE population_id=$1', [
        existing.populationId,
      ])
    ).rows,
  ).toEqual([{ units: 6 }]);
});

test('early aggregate drain completes delivery before freezing a prior or publishing a figure', async () => {
  const populationId = newId(populationRoute);
  const targets = Array.from({ length: 10 }, () => newId(targetRoute));
  const changes = Array.from({ length: 50 }, (_, index) =>
    vote(populationId, targets[index % 10], {
      questionId: STANDARD_QUESTION_ID,
      countingKey: key(index % 16),
    }),
  );
  // Give every account its own key within a target, while retaining the sixteen shard bound.
  changes.forEach((change, index) => {
    change.countingKey = index.toString(16).padStart(64, '0');
  });
  await interruptSource(changes);
  expect(await totals(populationId, STANDARD_QUESTION_ID)).toEqual({ count: 0n, sum: 0n });
  const partition = partitionOf(targetRoute);
  await createPublicFigureDrainEffect(pool).run({
    specversion: '1.0',
    id: newId(targetRoute),
    source: `urn:rezics:log:${partition}.1`,
    sequence: '0000000000000000001',
    time: at,
    type: 'com.rezics.rating.aggregate.applied.v1',
    datacontenttype: 'application/json',
    data: { applied: 50 },
  });
  expect(await totals(populationId, STANDARD_QUESTION_ID)).toEqual({ count: 50n, sum: 500n });
  const figures = await readPublicFigures(database.pool, {
    partition,
    questionId: STANDARD_QUESTION_ID,
    populationId,
    subjectIds: targets,
  });
  expect(figures).toHaveLength(10);
  for (const figure of figures)
    expect(figure).toMatchObject({ count: 5, mean: 5, score: 5, m: 5, C: 5, priorEpoch: 1 });
  expect(await pending(populationId)).toEqual([]);
  expect(await drainPublicFigures(pool, partition)).toBe(0);
});

test('source pages, destination statements and exact replay stay bounded as unrelated receipt history grows', async () => {
  const populationId = newId(populationRoute);
  const first = vote(populationId);
  await applyRatingChanges(pool, [first]);
  const event = (await events(populationId))[0]!;
  const report = await checkGrowth(database, {
    name: 'population total exact replay',
    scales: [8, 64, 512],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    grow: async (db, scale, previous) => {
      await db.admin.query(
        `INSERT INTO rating.population_total_inbox(route,population_id,source_partition,serial,payload,applied)
         SELECT $1,$2,0,n,'{}'::jsonb,true FROM generate_series($3::bigint+1,$4::bigint) n`,
        [populationRoute, newId(populationRoute), previous, scale],
      );
    },
    operation: async (db) => createPopulationTotalEffect(db.pool).run(event),
    repetitions: 2,
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([8, 64, 512]);
  const many = Array.from({ length: 205 }, () => vote(newId(populationRoute)));
  statements.length = 0;
  await applyRatingChanges(pool, many);
  const captures = statements.filter(({ text }) => /INSERT INTO rating\.population_total_delivery/.test(text));
  const updates = statements.filter(({ text }) => /UPDATE rating\.population_total_component/.test(text));
  expect(captures).toHaveLength(205);
  expect(updates).toHaveLength(205);
  expect(new Set(captures.map(({ checkout }) => checkout)).size).toBe(3);
  for (const checkout of new Set(captures.map(({ checkout }) => checkout))) {
    const destinations = captures.filter((item) => item.checkout === checkout).length;
    expect(destinations).toBeLessThanOrEqual(100);
    const writes = statements.filter(
      (item) => item.checkout === checkout && /rating\.population_total_(?:source|delivery|clock)/.test(item.text),
    );
    expect(writes.length).toBeLessThanOrEqual(2 * destinations + 1);
  }
  for (const checkout of new Set(updates.map(({ checkout }) => checkout))) {
    const deltas = updates.filter((item) => item.checkout === checkout).length;
    expect(deltas).toBeLessThanOrEqual(200);
    const destination = statements.filter(
      (item) => item.checkout === checkout && /rating\.population_total_(?:component|inbox|received)/.test(item.text),
    );
    expect(destination.length).toBeLessThanOrEqual(2 * deltas + 6);
  }
  const payloads = await database.admin.query<{ data: PopulationTotalDelivery; event_count: number }>(
    `SELECT data,event_count FROM core.outbox WHERE type=$1 AND data->>'action'='deliver'
     AND data->>'populationId'=ANY($2::text[])`,
    [POPULATION_TOTAL_DELIVERY, many.map((change) => change.populationId)],
  );
  expect(payloads.rows).toHaveLength(205);
  for (const { data, event_count } of payloads.rows) {
    expect(data.deltas.length).toBeLessThanOrEqual(200);
    expect(Buffer.byteLength(JSON.stringify(data))).toBeLessThanOrEqual(65536);
    expect(event_count).toBeLessThanOrEqual(101);
  }
}, 120_000);

test('foreground completion does not deliver unrelated populations with outstanding durable source pages', async () => {
  const stalled = Array.from({ length: 16 }, () => vote());
  fault = (text) => /INSERT INTO rating\.population_total_inbox/.test(text);
  await expect(applyRatingChanges(pool, stalled)).rejects.toThrow('injected durable boundary');
  for (const change of stalled) expect(await pending(change.populationId)).toHaveLength(1);
  statements.length = 0;
  const own = vote();
  await applyRatingChanges(pool, [own]);
  expect(await totals(own.populationId)).toEqual({ count: 1n, sum: 10n });
  const admissions = statements.filter(({ text }) => /INSERT INTO rating\.population_total_inbox/.test(text));
  expect(admissions).toHaveLength(1);
  expect(admissions[0]!.values).toContain(own.populationId);
  for (const change of stalled) {
    expect(await pending(change.populationId)).toHaveLength(1);
    expect(await totals(change.populationId)).toEqual({ count: 0n, sum: 0n });
  }
  // An interrupted caller's replay completes its own pages through the same production path.
  await applyRatingChanges(pool, stalled);
  for (const change of stalled) {
    expect(await pending(change.populationId)).toEqual([]);
    expect(await totals(change.populationId)).toEqual({ count: 1n, sum: 10n });
  }
});

test('the default installed worker admits committed deliveries, recovers an interrupted caller and survives process restart', async () => {
  const first = vote();
  await interruptSource([first]);
  const [event] = await events(first.populationId);
  const data = event!.data as PopulationTotalDelivery;
  const env = {
    ...process.env,
    ...workerTestEnv({
      DATABASE_URL: database.url,
      KERNEL_RECEIPT_KEYS: `1:${Buffer.alloc(32, 77).toString('base64url')}`,
    }),
  };
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let output = '';
  const start = async () => {
    child = Bun.spawn(['bun', 'src/worker.ts'], {
      cwd: `${import.meta.dir}/../..`,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const consume = async (stream: ReadableStream<Uint8Array>) => {
      for await (const chunk of stream) output += new TextDecoder().decode(chunk);
    };
    void consume(child.stdout as ReadableStream<Uint8Array>);
    void consume(child.stderr as ReadableStream<Uint8Array>);
  };
  const stop = async () => {
    child!.kill('SIGTERM');
    await child!.exited;
    child = undefined;
  };
  const wait = async (predicate: () => Promise<boolean>) => {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      if (child!.exitCode !== null) throw new Error(`Default worker exited: ${output}`);
      await Bun.sleep(25);
    }
    throw new Error(`Default delivery did not complete: ${output}`);
  };
  try {
    await start();
    await wait(async () => (await pending(first.populationId)).length === 0);
    expect(await totals(first.populationId)).toEqual({ count: 1n, sum: 10n });
    const source = /^urn:rezics:log:(\d+)\.(\d+)$/.exec(event!.source)!;
    const slot = await database.admin.query<{ event_seq: number }>('SELECT event_seq FROM core.outbox WHERE id=$1', [
      event!.id,
    ]);
    const workflow = effectWorkflowId(
      { partition: Number(source[1]), epoch: Number(source[2]), position: BigInt(event!.sequence), events: [] },
      slot.rows[0]!.event_seq,
      'rating_population_total',
    );
    await wait(
      async () =>
        (
          await database.admin.query("SELECT 1 FROM dbos.workflow_status WHERE workflow_uuid=$1 AND status='SUCCESS'", [
            workflow,
          ])
        ).rowCount === 1,
    );
    const admission = await database.admin.query(
      `SELECT applied FROM rating.population_total_inbox WHERE route=$1 AND population_id=$2
       AND source_partition=$3 AND serial=$4`,
      [populationRoute, first.populationId, data.sourcePartition, data.serial],
    );
    expect(admission.rows).toEqual([{ applied: true }]);
    const custody = await database.admin.query(`SELECT state FROM core.history_event_consumer WHERE workflow_id=$1`, [
      workflow,
    ]);
    expect(custody.rows).toEqual([{ state: 'completed' }]);
    await stop();
    const second = vote(first.populationId, newId(otherTargetRoute), { units: 7 });
    await interruptSource([second]);
    await start();
    await wait(async () => (await pending(first.populationId)).length === 0);
    expect(await totals(first.populationId)).toEqual({ count: 2n, sum: 17n });
    expect(
      await readAggregate(database.pool, { questionId, populationId: first.populationId, targetId: second.targetId }),
    ).toMatchObject({ count: 1n, sum: 7n });
  } finally {
    if (child) await stop();
  }
}, 240_000);
