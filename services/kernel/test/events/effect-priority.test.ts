import { expect, test } from 'bun:test';
import { DBOS } from '@dbos-inc/dbos-sdk';
import pg from 'pg';
import { EFFECTS_CONSUMER, effectsRelay, launchWork, registerEffects, shutdownWork } from '../../src/events/effects.ts';
import { BATCH_ENVELOPES, type CloudEvent } from '../../src/events/log.ts';
import { startRelays } from '../../src/events/relays.ts';
import scanIdentityAdmission from '../../src/events/scan-identity-admission.sql';
import { IDENTITY_EPOCH_ADMITTED } from '../../src/semantic/events.ts';

test('a newly committed identity wake gets a bounded turn during effects backlog and reuses its receipt', async () => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  // Reconstruct the observed job, outbox slot and cursor from the retained catalogue run.
  const partition = 692;
  const jobId = '01a1f3bf-e798-7473-ae8b-2b409fa38767';
  const eventId = crypto.randomUUID();
  const wakeData = { jobId, epoch: '2', partition };
  const recordedAt = '2026-11-19T12:20:02.643Z';
  const consumer = 'identity_epoch_admission';
  const workflowId = `fx:1:${partition}:151:0:${consumer}`;
  const ordinaryType = 'com.rezics.subject.created.v1';
  const oldestHome = 1000;
  const ordinaryHead = BATCH_ENVELOPES + 1;
  const worked: CloudEvent[] = [];
  const effects = registerEffects([
    {
      name: consumer,
      queue: 'governance',
      types: [IDENTITY_EPOCH_ADMITTED],
      run: async (event) => void worked.push(event),
    },
    { name: 'ordinary_admission', delivery: 'native', types: [ordinaryType], async admit() {} },
  ]);

  const readReceipt = async () => {
    const { rows } = await pool.query(
      `SELECT c.workflow_id, c.consumer, s.queue_name, s.created_at::text
       FROM core.history_event_consumer AS c JOIN dbos.workflow_status AS s ON s.workflow_uuid=c.workflow_id
       WHERE (c.partition_no,c.position,c.event_seq,c.consumer)=($1,151,0,$2)`,
      [partition, consumer],
    );
    return rows;
  };
  const checkpoint = async (home: number) =>
    (
      await pool.query('SELECT position::text FROM core.consumer_checkpoint WHERE (consumer,partition_no)=($1,$2)', [
        EFFECTS_CONSUMER,
        home,
      ])
    ).rows[0]?.position;

  const oldestBatchFinished = Promise.withResolvers<void>();
  const releaseOldest = Promise.withResolvers<void>();
  const wakeDiscovered = Promise.withResolvers<void>();
  const replayDiscovered = Promise.withResolvers<void>();
  const wakeAccepted = Promise.withResolvers<void>();
  const ordinaryHomesFinished = Promise.withResolvers<void>();
  const timeout = AbortSignal.timeout(12_000);
  const timedOut = new Promise<never>((_, reject) => {
    timeout.addEventListener('abort', () => reject(new Error('Effects relay did not reach the expected turn')), {
      once: true,
    });
  });
  const ordinaryCompleted = new Set<number>();
  const turns: number[] = [];
  const firstEnqueueError = new Error('Effects relay interrupted after enqueue');
  let firstReceipt: Awaited<ReturnType<typeof readReceipt>> | undefined;
  let wakeAttempts = 0;
  const enqueue = effects.enqueue;
  effects.enqueue = async (envelopes) => {
    await enqueue(envelopes);
    if (!envelopes.some((envelope) => envelope.events.some((event) => event.id === eventId))) return;
    if (++wakeAttempts === 1) {
      firstReceipt = await readReceipt();
      expect(await checkpoint(partition)).toBe('134');
      await replayDiscovered.promise;
      throw firstEnqueueError;
    }
  };

  let scheduler: ReturnType<typeof startRelays> | undefined;
  try {
    await launchWork({ databaseUrl });
    await pool.query(
      `WITH homes AS (
         UPDATE core.partition SET position=CASE WHEN partition_no=$1 THEN 150 ELSE $3 END
         WHERE partition_no=$1 OR partition_no BETWEEN $2 AND $2 + 23 RETURNING partition_no, position, epoch
       )
       INSERT INTO core.outbox (partition_no,position,event_seq,event_count,epoch,id,type,data,recorded_at)
       SELECT homes.partition_no, p, 0, 1, homes.epoch, gen_random_uuid(), $4, jsonb_build_object('id', gen_random_uuid()),
              $5::timestamptz - CASE WHEN homes.partition_no=$1 THEN '1 second'::interval
                ELSE '1 hour'::interval - (homes.partition_no - $2) * '1 second'::interval END
       FROM homes CROSS JOIN LATERAL generate_series(CASE WHEN homes.partition_no=$1 THEN 135 ELSE 1 END, homes.position) AS p`,
      [partition, oldestHome, ordinaryHead, ordinaryType, recordedAt],
    );
    await pool.query(
      'INSERT INTO core.consumer_checkpoint (consumer,partition_no,epoch,position) VALUES ($1,$2,1,134)',
      [EFFECTS_CONSUMER, partition],
    );
    const relay = effectsRelay(pool, effects);
    const scanPriority = relay.scanPriority;
    if (!scanPriority) throw new Error('The registered governance wake has no priority scan');
    scheduler = startRelays(
      pool,
      [
        {
          consumer: relay.consumer,
          async scanPriority(client) {
            const homes = await scanPriority(client);
            if (homes.some((home) => home.partition_no === partition && BigInt(home.position) === 151n)) {
              wakeDiscovered.resolve();
              if (firstReceipt) replayDiscovered.resolve();
            }
            return homes;
          },
          async run(home) {
            turns.push(home);
            try {
              const result = await relay.run(home);
              if (turns.length === 1) {
                oldestBatchFinished.resolve();
                await releaseOldest.promise;
              }
              if (result.status === 'read' && result.position === 151n && home === partition) wakeAccepted.resolve();
              if (result.status === 'read' && result.position === BigInt(ordinaryHead)) {
                ordinaryCompleted.add(home);
                if (ordinaryCompleted.size === 24) ordinaryHomesFinished.resolve();
              }
              return result;
            } catch (error) {
              if (error === firstEnqueueError) return { status: 'busy' };
              throw error;
            }
          },
        },
      ],
      { intervalMs: 5, concurrency: 1 },
    );

    await Promise.race([oldestBatchFinished.promise, timedOut]);
    expect(await checkpoint(oldestHome)).toBe(String(BATCH_ENVELOPES));
    expect(await checkpoint(partition)).toBe('134');
    await pool.query(
      `WITH home AS (UPDATE core.partition SET position=151 WHERE partition_no=$1 RETURNING epoch)
       INSERT INTO core.outbox (partition_no,position,event_seq,event_count,epoch,id,type,data,recorded_at)
       SELECT $1, 151, 0, 1, home.epoch, $2, $3, $4, $5 FROM home`,
      [partition, eventId, IDENTITY_EPOCH_ADMITTED, wakeData, recordedAt],
    );
    const plan = await pool.query(`EXPLAIN ${scanIdentityAdmission.sql}`, [EFFECTS_CONSUMER]);
    expect(JSON.stringify(plan.rows)).toContain('effects_identity_admission_pending_idx');
    await Promise.race([wakeDiscovered.promise, timedOut]);
    releaseOldest.resolve();

    await Promise.race([wakeAccepted.promise, timedOut]);
    expect(turns.slice(0, 4)).toEqual([oldestHome, partition, oldestHome + 1, partition]);
    expect(wakeAttempts).toBe(2);
    expect(firstReceipt).toEqual([
      { workflow_id: workflowId, consumer, queue_name: 'governance', created_at: expect.any(String) },
    ]);
    expect(await readReceipt()).toEqual(firstReceipt);
    await Promise.race([DBOS.retrieveWorkflow(workflowId).getResult(), timedOut]);
    expect(worked).toEqual([expect.objectContaining({ id: eventId, type: IDENTITY_EPOCH_ADMITTED, data: wakeData })]);
    expect(await checkpoint(partition)).toBe('151');
    await Promise.race([ordinaryHomesFinished.promise, timedOut]);
    expect([...new Set(turns.filter((home) => home !== partition))]).toEqual(
      Array.from({ length: 24 }, (_, index) => oldestHome + index),
    );
  } finally {
    releaseOldest.resolve();
    replayDiscovered.resolve();
    await scheduler?.stop();
    await shutdownWork();
    await pool.end();
  }
}, 15_000);
