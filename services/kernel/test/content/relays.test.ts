import { afterAll, beforeAll, expect, test } from 'bun:test';
import { DBOSClient } from '@dbos-inc/dbos-sdk';
import { fromPlainText } from '@rezics/document';
import pg from 'pg';
import { runCommand, type CommandEvent } from '../../src/command/command.ts';
import { readBoardCandidates } from '../../src/content/board-projection.ts';
import { createThread } from '../../src/content/commands.ts';
import { CONTENT_EVENTS } from '../../src/content/events.ts';
import { contentRelays } from '../../src/content/relays.ts';
import { createReport, listTargetReports } from '../../src/content/reports.ts';
import {
  CONTENT_QUEUES,
  CONTENT_WORKFLOWS,
  contentWorkSource,
  contentWorkWorkflowId,
} from '../../src/content/work-contract.ts';
import { createPool } from '../../src/database/pool.ts';
import { EVENT_TYPES, projectBatch, type Envelope } from '../../src/events/log.ts';
import { startRelays, type Relay } from '../../src/events/relays.ts';
import { newId, partitionOf } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { createContentSystem } from './support/system.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
const admin = new pg.Pool({ connectionString: url, max: 2 });
let client: DBOSClient;
beforeAll(async () => {
  client = await DBOSClient.create({
    systemDatabaseUrl: url,
    systemDatabaseSchemaName: 'dbos',
    applicationName: 'rezics-kernel',
    systemDatabasePoolSize: 2,
  });
  await client.registerQueue(CONTENT_QUEUES.image, { partitionConcurrency: 1 });
  await client.registerQueue(CONTENT_QUEUES.purge, { workerConcurrency: 2 });
});
afterAll(async () => {
  await client?.destroy();
  await Promise.all([pool.end(), admin.end()]);
});

let nextPartition = 2500;
const freshPartition = () => nextPartition++;
const request = () => ({
  idempotencyKey: crypto.randomUUID(),
  requestId: crypto.randomUUID(),
  deadline: Date.now() + 30_000,
});
const mediaRelay = (db = pool, work = client) => {
  const relay = contentRelays(db, work).find((relay) => relay.consumer === 'content_media');
  if (!relay) throw new Error('Missing content_media relay');
  return relay;
};

async function checkpoint(consumer: string, partition: number) {
  const result = await admin.query<{ position: string }>(
    'SELECT position::text FROM core.consumer_checkpoint WHERE consumer=$1 AND partition_no=$2',
    [consumer, partition],
  );
  return BigInt(result.rows[0]?.position ?? '0');
}

async function append(partition: number, events: CommandEvent[], db = pool) {
  const result = await runCommand(db, { partition }, async () => ({ value: null, events }));
  const seen: Envelope[] = [];
  await projectBatch(db, {
    consumer: `capture_${crypto.randomUUID().replaceAll('-', '')}`,
    partition,
    apply: async (batch) => void seen.push(...batch),
  });
  const envelope = seen.find((envelope) => envelope.position === result.position);
  if (!envelope) throw new Error('Command envelope was not read');
  return envelope;
}

function uploaded(partition: number) {
  return { mediaId: newId(partition * 16), containerId: newId(partition * 16), actorId: newId(16) };
}

async function seedUploaded(data: ReturnType<typeof uploaded>, db = admin) {
  const route = Number.parseInt(data.mediaId.replaceAll('-', '').slice(20, 24), 16);
  await db.query(
    `INSERT INTO content.media
     (route,media_id,container_id,uploader_id,reservation_request_id,purpose,media_type,
      byte_count,actual_byte_count,sha256,state,key,transaction_id)
     VALUES ($1,$2,$3,$4,$5,'post-image','image/jpeg',12,12,$6,'uploaded',$7,$8)`,
    [
      route,
      data.mediaId,
      data.containerId,
      data.actorId,
      crypto.randomUUID(),
      'a'.repeat(64),
      `m/${data.mediaId}/original`,
      crypto.randomUUID(),
    ],
  );
}

async function until(condition: () => Promise<boolean> | boolean) {
  const deadline = Date.now() + 10_000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('Relay did not catch up');
    await Bun.sleep(10);
  }
}

