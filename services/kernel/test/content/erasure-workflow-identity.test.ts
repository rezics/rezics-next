import { createHash } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { fromPlainText, serializeDocument } from '@rezics/document';
import pg from 'pg';
import { Value } from 'typebox/value';
import { runCommand } from '../../src/command/command.ts';
import { bindAuthorErasureWorkflow } from '../../src/content/erasure-workflow-identity.ts';
import { CONTENT_EVENTS } from '../../src/content/events.ts';
import { OPERATION_EVENTS } from '../../src/content/operation-events.ts';
import { contentWorkSource, contentWorkWorkflowId } from '../../src/content/work-contract.ts';
import { readBatch, type Envelope } from '../../src/events/log.ts';
import { readPartition } from '../../src/partition/partition.ts';
import { derivedId, partitionOf } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, seed, type Population } from '../support/growth.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = new pg.Pool({ connectionString: url, max: 4 });
afterAll(() => pool.end());
const route = 0x2345;
const partition = partitionOf(route);
const requested = 'com.rezics.content.author-erasure.requested.v1';
const id = (name: string, home = route) => derivedId('00000000-0000-8000-8000-000000000003', name, home);
const row = (name: string, home = route) => ({
  route: home,
  operation_id: id(name, home),
  initiator_account_id: id('initiator', 0x9876),
  author_account_id: id('author', 0x9876),
  thread_id: id(`thread-${name}`, home),
  anchor_post_id: id(`anchor-${name}`, home),
  actor_kind: 'account',
  actor_account_id: id('initiator', 0x9876),
  actor_client_id: 'rezics-web',
  actor_scopes: ['content:write'],
  actor_requested_by: null,
  actor_authn_epoch: 1,
  empty_scope: true,
  upper_created_at: null,
  upper_post_id: null,
  requested_at: new Date('2030-01-02T00:00:00Z'),
  recorded_transaction_id: id('transaction', home),
});
type Row = ReturnType<typeof row>;
const data = (operation: Row) => ({
  operationId: operation.operation_id,
  threadId: operation.thread_id,
  authorId: operation.author_account_id,
});
function anchorRows(operation: Row) {
  const revisionId = id(`revision-${operation.operation_id}`, operation.route);
  const body = Buffer.from(serializeDocument(fromPlainText('Erasure identity fixture')));
  return {
    'content.thread': [
      {
        route: operation.route,
        thread_id: operation.thread_id,
        author_account_id: operation.author_account_id,
        board_id: id('board'),
        title: 'Fixture',
        visibility: 'published',
        security_revision: 1,
        recorded_transaction_id: operation.recorded_transaction_id,
      },
    ],
    'content.post': [
      {
        route: operation.route,
        thread_id: operation.thread_id,
        post_id: operation.anchor_post_id,
        reply_to_post_id: null,
        author_account_id: operation.author_account_id,
        head_revision_id: revisionId,
        visibility: 'published',
        security_revision: 1,
        recorded_transaction_id: operation.recorded_transaction_id,
      },
    ],
    'content.revision': [
      {
        route: operation.route,
        thread_id: operation.thread_id,
        post_id: operation.anchor_post_id,
        revision_id: revisionId,
        body,
        body_sha256: createHash('sha256').update(body).digest(),
        search_text: 'Erasure identity fixture',
        licence: 'CC0-1.0',
        subject_ids: [],
        board_id: id('board'),
        availability: 'available',
        recorded_transaction_id: operation.recorded_transaction_id,
      },
    ],
  };
}
async function insertAnchor(client: Pick<pg.PoolClient, 'query'>, operation: Row) {
  const rows = anchorRows(operation);
  for (const [table, values] of Object.entries(rows)) {
    const record = values[0]!;
    await client.query(
      `INSERT INTO ${table} (${Object.keys(record).join(',')}) VALUES (${Object.keys(record)
        .map((_, index) => `$${index + 1}`)
        .join(',')})`,
      Object.values(record),
    );
  }
}
async function appendMalformed(partition: number, type: string, eventData: unknown) {
  const advanced = await pool.query(
    'UPDATE core.partition SET position=position+1 WHERE partition_no=$1 RETURNING epoch,position',
    [partition],
  );
  const state = advanced.rows[0];
  if (!state) throw new Error(`Missing partition ${partition}`);
  await pool.query(
    `INSERT INTO core.outbox (partition_no,position,event_seq,event_count,epoch,id,type,subject,data)
     VALUES ($1,$2,0,1,$3,$4,$5,$6,$7)`,
    [partition, state.position, state.epoch, crypto.randomUUID(), type, crypto.randomUUID(), JSON.stringify(eventData)],
  );
}
async function insert(client: Pick<pg.PoolClient, 'query'>, operation: Row) {
  await insertAnchor(client, operation);
  await client.query(
    `INSERT INTO content.operation (${Object.keys(operation).join(',')}) VALUES (${Object.keys(operation)
      .map((_, index) => `$${index + 1}`)
      .join(',')})`,
    Object.values(operation),
  );
}
const read = async (operation: Row) =>
  (
    await pool.query('SELECT * FROM content.operation WHERE route=$1 AND operation_id=$2', [
      operation.route,
      operation.operation_id,
    ])
  ).rows[0];

