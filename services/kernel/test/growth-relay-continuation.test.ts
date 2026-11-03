import { expect, test } from 'bun:test';
import { EFFECTS_CONSUMER, effectWorkflowId, effectsRelay, registerEffects } from '../src/events/effects.ts';
import { readBatch, type Envelope } from '../src/events/log.ts';
import { openGrowthDatabase, checkGrowth, type GrowthDatabase } from './support/growth.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const created = 'com.rezics.subject.created.v1';
const effectName = 'growth_relay_record';
const busyConsumer = 'growth_relay_busy';
const emptyHistoryPerScale = 64;
const failedHistoryPerScale = 16;
const maxEventsPerEnvelope = 1_000;
const enqueueFailure = new Error('simulated partial enqueue');

type PartitionState = { partition: number; epoch: number; position: string };
type CheckpointState = {
  partition: number;
  consumer: string;
  epoch: number | null;
  position: string;
  updated_at: Date;
};

function freshPartition(used: Set<number>): number {
  let partition: number;
  do partition = 3072 + Math.floor(Math.random() * 512);
  while (used.has(partition));
  used.add(partition);
  return partition;
}

async function savePartition(db: GrowthDatabase, partition: number): Promise<PartitionState> {
  const { rows } = await db.admin.query<{ partition_no: number; epoch: number; position: string }>(
    'SELECT partition_no, epoch, position::text FROM core.partition WHERE partition_no = $1',
    [partition],
  );
  if (!rows[0]) throw new Error(`partition ${partition} is missing`);
  return { partition: rows[0].partition_no, epoch: rows[0].epoch, position: rows[0].position };
}

async function saveCheckpoint(
  db: GrowthDatabase,
  partition: number,
  consumer: string,
): Promise<CheckpointState | undefined> {
  const { rows } = await db.admin.query<Omit<CheckpointState, 'partition' | 'consumer'>>(
    `SELECT epoch, position::text, updated_at FROM core.consumer_checkpoint
     WHERE partition_no = $1 AND consumer = $2`,
    [partition, consumer],
  );
  return rows[0] ? { ...rows[0], partition, consumer } : undefined;
}

async function setCheckpoint(
  db: GrowthDatabase,
  partition: number,
  consumer: string,
  epoch: number,
  position: bigint,
): Promise<void> {
  await db.admin.query(
    `INSERT INTO core.consumer_checkpoint (partition_no, consumer, epoch, position, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (partition_no, consumer) DO UPDATE
     SET epoch = EXCLUDED.epoch, position = EXCLUDED.position, updated_at = EXCLUDED.updated_at`,
    [partition, consumer, epoch, position.toString()],
  );
}

async function checkpointPosition(
  db: GrowthDatabase,
  partition: number,
  consumer: string,
): Promise<string | undefined> {
  const { rows } = await db.admin.query<{ position: string }>(
    `SELECT position::text FROM core.consumer_checkpoint
     WHERE partition_no = $1 AND consumer = $2`,
    [partition, consumer],
  );
  return rows[0]?.position;
}

async function insertSingles(
  db: GrowthDatabase,
  partition: number,
  epoch: number,
  from: bigint,
  to: bigint,
): Promise<void> {
  if (to < from) return;
  await db.admin.query(
    `INSERT INTO core.outbox
       (partition_no, position, event_seq, event_count, epoch, id, type, subject, data)
     SELECT $1, point.position, 0, 1, $2, gen_random_uuid(), $3, gen_random_uuid()::text,
            jsonb_build_object('id', gen_random_uuid()::text)
     FROM generate_series($4::bigint, $5::bigint) AS point(position)`,
    [partition, epoch, created, from.toString(), to.toString()],
  );
}

async function insertLargeEnvelope(
  db: GrowthDatabase,
  partition: number,
  epoch: number,
  position: bigint,
): Promise<string[]> {
  const { rows } = await db.admin.query<{ id: string }>(
    `INSERT INTO core.outbox
       (partition_no, position, event_seq, event_count, epoch, id, type, subject, data)
     SELECT $1, $2, series.event_seq, $3, $4, gen_random_uuid(), $5, gen_random_uuid()::text,
            jsonb_build_object('id', gen_random_uuid()::text)
     FROM generate_series(0, $3::integer - 1) AS series(event_seq)
     RETURNING id`,
    [partition, position.toString(), maxEventsPerEnvelope, epoch, created],
  );
  return rows.map(({ id }) => id);
}