test('shared production relays apply board and report projections outside source checkout', async () => {
  const system = await createContentSystem({ databaseUrl: url });
  const db = system.database.pool;
  const single = createPool(db.options.connectionString!, { max: 1 });
  const dependencies = { pool: db, access: system.access, routeKey: system.routeKey };
  const boardId = newId(0x7130);
  const relays = contentRelays(db, client);
  expect(relays.map((relay) => relay.consumer)).toEqual(['content_board', 'content_reports', 'content_media']);
  const runner = startRelays(db, relays, { concurrency: 1, intervalMs: 10 });
  try {
    await runner.pause();
    await system.database.admin.query(
      `INSERT INTO content.board
       (route,board_id,subject_id,title,visibility,security_revision,recorded_transaction_id)
       VALUES ($1,$2,$3,'Board','published',1,$4)`,
      [0x7130, boardId, newId(0x7130), crypto.randomUUID()],
    );
    const thread = await createThread(
      dependencies,
      system.actors.author.actor,
      {
        title: 'Private authored title',
        body: fromPlainText('Private authored body'),
        licence: 'CC-BY-4.0',
        subjectIds: [],
        boardId,
        visibility: 'published',
      },
      request(),
    );
    const target = { kind: 'thread' as const, id: thread.value.threadId };
    const report = await createReport(
      dependencies,
      system.actors.other.actor,
      { target, reason: 'Private reason' },
      request(),
    );
    const candidates = () => readBoardCandidates(db, boardId, null, 100);
    const reports = () =>
      listTargetReports(
        dependencies,
        target,
        {
          actor: system.actors.moderator.actor,
          deadline: Date.now() + 30_000,
        },
        undefined,
        100,
      );
    expect((await candidates()).candidates).toEqual([]);
    expect((await reports()).entries).toEqual([]);
    runner.resume();
    await until(async () => (await candidates()).candidates.some((row) => row.id === thread.value.threadId));
    await until(async () => (await reports()).entries.some((row) => row.id === report.value.reportId));
    await runner.pause();
    const before = await candidates();
    const beforeReports = await reports();
    // Replay the original envelopes, even after receipt deletion. Projection keys and positions own idempotency.
    await system.database.admin.query('DELETE FROM core.command_receipt WHERE partition_no = ANY($1::int[])', [
      [thread.partition, report.partition],
    ]);
    await system.database.admin.query(
      `UPDATE core.consumer_checkpoint SET position=0,epoch=NULL
       WHERE consumer IN ('content_board','content_reports') AND partition_no = ANY($1::int[])`,
      [[thread.partition, report.partition]],
    );
    for (const relay of contentRelays(single, client).slice(0, 2)) {
      for (const partition of new Set([thread.partition, report.partition])) await relay.run(partition);
    }
    expect((await candidates()).candidates).toEqual(before.candidates);
    expect((await reports()).entries).toEqual(beforeReports.entries);
    expect(single.waitingCount).toBe(0);
    expect(single.totalCount - single.idleCount).toBe(0);
  } finally {
    await runner.stop();
    await single.end();
    await system.close();
  }
});

test('uploaded and erased media enqueue deterministic durable DBOS work without executing it in the API process', async () => {
  const partition = freshPartition();
  const data = uploaded(partition);
  await seedUploaded(data);
  const erased = uploaded(partition);
  const rejected = uploaded(partition);
  const envelope = await append(partition, [
    { type: 'com.rezics.content.media.uploaded.v1', data },
    { type: 'com.rezics.content.media.erased.v1', data: { mediaId: erased.mediaId, containerId: erased.containerId } },
    {
      type: 'com.rezics.content.media.rejected.v1',
      data: {
        mediaId: rejected.mediaId,
        containerId: rejected.containerId,
        decisionId: crypto.randomUUID(),
      },
    },
  ]);
  const relay = mediaRelay();
  expect(await relay.run(partition)).toMatchObject({ status: 'read', envelopes: 1, position: envelope.position });
  for (const [index, kind, mediaId] of [
    [0, 'image', data.mediaId],
    [1, 'purge', erased.mediaId],
    [2, 'purge', rejected.mediaId],
  ] as const) {
    const id = contentWorkWorkflowId(envelope, index, kind, kind === 'purge' ? mediaId : undefined);
    expect(await client.getWorkflow(id)).toMatchObject({
      status: 'ENQUEUED',
      workflowName: CONTENT_WORKFLOWS[kind],
      queueName: CONTENT_QUEUES[kind],
      applicationName: 'rezics-kernel',
      ...(kind === 'image' ? { queuePartitionKey: String(partition) } : {}),
      input: [{ mediaId, source: contentWorkSource(envelope, index) }],
    });
    expect(
      (await admin.query('SELECT workflow_uuid FROM dbos.workflow_status WHERE workflow_uuid=$1', [id])).rows,
    ).toHaveLength(1);
  }
  expect(
    (
      await admin.query('SELECT state FROM content.media WHERE route=$1 AND media_id=$2', [
        partition * 16,
        data.mediaId,
      ])
    ).rows,
  ).toEqual([{ state: 'uploaded' }]);
  await admin.query('UPDATE core.consumer_checkpoint SET position=0,epoch=NULL WHERE consumer=$1 AND partition_no=$2', [
    relay.consumer,
    partition,
  ]);
  await relay.run(partition);
  expect(
    (
      await client.listWorkflows({
        workflowIDs: envelope.events.map((_, index) =>
          contentWorkWorkflowId(
            envelope,
            index,
            index === 0 ? 'image' : 'purge',
            index === 0 ? undefined : index === 1 ? erased.mediaId : rejected.mediaId,
          ),
        ),
      })
    ).length,
  ).toBe(3);
});