// Exercise the native command fence/outbox and registered log reader, not a fabricated event catalogue key.
async function publish(operation: Row, options: { insert?: boolean; count?: number } = {}): Promise<Envelope> {
  const selected = partitionOf(operation.route);
  const count = options.count ?? 2;
  const command = await runCommand(pool, { partition: selected }, async (tx) => {
    if (options.insert) await insert(tx, operation);
    return {
      value: null,
      events: [
        ...Array.from({ length: count - 1 }, () => ({
          type: 'com.rezics.subject.created.v1',
          data: { id: id('subject') },
        })),
        { type: requested, data: data(operation) },
      ],
    };
  });
  const consumer = `binding_${crypto.randomUUID().replaceAll('-', '')}`;
  // Model a reader checkpoint immediately before this native command, including
  // restored high positions without requiring an invented historical log.
  await pool.query('INSERT INTO core.consumer_checkpoint (partition_no,consumer,epoch,position) VALUES ($1,$2,$3,$4)', [
    selected,
    consumer,
    command.position === 1n ? null : command.epoch,
    command.position - 1n,
  ]);
  let source: Envelope | undefined;
  const result = await readBatch(pool, {
    consumer,
    partition: selected,
    envelopes: 1,
    apply: async (envelopes) => {
      source = envelopes.find((envelope) => envelope.position === command.position);
    },
  });
  expect(result.status).toBe('read');
  expect(source).toBeDefined();
  return source!;
}
async function anchored<T>(operation: Row, action: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    expect((await readPartition(client, partitionOf(operation.route)))?.writeState).toBe('active');
    return await action(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}
const target = row('target');
let source: Envelope;
beforeAll(async () => {
  source = await publish(target, { insert: true });
});

test('native operation identity binds deterministic source workflow once and same replay is idempotent', async () => {
  const before = await read(target);
  expect(before.native_workflow_id).toBeNull();
  await anchored(target, async (client) => {
    const expected = contentWorkWorkflowId(source, 1, 'authorErase', target.operation_id);
    expect(await bindAuthorErasureWorkflow(client, target.operation_id, source, 1)).toBe(expected);
    expect(await bindAuthorErasureWorkflow(client, target.operation_id, source, 1)).toBe(expected);
    const stored = (
      await client.query('SELECT * FROM content.operation WHERE route=$1 AND operation_id=$2', [
        route,
        target.operation_id,
      ])
    ).rows[0];
    expect(stored).toEqual({
      ...before,
      native_workflow_id: expected,
      source_epoch: source.epoch,
      source_partition: source.partition,
      source_position: source.position.toString(),
      source_event_index: 1,
    });
    expect(contentWorkSource(source, 1)).toEqual({
      epoch: stored.source_epoch,
      partition: stored.source_partition,
      position: stored.source_position,
      eventIndex: stored.source_event_index,
    });
    // The caller's rollback must undo the binding; the helper neither commits nor launches native work.
  });
  expect(await read(target)).toEqual(before);
});

test('conflicting source cannot replace mapping and immutable identity survives rejection', async () => {
  const other = await publish(target);
  await anchored(target, async (client) => {
    const nativeId = await bindAuthorErasureWorkflow(client, target.operation_id, source, 1);
    await expect(bindAuthorErasureWorkflow(client, target.operation_id, other, 1)).rejects.toThrow();
    // A conditional rejection leaves the caller's transaction usable.
    expect(await bindAuthorErasureWorkflow(client, target.operation_id, source, 1)).toBe(nativeId);
    await client.query('SAVEPOINT immutable');
    const failure = await client
      .query('UPDATE content.operation SET author_account_id=$3 WHERE route=$1 AND operation_id=$2', [
        route,
        target.operation_id,
        id('other-author'),
      ])
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: '23514' });
    await client.query('ROLLBACK TO SAVEPOINT immutable');
    expect(await bindAuthorErasureWorkflow(client, target.operation_id, source, 1)).toBe(nativeId);
  });
});

