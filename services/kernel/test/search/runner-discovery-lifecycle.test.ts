import { expect, test } from 'bun:test';
import pg from 'pg';
import { createPool } from '../../src/database/pool.ts';
import { createSubjectIndex, subjectGenerations, subjectIndexName } from '../../src/search/indices.ts';
import { createOpenSearch, type OpenSearch } from '../../src/search/opensearch.ts';
import { readSearchWriterPhysicalTarget } from '../../src/search/identity-epoch-participant-physical.ts';
import { startSearchIndexing, subjectConsumer } from '../../src/search/runner.ts';
import type { IndexedSubject, SubjectSnapshot, SubjectSource } from '../../src/search/source.ts';

const databaseUrl = process.env.DATABASE_URL;
const searchUrl = process.env.OPENSEARCH_URL;
if (!databaseUrl || !searchUrl)
  throw new Error('DATABASE_URL and OPENSEARCH_URL must name the check database and node');
const native = createOpenSearch(searchUrl);
const partition = 3700;
const id = (n: number) => `018f0000-0000-7000-8000-${(partition * 16).toString(16)}${String(n).padStart(8, '0')}`;

async function bounded<T>(promise: Promise<T>, name: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Fixture did not finish: ${name}`)), 15_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function gate(name: string, events: string[], fail = false) {
  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  return {
    reached: reached.promise,
    release: () => release.resolve(),
    async hold() {
      events.push(`${name}:held`);
      reached.resolve();
      await release.promise;
      events.push(`${name}:${fail ? 'failed' : 'delivered'}`);
      if (fail) throw new Error(`Controlled transport failure: ${name}`);
    },
  };
}
type Gate = ReturnType<typeof gate>;
type RequestGate = { method: string; path: string; gate: Gate };

async function fixture(run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>, history = 0) {
  const f = await setup(history);
  const { prefix, index, consumer } = f;
  try {
    await run(f);
  } finally {
    // Every held response is released even when a red assertion aborts the test body.
    for (const held of f.gates) held.release();
    await bounded(f.runner.stop(), 'runner cleanup');
    expect((await f.pool.query('SELECT 1 AS alive')).rows).toEqual([{ alive: 1 }]);
    expect(f.counts).toBe(0);
    for (const generation of (await subjectGenerations(native, prefix)).generations)
      await native.request('DELETE', `/${index(generation)}`);
    expect(await subjectGenerations(native, prefix)).toEqual({ generations: [], active: null });
    await f.admin.query('DELETE FROM core.consumer_checkpoint WHERE consumer = ANY($1::text[])', [
      [1, 2, 3].map(consumer),
    ]);
    await f.admin.query('DELETE FROM core.consumer_lag WHERE consumer = ANY($1::text[])', [[1, 2, 3].map(consumer)]);
    expect(
      (
        await f.admin.query('SELECT consumer FROM core.consumer_checkpoint WHERE consumer = ANY($1::text[])', [
          [1, 2, 3].map(consumer),
        ])
      ).rows,
    ).toEqual([]);
    await f.pool.end();
    await f.admin.end();
  }
}

async function setup(history: number) {
  // A fresh physical allocation has its own immutable writer custody.
  const prefix = `control-${crypto.randomUUID().slice(0, 8)}-`;
  const index = (generation: number) => subjectIndexName(prefix, generation);
  const consumer = (generation: number) => subjectConsumer(prefix, generation);
  const resolvePath = `/_resolve/index/${prefix}subjects*`;
  const pool = createPool(databaseUrl!);
  const admin = new pg.Pool({ connectionString: databaseUrl!, max: 2 });
  const events: string[] = [];
  const gates: Gate[] = [];
  const requestGates: RequestGate[] = [];
  const sourceGates: Gate[] = [];
  const bulkGates: { index: string; gate: Gate }[] = [];
  const calls: string[] = [];
  const bulkStatuses: number[] = [];
  const sql = { scans: 0, checkpoints: 0 };
  let counts = 0;
  pool.on('connect', (client) => {
    // Observe actual driver dispatch; never replace a query or its successful response.
    client.query = new Proxy(client.query, {
      apply(target, receiver, args: unknown[]) {
        const query = args[0];
        const text = typeof query === 'string' ? query : (query as { text?: string } | undefined)?.text;
        if (text?.includes('oldest_pending_at') && /FROM\s+core\.partition\s+AS\s+partition/i.test(text)) sql.scans++;
        if (text && /UPDATE\s+core\.consumer_checkpoint/i.test(text)) {
          sql.checkpoints++;
          events.push('checkpoint:dispatch');
        }
        return Reflect.apply(target, receiver, args);
      },
    });
  });
  const arm = (name: string, fail = false) => {
    const held = gate(name, events, fail);
    gates.push(held);
    return held;
  };
  const holdRequest = (method: string, path: string, name: string, fail = false) => {
    const held = arm(name, fail);
    requestGates.push({ method, path, gate: held });
    return held;
  };
  const holdSource = (name: string, fail = false) => {
    const held = arm(name, fail);
    sourceGates.push(held);
    return held;
  };
  const holdBulk = (generation: number, name: string, fail = false) => {
    const held = arm(name, fail);
    bulkGates.push({ index: index(generation), gate: held });
    return held;
  };
  const search: OpenSearch = {
    async request<T>(...args: Parameters<OpenSearch['request']>) {
      calls.push(`${args[0]} ${args[1]}`);
      events.push(`${args[0]} ${args[1]}`);
      // Execute the real operation first. Only transport delivery is held or lost.
      const response = await native.request<T>(...args);
      const at = requestGates.findIndex((item) => item.method === args[0] && item.path === args[1]);
      if (at !== -1) await requestGates.splice(at, 1)[0]!.gate.hold();
      return response;
    },
    async bulk<T>(...args: Parameters<OpenSearch['bulk']>) {
      const response = await native.bulk<T>(...args);
      // The admitted write goes through the allocation's immutable writer alias.
      // OpenSearch returns the actual physical index for each completed action.
      const body = response as { items: Array<Record<string, { _index: string; status: number }>> };
      const actions = body.items.map((item) => Object.values(item)[0]!);
      bulkStatuses.push(...actions.map((action) => action.status));
      const targets = new Set(actions.map((action) => action._index));
      expect(targets.size).toBe(1);
      const [name] = targets;
      calls.push(`bulk ${name}`);
      events.push(`bulk ${name}`);
      const at = bulkGates.findIndex((item) => item.index === name);
      if (at !== -1) await bulkGates.splice(at, 1)[0]!.gate.hold();
      return response;
    },
  };
  const subjects = new Map<string, IndexedSubject>();
  const source: SubjectSource = {
    async read(home, ids) {
      events.push(`source ${ids.join(',')}`);
      calls.push(`source ${ids.join(',')}`);
      const { rows } = await admin.query<{ position: string }>(
        'SELECT position::text FROM core.partition WHERE partition_no = $1',
        [home],
      );
      const snapshot: SubjectSnapshot = {
        partition: home,
        position: BigInt(rows[0]!.position),
        subjects: ids.flatMap((key) => (subjects.has(key) ? [subjects.get(key)!] : [])),
      };
      const held = sourceGates.shift();
      if (held) await held.hold();
      return snapshot;
    },
    async count() {
      counts++;
      throw new Error('Runner lifecycle must not count Source population');
    },
  };
  async function append(n: number, number = 1) {
    const subject: IndexedSubject = {
      id: id(n),
      type: 'schema:Book',
      visibility: 'visible',
      redirect: null,
      securityRevision: 1,
      labels: [{ language: 'en', value: `Control ${n}` }],
      aliases: [],
      descriptions: [],
      statements: [],
    };
    if (n !== 0) subjects.set(subject.id, subject);
    const client = await admin.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ epoch: number; position: string }>(
        'UPDATE core.partition SET position = position + $2 WHERE partition_no = $1 RETURNING epoch, position::text',
        [partition, number],
      );
      const position = rows[0]!.position;
      await client.query(
        `INSERT INTO core.outbox (partition_no, position, event_seq, event_count, epoch, id, type, subject, data)
         SELECT $1, $2::bigint - $3::int + n, 0, 1, $4, gen_random_uuid(),
           'com.rezics.subject.created.v1', $5, jsonb_build_object('id', $5::text)
         FROM generate_series(1, $3::int) AS n`,
        [partition, position, number, rows[0]!.epoch, subject.id],
      );
      await client.query('COMMIT');
      return position;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  if (history) await append(0, history);
  // Start each consumer at the real heads, isolating the fixed owned envelope from unrelated history.
  for (const generation of [1, 2, 3]) {
    await admin.query(
      `INSERT INTO core.consumer_checkpoint (partition_no, consumer, epoch, position)
       SELECT partition_no, $1, CASE WHEN position = 0 THEN NULL ELSE epoch END, position FROM core.partition`,
      [consumer(generation)],
    );
  }
  const runner = await startSearchIndexing({
    pool,
    search,
    source,
    prefix,
    listing: {
      async read() {
        return new Map<string, number>();
      },
    },
    intervalMs: 60_000,
    discoverMs: 60_000,
    concurrency: 2,
  });
  await runner.pause();
  async function idleResume() {
    // Observe completion of the real empty scan's connection ownership before admitting discovery.
    const released = Promise.withResolvers<void>();
    const notify = () => released.resolve();
    pool.once('release', notify);
    try {
      runner.resume();
      await bounded(released.promise, 'empty native scan');
    } finally {
      pool.off('release', notify);
    }
  }
  const checkpoint = async (generation: number) => {
    const { rows } = await admin.query<{ position: string }>(
      'SELECT position::text FROM core.consumer_checkpoint WHERE partition_no = $1 AND consumer = $2',
      [partition, consumer(generation)],
    );
    return rows[0]?.position ?? null;
  };
  async function admittedDocument(generation: number, subject: string, through: string) {
    const receipt = await admin.query<{ position: string }>(
      `SELECT writer_position::text AS position FROM search.identity_writer
       WHERE partition_no=$1 AND physical_target=$2 AND original_id=$3 AND writer_position >= $4::bigint`,
      [partition, index(generation), subject, through],
    );
    expect(receipt.rowCount).toBe(1);
    return { id: subject, version: Number(receipt.rows[0]!.position) };
  }
  async function processedThrough(generation: number, through: string) {
    const result = await admin.query(
      `SELECT 1 FROM core.consumer_checkpoint c
       WHERE c.partition_no=$1 AND c.consumer=$2 AND c.position >= $3::bigint
         AND NOT EXISTS (SELECT FROM core.outbox e WHERE e.partition_no=c.partition_no
           AND e.position>$3::bigint AND e.position<=c.position AND e.type='com.rezics.subject.created.v1')`,
      [partition, consumer(generation), through],
    );
    return result.rowCount === 1;
  }
  const visible = async (generation: number) =>
    (
      await native.request<{ hits: { hits: { _id: string; _version: number }[] } }>(
        'POST',
        `/${index(generation)}/_search`,
        { query: { match_all: {} }, version: true },
      )
    ).body.hits.hits.map((hit) => ({ id: hit._id, version: hit._version }));
  return {
    pool,
    admin,
    prefix,
    index,
    consumer,
    resolvePath,
    runner,
    events,
    calls,
    bulkStatuses,
    sql,
    gates,
    source,
    append,
    checkpoint,
    visible,
    admittedDocument,
    processedThrough,
    idleResume,
    holdRequest,
    holdSource,
    holdBulk,
    get counts() {
      return counts;
    },
  };
}

async function pending(promise: Promise<void>, f: Awaited<ReturnType<typeof setup>>) {
  let settled = false;
  void promise.then(() => {
    settled = true;
  });
  // Native I/O yields to any already runnable continuation; no clock-based assertion or polling.
  await f.admin.query('SELECT 1');
  expect(settled).toBe(false);
}

for (const history of [64, 512, 4096]) {
  test(`pause drains discovery admitted before its boundary and paused replacement stays idle at history ${history}`, async () => {
    await fixture(async (f) => {
      await createSubjectIndex(native, f.prefix, 2);
      await f.idleResume();
      const held = f.holdRequest('GET', f.resolvePath, 'discovery');
      const refresh = f.runner.refresh();
      await bounded(held.reached, 'discovery admitted');
      const pause = f.runner.pause().then(() => {
        f.events.push('pause:settled');
      });
      const before = await f.checkpoint(2);
      const position = await f.append(1);
      await pending(pause, f);
      held.release();
      await bounded(Promise.all([refresh, pause]), 'discovery and pause');
      expect(f.events.indexOf('discovery:delivered')).toBeLessThan(f.events.indexOf('pause:settled'));
      expect(f.calls.filter((call) => call.startsWith('source ') || call.startsWith('bulk '))).toEqual([]);
      expect(await f.checkpoint(2)).toBe(before);
      expect(await f.visible(2)).toEqual([]);
      const scans = f.sql.scans;
      const checkpoints = f.sql.checkpoints;
      const start = f.calls.length;
      await f.runner.refresh();
      await f.runner.refresh();
      expect(f.calls.slice(start)).toEqual([
        `GET ${f.resolvePath}`,
        `GET /${f.index(1)}/_mapping`,
        `GET ${f.resolvePath}`,
        `GET /${f.index(1)}/_mapping`,
      ]);
      expect(f.sql).toEqual({ scans, checkpoints });
      const first = f.holdBulk(1, 'first');
      const second = f.holdBulk(2, 'second');
      f.runner.resume();
      f.runner.resume();
      await bounded(Promise.all([first.reached, second.reached]), 'one projection per generation');
      const drain = f.runner.pause();
      first.release();
      second.release();
      await bounded(drain, 'projection checkpoint drain');
      for (const generation of [1, 2]) {
        expect(await f.processedThrough(generation, position)).toBe(true);
        expect(await f.visible(generation)).toEqual([await f.admittedDocument(generation, id(1), position)]);
      }
      expect(f.calls.filter((call) => call.startsWith('source '))).toEqual([`source ${id(1)}`, `source ${id(1)}`]);
      expect(f.calls.filter((call) => call.startsWith('bulk ')).sort()).toEqual([
        `bulk ${f.index(1)}`,
        `bulk ${f.index(2)}`,
      ]);
      expect(f.sql.checkpoints - checkpoints).toBe(2);
      expect(f.sql.scans - scans).toBe(2);
      console.info(
        'native runner history',
        JSON.stringify({ history, metadata: 4, source: 2, bulk: 2, checkpoints: 2 }),
      );
    }, history);
  }, 60_000);
}

test('metadata refresh may replace generations during pause without dispatching even a partition scan', async () => {
  await fixture(async (f) => {
    await createSubjectIndex(native, f.prefix, 2);
    // Install an older generation beside an explicitly configured one.
    await native.request('PUT', `/${f.index(2)}/_settings`, { index: { refresh_interval: '1s' } });
    await native.request('PUT', `/${f.index(1)}/_settings`, { index: { refresh_interval: '-1' } });
    await f.append(2);
    const before = { ...f.sql };
    const start = f.calls.length;
    await f.runner.refresh();
    await f.runner.pause();
    const settings = await native.request('GET', `/${f.index(1)},${f.index(2)}/_settings/index.refresh_interval`);
    expect(settings.body).toMatchObject({
      [f.index(1)]: { settings: { index: { refresh_interval: '-1' } } },
      [f.index(2)]: { settings: { index: { refresh_interval: '100ms' } } },
    });
    expect(f.sql).toEqual(before);
    expect(f.calls.slice(start).filter((call) => call.startsWith('source ') || call.startsWith('bulk '))).toEqual([]);
    expect(await f.visible(2)).toEqual([]);
  });
});

test('pause drains admitted Source through native visibility and checkpoint before a queued resume runs', async () => {
  await fixture(async (f) => {
    const position = await f.append(3);
    const source = f.holdSource('source-one');
    const bulk = f.holdBulk(1, 'bulk-one');
    f.runner.resume();
    await bounded(source.reached, 'first Source');
    const pause = f.runner.pause().then(() => {
      f.events.push('pause:settled');
    });
    f.runner.resume();
    f.runner.resume();
    await pending(pause, f);
    const nextPosition = await f.append(4);
    source.release();
    await bounded(bulk.reached, 'first native bulk');
    expect(await f.checkpoint(1)).not.toBe(position);
    expect(await f.visible(1)).toEqual([await f.admittedDocument(1, id(3), position)]);
    await pending(pause, f);
    const nextSource = f.holdSource('source-two');
    bulk.release();
    await bounded(pause, 'pause before resume');
    await bounded(nextSource.reached, 'queued resume');
    expect(f.events.indexOf('pause:settled')).toBeLessThan(f.events.indexOf('source-two:held'));
    expect(await f.processedThrough(1, position)).toBe(true);
    const finalPause = f.runner.pause();
    nextSource.release();
    await bounded(finalPause, 'second pause');
    expect(await f.processedThrough(1, nextPosition)).toBe(true);
    expect(f.calls.filter((call) => call.startsWith('source '))).toEqual([`source ${id(3)}`, `source ${id(4)}`]);
  });
});

for (const fail of [false, true]) {
  test(`stop seals an admitted discovery response, shares its drain and forbids late work (transport failure ${fail})`, async () => {
    await fixture(async (f) => {
      // An actually executed empty resolve would bootstrap if delivered to a live runner.
      await native.request('DELETE', `/${f.index(1)}`);
      const held = f.holdRequest('GET', f.resolvePath, 'stop-discovery', fail);
      const refresh = f.runner.refresh().then(
        () => null,
        (error: Error) => error.message,
      );
      await bounded(held.reached, 'stop discovery');
      const start = f.calls.length;
      const closing = f.runner.stop();
      expect(f.runner.stop()).toBe(closing);
      f.runner.resume();
      await f.runner.refresh();
      await pending(closing, f);
      held.release();
      await bounded(closing, 'stopped discovery');
      expect(await refresh).toBe('Search runner stopped');
      await f.runner.pause();
      f.runner.resume();
      await f.runner.refresh();
      expect(f.calls.slice(start)).toEqual([]);
      expect(await subjectGenerations(native, f.prefix)).toEqual({ generations: [], active: null });
    });
  });
}

for (const fail of [false, true]) {
  test(`stop drains held Source and never resumes its old handle (Source failure ${fail})`, async () => {
    await fixture(async (f) => {
      const before = await f.checkpoint(1);
      const position = await f.append(5);
      const held = f.holdSource('stop-source', fail);
      f.runner.resume();
      await bounded(held.reached, 'stop Source');
      const closing = f.runner.stop();
      expect(f.runner.stop()).toBe(closing);
      f.runner.resume();
      await pending(closing, f);
      expect(await f.checkpoint(1)).toBe(before);
      held.release();
      await bounded(closing, 'Source drain');
      if (fail) expect(await f.checkpoint(1)).toBe(before);
      else expect(await f.processedThrough(1, position)).toBe(true);
      expect(await f.visible(1)).toEqual(fail ? [] : [await f.admittedDocument(1, id(5), position)]);
      const calls = [...f.calls];
      f.runner.resume();
      await f.runner.refresh();
      await f.runner.pause();
      expect(f.calls).toEqual(calls);
    });
  });
}

test('stop drains a native external-version conflict and preserves the losing checkpoint', async () => {
  await fixture(async (f) => {
    const before = await f.checkpoint(1);
    const position = await f.append(6);
    const first = f.holdBulk(1, 'accepted');
    f.runner.resume();
    await bounded(first.reached, 'seed native write');
    const pause = f.runner.pause();
    first.release();
    await bounded(pause, 'first checkpoint');
    expect(await f.processedThrough(1, position)).toBe(true);

    // A real competing write owns a higher external version when the old cursor replays.
    const target = f.index(1);
    const old = await native.request<{ _source: object; _version: number }>('GET', `/${target}/_doc/${id(6)}`);
    const winner = old.body._version + 100_000;
    const { writeAlias } = await readSearchWriterPhysicalTarget(native, target);
    const installed = await native.bulk<{ errors: boolean }>(
      [{ index: { _index: writeAlias, _id: id(6), version: winner, version_type: 'external' } }, old.body._source],
      { query: { require_alias: true, refresh: true } },
    );
    expect(installed.errors).toBe(false);
    await f.admin.query('UPDATE core.consumer_checkpoint SET position = $3 WHERE partition_no = $1 AND consumer = $2', [
      partition,
      f.consumer(1),
      before,
    ]);
    const held = f.holdBulk(1, 'conflicting replay');
    f.runner.resume();
    await bounded(held.reached, 'actual conflict response');
    expect(f.bulkStatuses.at(-1)).toBe(409);
    const closing = f.runner.stop();
    expect(f.runner.stop()).toBe(closing);
    await pending(closing, f);
    expect(await f.checkpoint(1)).toBe(before);
    expect(await f.visible(1)).toEqual([{ id: id(6), version: winner }]);
    held.release();
    await bounded(closing, 'native conflict drain');
    expect(await f.checkpoint(1)).toBe(before);
  });
});

test('failed delivery and concurrent refresh/resume recover using one current generation set', async () => {
  await fixture(async (f) => {
    const before = await f.checkpoint(1);
    const position = await f.append(7);
    const lost = f.holdBulk(1, 'lost-bulk', true);
    f.runner.resume();
    await bounded(lost.reached, 'lost native response');
    const pause = f.runner.pause();
    lost.release();
    await bounded(pause, 'failed projection drain');
    expect(await f.checkpoint(1)).toBe(before);
    const metadata = f.holdRequest('GET', f.resolvePath, 'lost-metadata', true);
    const failed = f.runner.refresh().then(
      () => null,
      (error: Error) => error.message,
    );
    await bounded(metadata.reached, 'failed metadata');
    metadata.release();
    expect(await bounded(failed, 'failed discovery recovery')).toBe('Controlled transport failure: lost-metadata');
    await createSubjectIndex(native, f.prefix, 2);
    const held = f.holdRequest('GET', f.resolvePath, 'replacement');
    const one = f.runner.refresh();
    const two = f.runner.refresh();
    await bounded(held.reached, 'replacement admitted');
    const draining = f.runner.pause();
    f.runner.resume();
    f.runner.resume();
    const first = f.holdBulk(1, 'recovered-first');
    const second = f.holdBulk(2, 'recovered-second');
    held.release();
    await bounded(Promise.all([one, two, draining, first.reached, second.reached]), 'concurrent recovery');
    const finish = f.runner.pause();
    first.release();
    second.release();
    await bounded(finish, 'recovered checkpoint');
    for (const generation of [1, 2]) {
      expect(await f.processedThrough(generation, position)).toBe(true);
      expect(await f.visible(generation)).toEqual([await f.admittedDocument(generation, id(7), position)]);
    }
    expect(f.calls.filter((call) => call === `bulk ${f.index(1)}`)).toHaveLength(2);
    expect(f.calls.filter((call) => call === `bulk ${f.index(2)}`)).toHaveLength(1);
    expect(f.calls.filter((call) => call.startsWith('source '))).toHaveLength(3);
  });
});

test('a later pause cancels queued resume and paused or stopped runners own no scheduled ticks', async () => {
  const scheduled = new Set<ReturnType<typeof setTimeout>>();
  const originalSet = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  // Keep real timers; observe only the fixture's two 60-second schedules, without advancing a fake clock.
  globalThis.setTimeout = new Proxy(originalSet, {
    apply(target, receiver, args: unknown[]) {
      const timer = Reflect.apply(target, receiver, args) as ReturnType<typeof setTimeout>;
      if (args[1] === 60_000) scheduled.add(timer);
      return timer;
    },
  });
  globalThis.clearTimeout = new Proxy(originalClear, {
    apply(target, receiver, args: unknown[]) {
      scheduled.delete(args[0] as ReturnType<typeof setTimeout>);
      return Reflect.apply(target, receiver, args);
    },
  });
  try {
    await fixture(async (f) => {
      expect(scheduled.size).toBe(0);
      const position = await f.append(8);
      const source = f.holdSource('cancelled-resume');
      f.runner.resume();
      await bounded(source.reached, 'cancelled resume Source');
      const first = f.runner.pause();
      f.runner.resume();
      const last = f.runner.pause();
      await pending(first, f);
      await pending(last, f);
      source.release();
      await bounded(Promise.all([first, last]), 'repeated pause');
      expect(scheduled.size).toBe(0);
      expect(await f.processedThrough(1, position)).toBe(true);
      const next = await f.append(9);
      const calls = f.calls.length;
      const scans = f.sql.scans;
      await f.runner.refresh();
      expect(f.calls.slice(calls)).toEqual([`GET ${f.resolvePath}`, `GET /${f.index(1)}/_mapping`]);
      expect(f.sql.scans).toBe(scans);
      expect(await f.processedThrough(1, position)).toBe(true);
      expect(scheduled.size).toBe(0);
      const bulk = f.holdBulk(1, 'explicit-resume');
      f.runner.resume();
      f.runner.resume();
      await bounded(bulk.reached, 'explicit resume bulk');
      const closing = f.runner.stop();
      bulk.release();
      await bounded(closing, 'scheduled runner stop');
      expect(await f.processedThrough(1, next)).toBe(true);
      expect(scheduled.size).toBe(0);
      const stoppedCalls = [...f.calls];
      f.runner.resume();
      await f.runner.refresh();
      await f.runner.stop();
      expect(f.calls).toEqual(stoppedCalls);
      expect(scheduled.size).toBe(0);
    });
  } finally {
    globalThis.setTimeout = originalSet;
    globalThis.clearTimeout = originalClear;
  }
});