test('failed enqueue cannot advance checkpoint', async () => {
  const partition = freshPartition();
  const envelope = await append(partition, [
    { type: 'com.rezics.content.media.uploaded.v1', data: uploaded(partition) },
  ]);
  const failing = await DBOSClient.create({
    systemDatabaseUrl: url,
    systemDatabaseSchemaName: 'missing_content_dbos',
    applicationName: 'rezics-kernel',
    systemDatabasePoolSize: 2,
  });
  try {
    await expect(mediaRelay(pool, failing).run(partition)).rejects.toThrow();
    expect(await checkpoint('content_media', partition)).toBe(0n);
    expect(await client.getWorkflow(contentWorkWorkflowId(envelope, 0, 'image'))).toBeNull();
    await mediaRelay().run(partition);
    expect(await checkpoint('content_media', partition)).toBe(envelope.position);
    expect(await client.getWorkflow(contentWorkWorkflowId(envelope, 0, 'image'))).toMatchObject({ status: 'ENQUEUED' });
  } finally {
    await failing.destroy();
  }
});

test('enqueue committed before failed acknowledgment replays the same durable work', async () => {
  const partition = freshPartition();
  const envelope = await append(partition, [
    { type: 'com.rezics.content.media.uploaded.v1', data: uploaded(partition) },
  ]);
  const connection = await admin.connect();
  try {
    await connection.query(`CREATE FUNCTION pg_temp.reject_content_ack() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'forced checkpoint acknowledgment failure'; END $$`);
    await connection.query(`CREATE TRIGGER reject_content_ack BEFORE UPDATE ON core.consumer_checkpoint
      FOR EACH ROW WHEN (NEW.consumer='content_media' AND NEW.partition_no=${partition} AND NEW.position>OLD.position)
      EXECUTE FUNCTION pg_temp.reject_content_ack()`);
    await expect(mediaRelay().run(partition)).rejects.toThrow('forced checkpoint acknowledgment failure');
    expect(await checkpoint('content_media', partition)).toBe(0n);
    const id = contentWorkWorkflowId(envelope, 0, 'image');
    expect(await client.getWorkflow(id)).toMatchObject({ status: 'ENQUEUED' });
    await connection.query('DROP TRIGGER reject_content_ack ON core.consumer_checkpoint');
    await mediaRelay().run(partition);
    expect(await checkpoint('content_media', partition)).toBe(envelope.position);
    expect(
      (await admin.query('SELECT workflow_uuid FROM dbos.workflow_status WHERE workflow_uuid=$1', [id])).rows,
    ).toHaveLength(1);
  } finally {
    await connection.query('DROP TRIGGER IF EXISTS reject_content_ack ON core.consumer_checkpoint');
    connection.release();
  }
});

test('shared pause waits for in-flight work, resume catches up, and stop releases work', async () => {
  const partition = freshPartition();
  const relay = mediaRelay();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let reached = false;
  const wrapped: Relay = {
    consumer: relay.consumer,
    async run(current) {
      const result = await relay.run(current);
      if (current === partition && result.status === 'read' && result.envelopes > 0) {
        reached = true;
        await gate;
      }
      return result;
    },
  };
  const first = await append(partition, [{ type: 'com.rezics.content.media.uploaded.v1', data: uploaded(partition) }]);
  const runner = startRelays(pool, [wrapped], { intervalMs: 10, concurrency: 1 });
  try {
    await until(() => reached);
    let paused = false;
    const pausing = runner.pause().then(() => {
      paused = true;
    });
    await Bun.sleep(30);
    expect(paused).toBe(false);
    expect(await client.getWorkflow(contentWorkWorkflowId(first, 0, 'image'))).toMatchObject({ status: 'ENQUEUED' });
    release();
    await pausing;
    const second = await append(partition, [
      { type: 'com.rezics.content.media.uploaded.v1', data: uploaded(partition) },
    ]);
    await Bun.sleep(30);
    expect(await client.getWorkflow(contentWorkWorkflowId(second, 0, 'image'))).toBeNull();
    runner.resume();
    await until(async () => (await checkpoint(relay.consumer, partition)) === second.position);
    await runner.stop();
    const third = await append(partition, [
      { type: 'com.rezics.content.media.uploaded.v1', data: uploaded(partition) },
    ]);
    await Bun.sleep(30);
    expect(await client.getWorkflow(contentWorkWorkflowId(third, 0, 'image'))).toBeNull();
    expect(pool.waitingCount).toBe(0);
  } finally {
    release();
    await runner.stop();
  }
});