test('missing operation, mismatched requested scope, wrong event and partition reject', async () => {
  const absent = row('absent');
  const absentSource = await publish(absent);
  const event = source.events[1]!;
  const changed = (change: object): Envelope => ({
    ...source,
    events: [source.events[0]!, { ...event, data: { ...data(target), ...change } }],
  });
  await anchored(target, async (client) => {
    await expect(bindAuthorErasureWorkflow(client, absent.operation_id, absentSource, 1)).rejects.toThrow();
    for (const envelope of [
      changed({ operationId: id('different') }),
      changed({ threadId: id('different-thread') }),
      changed({ authorId: id('different-author') }),
      changed({ actorId: id('untrusted-actor') }),
      changed({ workflowId: 'caller-controlled' }),
      { ...source, partition: partition ^ 1 },
      { ...source, events: [event, source.events[0]!] },
    ])
      await expect(bindAuthorErasureWorkflow(client, target.operation_id, envelope, 1)).rejects.toThrow();
    expect((await read(target)).native_workflow_id).toBeNull();
  });
});

test('native source and step bounds fail before SQL and inspect only the indexed event', async () => {
  let statements = 0;
  const client = {
    query: (async () => {
      statements++;
      throw new Error('unexpected SQL');
    }) as pg.PoolClient['query'],
  };
  for (const change of [
    ...[0, -1, 1.5, NaN, 2147483648].map((epoch) => ({ epoch })),
    ...[-1, 4096, 1.5, NaN].map((partition) => ({ partition })),
    ...[0n, -1n, 9223372036854775808n, '1', 1].map((position) => ({ position })),
    { events: [] },
    { events: Array(1001).fill(source.events[1]) },
  ])
    await expect(
      bindAuthorErasureWorkflow(client, target.operation_id, { ...source, ...change } as Envelope, 1),
    ).rejects.toThrow(RangeError);
  for (const index of [-1, 0, 2, 1000, 1.5, NaN, Number.MAX_SAFE_INTEGER])
    await expect(bindAuthorErasureWorkflow(client, target.operation_id, source, index)).rejects.toThrow();
  for (const operationId of ['', 'invalid', id('other', route ^ 16)])
    await expect(bindAuthorErasureWorkflow(client, operationId, source, 1)).rejects.toThrow();
  expect(statements).toBe(0);
  await anchored(target, async (tx) => {
    const events = new Proxy(source.events, {
      get(array, key, receiver) {
        if (key === '0') throw new Error('scanned unrelated event');
        return Reflect.get(array, key, receiver);
      },
    });
    expect(await bindAuthorErasureWorkflow(tx, target.operation_id, { ...source, events }, 1)).toBe(
      contentWorkWorkflowId(source, 1, 'authorErase', target.operation_id),
    );
  });
});

test('native maximum source identity and the 1000th event bind without bigint rounding', async () => {
  const maximum = row('maximum', 0x4567);
  await pool.query('UPDATE core.partition SET epoch=2147483647,position=9223372036854775806 WHERE partition_no=$1', [
    partitionOf(maximum.route),
  ]);
  const envelope = await publish(maximum, { insert: true, count: 1000 });
  await anchored(maximum, async (client) => {
    expect(await bindAuthorErasureWorkflow(client, maximum.operation_id, envelope, 999)).toBe(
      contentWorkWorkflowId(envelope, 999, 'authorErase', maximum.operation_id),
    );
  });
  expect(envelope.position).toBe(9223372036854775807n);
});