async function restore(
  db: GrowthDatabase,
  partition: PartitionState,
  checkpoints: readonly { partition: number; consumer: string; saved?: CheckpointState }[],
): Promise<void> {
  await db.admin.query('DELETE FROM core.outbox WHERE partition_no = $1 AND position > $2', [
    partition.partition,
    partition.position,
  ]);
  await db.admin.query('UPDATE core.partition SET epoch = $2, position = $3 WHERE partition_no = $1', [
    partition.partition,
    partition.epoch,
    partition.position,
  ]);
  for (const checkpoint of checkpoints) {
    await db.admin.query('DELETE FROM core.consumer_checkpoint WHERE partition_no = $1 AND consumer = $2', [
      checkpoint.partition,
      checkpoint.consumer,
    ]);
    if (!checkpoint.saved) continue;
    await db.admin.query(
      `INSERT INTO core.consumer_checkpoint (partition_no, consumer, epoch, position, updated_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        checkpoint.partition,
        checkpoint.consumer,
        checkpoint.saved.epoch,
        checkpoint.saved.position,
        checkpoint.saved.updated_at,
      ],
    );
  }
}

test('empty relay and failed apply stay bounded and resume only through the validated prefix', async () => {
  const db = await openGrowthDatabase(databaseUrl);
  const used = new Set<number>();
  const emptyPartition = freshPartition(used);
  const resumePartition = freshPartition(used);
  const busyPartition = freshPartition(used);
  const emptyInitial = await savePartition(db, emptyPartition);
  const resumeInitial = await savePartition(db, resumePartition);
  const busyInitial = await savePartition(db, busyPartition);
  const checkpoints = [
    {
      partition: emptyPartition,
      consumer: EFFECTS_CONSUMER,
      saved: await saveCheckpoint(db, emptyPartition, EFFECTS_CONSUMER),
    },
    {
      partition: resumePartition,
      consumer: EFFECTS_CONSUMER,
      saved: await saveCheckpoint(db, resumePartition, EFFECTS_CONSUMER),
    },
    { partition: busyPartition, consumer: busyConsumer, saved: await saveCheckpoint(db, busyPartition, busyConsumer) },
  ];
  const emptyDeep = BigInt(emptyInitial.position) + 1_000_000n;
  const resumeStart = BigInt(resumeInitial.position) + 1_000_000n;
  const busyStart = BigInt(busyInitial.position) + 1_000_000n;
  const resumePrefix = resumeStart + 1n;
  const resumeGap = resumeStart + 2n;
  const resumeTail = resumeStart + 3n;
  const busyHead = busyStart + 1n;
  const enqueued = new Set<string>();
  let enqueueCalls = 0;
  let failAfterFirstEnqueue = false;
  const enqueue = async (envelopes: readonly Envelope[]): Promise<void> => {
    enqueueCalls++;
    for (const envelope of envelopes) {
      for (let sequence = 0; sequence < envelope.events.length; sequence++) {
        enqueued.add(effectWorkflowId(envelope, sequence, effectName));
        if (failAfterFirstEnqueue) {
          failAfterFirstEnqueue = false;
          throw enqueueFailure;
        }
      }
    }
  };
  const effects = { enqueue } as unknown as ReturnType<typeof registerEffects>;
  const relay = effectsRelay(db.pool, effects);

  try {
    await db.admin.query('UPDATE core.partition SET position = $2 WHERE partition_no = $1', [
      emptyPartition,
      emptyDeep.toString(),
    ]);
    await setCheckpoint(db, emptyPartition, EFFECTS_CONSUMER, emptyInitial.epoch, emptyDeep);
    const emptyReport = await checkGrowth(db, {
      name: 'empty effects relay batch',
      scales: [1, 8, 64],
      rule: 'series',
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      indexProbes: 1,
      grow: async (growthDb, scale, previous) => {
        const total = BigInt(scale * emptyHistoryPerScale);
        const old = BigInt(previous * emptyHistoryPerScale);
        await insertSingles(growthDb, emptyPartition, emptyInitial.epoch, emptyDeep - total + 1n, emptyDeep - old);
      },
      operation: async () => {
        const result = await relay.run(emptyPartition);
        expect(result).toEqual({ status: 'read', envelopes: 0, position: emptyDeep });
        return result;
      },
    });
    expect(emptyReport.samples.map(({ scale }) => scale)).toEqual([1, 8, 64]);
    expect(enqueueCalls).toBe(0);
    expect(await checkpointPosition(db, emptyPartition, EFFECTS_CONSUMER)).toBe(emptyDeep.toString());

    await db.admin.query('UPDATE core.partition SET position = $2 WHERE partition_no = $1', [
      resumePartition,
      resumeTail.toString(),
    ]);
    await setCheckpoint(db, resumePartition, EFFECTS_CONSUMER, resumeInitial.epoch, resumeStart);
    await insertLargeEnvelope(db, resumePartition, resumeInitial.epoch, resumePrefix);
    await insertSingles(db, resumePartition, resumeInitial.epoch, resumeTail, resumeTail);
    const failedScales = new Set<number>();
    const failedReport = await checkGrowth(db, {
      name: 'failed effects apply and continuation',
      scales: [1, 8, 64],
      rule: 'series',
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      indexProbes: 1,
      grow: async (growthDb, scale, previous) => {
        const total = BigInt(scale * failedHistoryPerScale);
        const old = BigInt(previous * failedHistoryPerScale);
        await insertSingles(growthDb, resumePartition, resumeInitial.epoch, resumeStart - total + 1n, resumeStart - old);
      },
      prepare: async (growthDb) => {
        expect(await checkpointPosition(growthDb, resumePartition, EFFECTS_CONSUMER)).toBe(resumeStart.toString());
        await setCheckpoint(growthDb, resumePartition, EFFECTS_CONSUMER, resumeInitial.epoch, resumeStart);
      },
      operation: async (growthDb, scale) => {
        failAfterFirstEnqueue = true;
        const result = await readBatch(growthDb.pool, {
          consumer: EFFECTS_CONSUMER,
          partition: resumePartition,
          envelopes: 64,
          apply: async (envelopes) => {
            expect(envelopes).toHaveLength(1);
            expect(envelopes[0]!.events).toHaveLength(maxEventsPerEnvelope);
            await enqueue(envelopes);
          },
        }).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(result).toBe(enqueueFailure);
        failedScales.add(scale);
      },
    });
    expect(failedReport.samples.map(({ scale }) => scale)).toEqual([1, 8, 64]);
    expect(failedScales).toEqual(new Set([1, 8, 64]));
    expect(await checkpointPosition(db, resumePartition, EFFECTS_CONSUMER)).toBe(resumeStart.toString());
    expect(enqueued.size).toBe(1);

    const resumed = await relay.run(resumePartition);
    expect(resumed).toEqual({ status: 'stopped', reason: 'gap', envelopes: 1, position: resumePrefix });
    expect(await checkpointPosition(db, resumePartition, EFFECTS_CONSUMER)).toBe(resumePrefix.toString());
    const expectedEffects = new Set(
      Array.from({ length: maxEventsPerEnvelope }, (_, sequence) =>
        effectWorkflowId(
          { partition: resumePartition, epoch: resumeInitial.epoch, position: resumePrefix, events: [] },
          sequence,
          effectName,
        ),
      ),
    );
    expect(enqueued).toEqual(expectedEffects);

    await insertSingles(db, resumePartition, resumeInitial.epoch + 1, resumeGap, resumeGap);
    const continued = await relay.run(resumePartition);
    expect(continued).toEqual({ status: 'stopped', reason: 'epoch', envelopes: 0, position: resumePrefix });
    let stoppedApply = false;
    const stopped = await readBatch(db.pool, {
      consumer: EFFECTS_CONSUMER,
      partition: resumePartition,
      apply: async () => {
        stoppedApply = true;
      },
    });
    expect(stopped).toEqual({ status: 'stopped', reason: 'epoch', envelopes: 0, position: resumePrefix });
    expect(stoppedApply).toBe(false);
    expect(await checkpointPosition(db, resumePartition, EFFECTS_CONSUMER)).toBe(resumePrefix.toString());

    let emptyApply = false;
    const readEmpty = await readBatch(db.pool, {
      consumer: EFFECTS_CONSUMER,
      partition: emptyPartition,
      apply: async () => {
        emptyApply = true;
      },
    });
    expect(readEmpty).toEqual({ status: 'read', envelopes: 0, position: emptyDeep });
    expect(emptyApply).toBe(false);

    await db.admin.query('UPDATE core.partition SET position = $2 WHERE partition_no = $1', [
      busyPartition,
      busyHead.toString(),
    ]);
    await setCheckpoint(db, busyPartition, busyConsumer, busyInitial.epoch, busyStart);
    await insertSingles(db, busyPartition, busyInitial.epoch, busyHead, busyHead);
    let enteredApply!: () => void;
    let releaseApply!: () => void;
    const entered = new Promise<void>((resolve) => (enteredApply = resolve));
    const gate = new Promise<void>((resolve) => (releaseApply = resolve));
    const active = readBatch(db.pool, {
      consumer: busyConsumer,
      partition: busyPartition,
      apply: async () => {
        enteredApply();
        await gate;
      },
    });
    await entered;
    let busy: Awaited<ReturnType<typeof readBatch>>;
    try {
      busy = await readBatch(db.pool, {
        consumer: busyConsumer,
        partition: busyPartition,
        apply: async () => {
          throw new Error('busy read must not apply');
        },
      });
    } finally {
      releaseApply();
    }
    expect(busy).toEqual({ status: 'busy' });
    expect(await active).toEqual({ status: 'read', envelopes: 1, position: busyHead });
    expect(await checkpointPosition(db, busyPartition, busyConsumer)).toBe(busyHead.toString());
  } finally {
    try {
      await restore(db, emptyInitial, [checkpoints[0]!]);
      await restore(db, resumeInitial, [checkpoints[1]!]);
      await restore(db, busyInitial, [checkpoints[2]!]);
    } finally {
      await db.close();
    }
  }
}, 240_000);