test('unrelated closed events retain their own consumers and kernel poison rules', async () => {
  for (const type of Object.keys(CONTENT_EVENTS)) expect(Object.hasOwn(EVENT_TYPES, type)).toBe(true);
  const partition = freshPartition();
  const event = { type: 'com.rezics.subject.created.v1', data: { id: newId(16) } };
  const envelope = await append(partition, [event]);
  await mediaRelay().run(partition);
  expect(await checkpoint('content_media', partition)).toBe(envelope.position);
  expect(await checkpoint('effects', partition)).toBe(0n);
  expect(await checkpoint('content_board', partition)).toBe(0n);
  for (const [poison, reason] of [
    [{ type: 'com.rezics.content.unknown.v1', data: {} }, 'unknown_type'],
    [
      { type: 'com.rezics.content.media.uploaded.v1', data: { ...uploaded(partition), body: 'private' } },
      'invalid_data',
    ],
  ] as const) {
    const broken = freshPartition();
    await runCommand(pool, { partition: broken }, async () => ({ value: null, events: [poison] }));
    expect(await mediaRelay().run(broken)).toEqual({ status: 'stopped', reason, envelopes: 0, position: 0n });
    expect(await checkpoint('content_media', broken)).toBe(0n);
  }
});

test('checkGrowth proves the declared three-scale machine-independent bound', async () => {
  const db = await openGrowthDatabase(url);
  const work = await DBOSClient.create({
    systemDatabaseUrl: url,
    systemDatabaseSchemaName: 'dbos',
    applicationName: 'rezics-kernel',
    systemDatabasePool: db.openPool({ max: 2 }),
  });
  const partition = freshPartition();
  const relay = mediaRelay(db.pool, work);
  const actor = newId(16);
  // Setup is outside measurement: unrelated media, native work and same-partition log history grow together.
  async function grow(database: GrowthDatabase, scale: number, previous: number) {
    for (let ordinal = previous; ordinal < scale; ordinal++) {
      const current = ordinal % 2 === 0 ? partition : partition + 1;
      const data = uploaded(current);
      await seedUploaded(data, database.admin);
      await runCommand(database.pool, { partition: current }, async () => ({
        value: null,
        events: [{ type: 'com.rezics.content.media.uploaded.v1', data }],
      }));
    }
    for (const current of [partition, partition + 1]) {
      for (;;) {
        const batch = await relay.run(current);
        if (batch.status !== 'read') throw new Error(`Seed relay ${batch.status}`);
        if (batch.envelopes === 0) break;
      }
    }
    await database.admin.query('ANALYZE core.outbox');
    await database.admin.query('ANALYZE core.consumer_checkpoint');
    await database.admin.query('ANALYZE content.media');
    await database.admin.query('ANALYZE dbos.workflow_status');
  }
  try {
    const report = await checkGrowth(db, {
      name: 'content media relay fixed changed set',
      scales: [32, 256, 2048],
      grow,
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      async operation(database, _scale, repetition) {
        // Fresh receipts ensure every measured call really writes and enqueues one changed object.
        const result = await runCommand(
          database.pool,
          {
            partition,
            receipt: {
              actorAccountId: actor,
              kind: 'relay_probe',
              key: `probe-${repetition}`,
              digest: new Uint8Array(32),
            },
          },
          async () => ({
            value: null,
            events: [{ type: 'com.rezics.content.media.uploaded.v1', data: uploaded(partition) }],
          }),
        );
        expect(await relay.run(partition)).toMatchObject({ status: 'read', envelopes: 1, position: result.position });
      },
    });
    expect(report.samples.map((sample) => sample.scale)).toEqual([32, 256, 2048]);
    expect(report.samples.every((sample) => sample.cost.rows > 0 && sample.cost.statements > 0)).toBe(true);
    console.info(JSON.stringify(report));
  } finally {
    await work.destroy();
    await db.close();
  }
});