for (const same of [true, false])
  test(`concurrent ${same ? 'same' : 'different'} binding preserves the first native identity`, async () => {
    const operation = row(`concurrent-${same}`);
    const first = await publish(operation, { insert: true });
    const second = same ? first : await publish(operation);
    const clients = await Promise.all([pool.connect(), pool.connect()]);
    try {
      for (const client of clients) {
        await client.query('BEGIN');
        await readPartition(client, partition);
      }
      const nativeId = await bindAuthorErasureWorkflow(clients[0]!, operation.operation_id, first, 1);
      const pending = bindAuthorErasureWorkflow(clients[1]!, operation.operation_id, second, 1);
      // Issue the second update while the first transaction still holds its row lock.
      const outcome = pending.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await clients[0]!.query('COMMIT');
      if (same) expect(await outcome).toEqual({ value: nativeId });
      else expect(await outcome).toHaveProperty('error');
      await clients[1]!.query('COMMIT');
      expect((await read(operation)).native_workflow_id).toBe(nativeId);
    } finally {
      for (const client of clients) {
        await client.query('ROLLBACK');
        client.release();
      }
    }
  });

test('requested event catalogue is closed and native readBatch still stops unknown or malformed events', async () => {
  expect(CONTENT_EVENTS()[requested]).toBe(OPERATION_EVENTS[requested]);
  expect(Value.Check(OPERATION_EVENTS[requested], data(target))).toBe(true);
  for (const invalid of [
    { ...data(target), body: 'private' },
    { ...data(target), authorId: 'invalid' },
    { operationId: target.operation_id },
  ])
    expect(Value.Check(OPERATION_EVENTS[requested], invalid)).toBe(false);
  for (const malformed of [false, true]) {
    const selected = 0x678 + Number(malformed);
    await appendMalformed(selected, malformed ? requested : 'com.rezics.unknown.v1', {
      ...data(target),
      body: 'invalid',
    });
    expect(
      await readBatch(pool, {
        partition: selected,
        consumer: 'binding_invalid',
        apply: async () => {
          throw new Error('invalid event applied');
        },
      }),
    ).toMatchObject({
      status: 'stopped',
      reason: malformed ? 'invalid_data' : 'unknown_type',
      envelopes: 0,
      position: 0n,
    });
  }
});

test('checkGrowth proves exact-key work with a route-leading operation PK', async () => {
  const db = await openGrowthDatabase(url);
  const operation = row('growth-target');
  const envelope = await publish(operation, { insert: true });
  const client = await db.pool.connect();
  const population: Population = {
    name: 'erasure-workflow-identity',
    hotPartition: partition,
    hotShare: 1,
    rows: ({ ordinal, route }) => {
      const operation = row(`growth-${ordinal}`, route);
      return { ...anchorRows(operation), 'content.operation': [operation] };
    },
  };
  try {
    expect(
      (
        await db.admin.query(
          "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='content.operation'::regclass AND contype='p'",
        )
      ).rows,
    ).toEqual([{ definition: 'PRIMARY KEY (route, operation_id)' }]);
    await client.query('BEGIN');
    await readPartition(client, partition);
    const report = await checkGrowth(db, {
      name: 'bind exact operation identity',
      scales: [32, 256, 2048],
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      grow: async (_db, scale, previous) => {
        await seed(db, population, { from: previous, to: scale });
      },
      operation: async () => {
        expect(await bindAuthorErasureWorkflow(client, operation.operation_id, envelope, 1)).toBe(
          contentWorkWorkflowId(envelope, 1, 'authorErase', operation.operation_id),
        );
      },
    });
    expect(report.samples.map((sample) => sample.scale)).toEqual([32, 256, 2048]);
    for (const sample of report.samples) {
      expect(sample.cost.statements).toBe(1);
      expect(sample.cost.rows).toBeLessThanOrEqual(report.samples[0]!.cost.rows);
      expect(Object.keys(sample.cost.relations ?? {})).toEqual(['content.operation']);
    }
    // Leave PostgreSQL free to prefer a scan for a tiny table. As unrelated
    // identities grow, the real plan must settle on the exact PK, inspecting one row.
    const largest = report.samples.at(-1)!;
    expect(largest.cost.rows).toBe(1);
    expect(largest.cost.relations?.['content.operation']?.sequentialScans).toBe(0);
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await db.close();
  }
}, 90_000);
