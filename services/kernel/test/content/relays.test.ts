import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { fromPlainText, serializeDocument } from '@rezics/document';
import pg from 'pg';
import { runCommand, type CommandEvent } from '../../src/command/command.ts';
import { readBoardCandidates } from '../../src/content/board-projection.ts';
import { contentEffects } from '../../src/content/relays.ts';
import {
  CONTENT_QUEUES,
  CONTENT_WORKFLOWS,
  contentWorkSource,
  contentWorkWorkflowId,
} from '../../src/content/work-contract.ts';
import { createPool } from '../../src/database/pool.ts';
import { effectWorkflowId, type Effect } from '../../src/events/effects.ts';
import { readBatch, type CloudEvent, type Envelope } from '../../src/events/log.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { startWorker } from '../../src/worker.ts';
import { createWorkClient, type WorkClient } from '../../src/work/client.ts';
import { WORK_QUEUES } from '../../src/work/queues.ts';
import type { WorkModule } from '../../src/work/registry.ts';
import { checkGrowth, openGrowthDatabase } from '../support/growth.ts';
import { SUBJECT_THREAD_EVENT_FIELDS } from '../support/subject-thread-event.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
const admin = new pg.Pool({ connectionString: url, max: 2 });
let client: WorkClient;
let workerTemplateUrl = process.env.CONTENT_EFFECT_TEMPLATE;
let templateAdmin: pg.Pool | undefined;
let templateName: string | undefined;
beforeAll(async () => {
  if (!workerTemplateUrl) {
    const source = new URL(url);
    const template = decodeURIComponent(source.pathname.slice(1)).replaceAll('"', '""');
    source.pathname = '/postgres';
    templateAdmin = new pg.Pool({ connectionString: source.href });
    templateName = `content_effect_template_${crypto.randomUUID().replaceAll('-', '')}`;
    await templateAdmin.query(`CREATE DATABASE ${templateName} TEMPLATE "${template}"`);
    source.pathname = `/${templateName}`;
    workerTemplateUrl = source.href;
  }
  client = await createWorkClient(url);
  for (const [name, options] of Object.entries(WORK_QUEUES)) await client.registerQueue(name, options);
});
afterAll(async () => {
  await client?.close();
  await Promise.all([pool.end(), admin.end()]);
  if (templateAdmin) {
    await templateAdmin.query(`DROP DATABASE ${templateName}`);
    await templateAdmin.end();
  }
});

let nextPartition = 2500;
const freshPartition = () => nextPartition++;
const uploaded = (partition: number) => ({
  mediaId: newId(partition * 16),
  containerId: newId(partition * 16),
  actorId: newId(16),
});

async function append(partition: number, events: CommandEvent[], db = pool): Promise<Envelope> {
  const result = await runCommand(db, { partition }, async () => ({ value: null, events }));
  const consumer = `capture_${crypto.randomUUID().replaceAll('-', '')}`;
  await db.query('INSERT INTO core.consumer_checkpoint (partition_no,consumer,epoch,position) VALUES ($1,$2,$3,$4)', [
    partition,
    consumer,
    result.position === 1n ? null : result.epoch,
    result.position - 1n,
  ]);
  let envelope: Envelope | undefined;
  await readBatch(db, {
    consumer,
    partition,
    envelopes: 1,
    apply: async (batch) => {
      envelope = batch[0];
    },
  });
  if (!envelope) throw new Error('Native command envelope was not read');
  return envelope;
}

function effectFor(event: CloudEvent, db = pool, work = client): Effect {
  const matches = contentEffects(db, work).filter((effect) => effect.types.includes(event.type));
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

async function row(id: string, db = admin) {
  const stored = (
    await db.query(
      `SELECT ws.*, wi.inputs AS durable_inputs FROM dbos.workflow_status ws
     LEFT JOIN dbos.workflow_input wi USING (workflow_uuid) WHERE ws.workflow_uuid=$1`,
      [id],
    )
  ).rows[0];
  if (stored) stored.inputs = JSON.stringify(JSON.parse(stored.durable_inputs ?? stored.inputs).json);
  return stored;
}

async function until(condition: () => Promise<boolean>) {
  const deadline = Date.now() + 15_000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('Native worker did not catch up');
    await Bun.sleep(10);
  }
}

async function seedMedia(data: ReturnType<typeof uploaded>, db = admin) {
  await db.query(
    `INSERT INTO content.media
     (route,media_id,container_id,uploader_id,reservation_request_id,purpose,media_type,
      byte_count,actual_byte_count,sha256,state,key,transaction_id)
     VALUES ($1,$2,$3,$4,$5,'post-image','image/jpeg',12,12,$6,'uploaded',$7,$8)`,
    [
      routeOf(data.mediaId),
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

async function appendMalformed(partition: number, type: string, data: unknown) {
  const advanced = await admin.query(
    'UPDATE core.partition SET position=position+1 WHERE partition_no=$1 RETURNING epoch,position',
    [partition],
  );
  const state = advanced.rows[0];
  if (!state) throw new Error(`Missing partition ${partition}`);
  await admin.query(
    `INSERT INTO core.outbox (partition_no,position,event_seq,event_count,epoch,id,type,subject,data)
     VALUES ($1,$2,0,1,$3,$4,$5,$6,$7)`,
    [partition, state.position, state.epoch, crypto.randomUUID(), type, crypto.randomUUID(), JSON.stringify(data)],
  );
}

test('native durable media and URL import use actual event sequence and partitioned deterministic IDs without an executor', async () => {
  const partition = freshPartition();
  const first = uploaded(partition);
  await seedMedia(first);
  const second = uploaded(partition);
  const erased = uploaded(partition);
  const rejected = uploaded(partition);
  const imported = uploaded(partition);
  const envelope = await append(partition, [
    { type: 'com.rezics.subject.created.v1', data: { id: newId(16) } },
    { type: 'com.rezics.content.media.uploaded.v1', data: first },
    { type: 'com.rezics.content.media.uploaded.v1', data: second },
    { type: 'com.rezics.content.media.erased.v1', data: { mediaId: erased.mediaId, containerId: erased.containerId } },
    {
      type: 'com.rezics.content.media.rejected.v1',
      data: { mediaId: rejected.mediaId, containerId: rejected.containerId, decisionId: newId(16) },
    },
    { type: 'com.rezics.content.media.import-requested.v1', data: { mediaId: imported.mediaId } },
  ]);
  expect(DBOS.isInitialized()).toBe(false);
  for (const [index, kind, mediaId] of [
    [1, 'image', first.mediaId],
    [2, 'image', second.mediaId],
    [3, 'purge', erased.mediaId],
    [4, 'purge', rejected.mediaId],
    [5, 'importFromUrl', imported.mediaId],
  ] as const) {
    const event = envelope.events[index]!;
    const effect = effectFor(event);
    await effect.run(event);
    await effect.run(event);
    const id = contentWorkWorkflowId(envelope, index, kind, kind === 'image' ? undefined : mediaId);
    expect(await row(id)).toMatchObject({
      status: 'ENQUEUED',
      name: CONTENT_WORKFLOWS[kind],
      queue_name: CONTENT_QUEUES[kind],
      inputs: JSON.stringify([{ mediaId, source: contentWorkSource(envelope, index) }]),
      ...(kind === 'image' || kind === 'importFromUrl' ? { queue_partition_key: String(partition) } : {}),
    });
    expect((await admin.query('SELECT 1 FROM dbos.workflow_status WHERE workflow_uuid=$1', [id])).rows).toHaveLength(1);
  }
  expect(
    (
      await admin.query('SELECT state FROM content.media WHERE route=$1 AND media_id=$2', [
        routeOf(first.mediaId),
        first.mediaId,
      ])
    ).rows,
  ).toEqual([{ state: 'uploaded' }]);
  expect(
    (
      await admin.query("SELECT 1 FROM core.consumer_checkpoint WHERE consumer LIKE 'content_%' AND partition_no=$1", [
        partition,
      ])
    ).rows,
  ).toEqual([]);
});

test('failed native enqueue retries with the same identity and no lost or duplicate work', async () => {
  const partition = freshPartition();
  const envelope = await append(partition, [
    { type: 'com.rezics.content.media.uploaded.v1', data: uploaded(partition) },
  ]);
  const event = envelope.events[0]!;
  const failing = await createWorkClient(url);
  await failing.close();
  const id = contentWorkWorkflowId(envelope, 0, 'image');
  await expect(effectFor(event, pool, failing).run(event)).rejects.toThrow();
  expect(await row(id)).toBeUndefined();
  await effectFor(event).run(event);
  await effectFor(event).run(event);
  expect(await row(id)).toMatchObject({ status: 'ENQUEUED', queue_partition_key: String(partition) });
  expect((await admin.query('SELECT 1 FROM dbos.workflow_status WHERE workflow_uuid=$1', [id])).rows).toHaveLength(1);
});

test('malformed, unanchored, wrong and unknown closed events are rejected without guessing a position or event index', async () => {
  const partition = freshPartition();
  const envelope = await append(partition, [
    { type: 'com.rezics.content.media.uploaded.v1', data: uploaded(partition) },
  ]);
  const event = envelope.events[0]!;
  const effect = effectFor(event);
  for (const change of [
    { source: 'urn:rezics:log:02500.1' },
    { source: `urn:rezics:log:${partition}.0` },
    { source: 'urn:rezics:log:4096.1' },
    { source: `urn:rezics:log:${partition}.2147483648` },
    { sequence: '1' },
    { sequence: '0000000000000000000' },
    { sequence: '9223372036854775808' },
    { id: 'invalid' },
    { id: crypto.randomUUID() },
    { sequence: '0000000000000000002' },
    { source: `urn:rezics:log:${partition + 1}.1` },
    { type: 'com.rezics.content.unknown.v1' },
    { data: { ...(event.data as object), body: 'private authored bytes' } },
    { type: 'com.rezics.subject.created.v1', data: { id: newId(16) } },
  ])
    await expect(effect.run({ ...event, ...change } as CloudEvent)).rejects.toThrow();
  expect(await row(contentWorkWorkflowId(envelope, 0, 'image'))).toBeUndefined();
  for (const [type, data, reason] of [
    ['com.rezics.content.unknown.v1', {}, 'unknown_type'],
    ['com.rezics.content.media.uploaded.v1', { ...uploaded(partition), body: 'private' }, 'invalid_data'],
  ] as const) {
    const broken = freshPartition();
    await appendMalformed(broken, type, data);
    expect(
      await readBatch(pool, {
        consumer: 'effects',
        partition: broken,
        apply: async () => {
          throw new Error('Poison delivered');
        },
      }),
    ).toEqual({ status: 'stopped', reason, envelopes: 0, position: 0n });
  }
});

test('author erasure binds the validated native requested event before enqueue and survives enqueue failure', async () => {
  const partition = freshPartition();
  const route = partition * 16;
  const operationId = newId(route);
  const threadId = newId(route);
  const anchorPostId = newId(route);
  const revisionId = newId(route);
  const authorId = newId(16);
  const anchorBody = Buffer.from(serializeDocument(fromPlainText('Relay author erasure fixture')));
  const setup = await admin.connect();
  try {
    await setup.query('BEGIN');
    await setup.query(
      `INSERT INTO content.thread
        (route,thread_id,author_account_id,board_id,title,visibility,security_revision,recorded_transaction_id)
       VALUES ($1,$2,$3,$4,'Fixture','published',1,$5)`,
      [route, threadId, authorId, newId(route), crypto.randomUUID()],
    );
    await setup.query(
      `INSERT INTO content.post
        (route,thread_id,post_id,author_account_id,head_revision_id,visibility,security_revision,recorded_transaction_id)
       VALUES ($1,$2,$3,$4,$5,'published',1,$6)`,
      [route, threadId, anchorPostId, authorId, revisionId, crypto.randomUUID()],
    );
    await setup.query(
      `INSERT INTO content.revision
        (route,thread_id,post_id,revision_id,body,body_sha256,search_text,licence,subject_ids,board_id,availability,recorded_transaction_id)
       VALUES ($1,$2,$3,$4,$5,sha256($5),'Relay author erasure fixture','CC0-1.0','{}',$6,'available',$7)`,
      [route, threadId, anchorPostId, revisionId, anchorBody, newId(route), crypto.randomUUID()],
    );
    await setup.query(
      `INSERT INTO content.operation
        (route,operation_id,initiator_account_id,author_account_id,thread_id,anchor_post_id,actor_kind,actor_account_id,
         actor_client_id,actor_scopes,actor_authn_epoch,empty_scope,requested_at,recorded_transaction_id)
       VALUES ($1,$2,$3,$3,$4,$5,'account',$3,'rezics-web',ARRAY['content:write'],1,true,now(),$6)`,
      [route, operationId, authorId, threadId, anchorPostId, crypto.randomUUID()],
    );
    await setup.query('COMMIT');
  } finally {
    await setup.query('ROLLBACK');
    setup.release();
  }
  const envelope = await append(partition, [
    { type: 'com.rezics.subject.created.v1', data: { id: newId(16) } },
    { type: 'com.rezics.content.author-erasure.requested.v1', data: { operationId, threadId, authorId } },
  ]);
  const event = envelope.events[1]!;
  const id = contentWorkWorkflowId(envelope, 1, 'authorErase', operationId);
  const failing = await createWorkClient(url);
  await failing.close();
  await expect(effectFor(event, pool, failing).run(event)).rejects.toThrow();
  expect(
    (
      await admin.query(
        'SELECT native_workflow_id,source_event_index FROM content.operation WHERE route=$1 AND operation_id=$2',
        [route, operationId],
      )
    ).rows,
  ).toEqual([{ native_workflow_id: id, source_event_index: 1 }]);
  expect(await row(id)).toBeUndefined();
  await effectFor(event).run(event);
  await effectFor(event).run(event);
  expect(await row(id)).toMatchObject({
    status: 'ENQUEUED',
    name: CONTENT_WORKFLOWS.authorErase,
    inputs: JSON.stringify([{ operationId, source: contentWorkSource(envelope, 1) }]),
  });
  const wrong = await append(partition, [
    { type: event.type, data: { operationId, threadId: newId(route), authorId } },
  ]);
  await expect(effectFor(wrong.events[0]!).run(wrong.events[0]!)).rejects.toThrow();
  expect(await row(contentWorkWorkflowId(wrong, 0, 'authorErase', operationId))).toBeUndefined();
});

const workerTest =
  'module effects register through WorkContext.addEffects once in the sole worker and native retries project the correct partitions';
test(
  workerTest,
  async () => {
    if (process.env.CONTENT_EFFECT_CHILD !== '1') {
      const child = Bun.spawn([process.execPath, 'test', import.meta.path, '--test-name-pattern', `^${workerTest}$`], {
        env: { ...process.env, CONTENT_EFFECT_CHILD: '1', CONTENT_EFFECT_TEMPLATE: workerTemplateUrl },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [code, output, errors] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code, `${output}\n${errors}`).toBe(0);
      return;
    }
    const databaseUrl = workerTemplateUrl!;
    const db = createPool(databaseUrl);
    const dbAdmin = new pg.Pool({ connectionString: databaseUrl });
    const workClient = await createWorkClient(databaseUrl);
    const register = spyOn(DBOS, 'registerWorkflow');
    let additions = 0;
    let effects: Effect[] = [];
    const module: WorkModule = {
      name: 'content_effect_fixture',
      register(context) {
        expect(DBOS.isInitialized()).toBe(false);
        effects = contentEffects(context.pool, context.client);
        // The minimal fixture has no media executor. Stop further native queue
        // dispatch only after this shared effect has started, leaving its retry
        // active while the resulting media work remains durably queued.
        const image = effects.find((effect) => effect.types.includes('com.rezics.content.media.uploaded.v1'))!;
        const runImage = image.run;
        image.run = async (event) => {
          const queue = (await context.client.retrieveQueue('effects'))!;
          await queue.setWorkerConcurrency(0);
          // Native queue discovery refreshes database configuration once a second.
          await Bun.sleep(1200);
          await runImage(event);
        };
        context.addEffects(effects);
        additions++;
      },
    };
    let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
    try {
      // This sequence advances outside transaction rollback: the first real durable insert fails once.
      await dbAdmin.query('CREATE SEQUENCE public.content_enqueue_attempt');
      await dbAdmin.query(`CREATE FUNCTION public.fail_content_enqueue() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.name='content.image' AND nextval('public.content_enqueue_attempt')=1 THEN
        RAISE EXCEPTION 'native content enqueue retry'; END IF; RETURN NEW; END $$`);
      await dbAdmin.query(`CREATE TRIGGER content_enqueue_retry BEFORE INSERT ON dbos.workflow_status
      FOR EACH ROW EXECUTE FUNCTION public.fail_content_enqueue()`);
      worker = await startWorker({ databaseUrl, poolSize: 10, executorId: 'content-effects-fixture' }, [module]);
      expect(additions).toBe(1);
      expect(register.mock.calls.filter((call) => call[1]?.name === 'effect')).toHaveLength(1);
      expect(register.mock.calls.map((call) => call[1]?.name)).toEqual(['effect']);
      expect(new Set(effects.map((effect) => effect.name)).size).toBe(effects.length);
      const boardId = newId(0x7130);
      await dbAdmin.query(
        `INSERT INTO content.board
      (route,board_id,subject_id,title,visibility,security_revision,recorded_transaction_id)
      VALUES ($1,$2,$3,'Board','published',1,$4)`,
        [0x7130, boardId, newId(0x7130), crypto.randomUUID()],
      );
      // Seed immutable source facts through native command/outbox fences. This
      // fixture composes only content effects; Auth owns a separate DBOS runtime.
      const threadId = newId(0x1234);
      const itemId = newId(0x1234);
      const revisionId = newId(0x1234);
      const actorId = newId(16);
      const thread = await runCommand(db, { partition: partitionOf(0x1234) }, async (tx, context) => {
        await tx.query(
          `INSERT INTO content.thread
          (route,thread_id,author_account_id,board_id,title,visibility,security_revision,recorded_transaction_id)
          VALUES ($1,$2,$3,$4,'Private title','published',1,$5)`,
          [0x1234, threadId, actorId, boardId, context.transactionId],
        );
        return {
          value: { threadId },
          events: [
            {
              type: 'com.rezics.content.thread.created.v1',
              subject: threadId,
              data: { threadId, itemId, revisionId, actorId, ...SUBJECT_THREAD_EVENT_FIELDS },
            },
          ],
        };
      });
      const target = { kind: 'thread' as const, id: threadId };
      const reportId = newId(0x5678);
      const report = await runCommand(db, { partition: partitionOf(0x5678) }, async (tx, context) => {
        await tx.query(
          `INSERT INTO content.report
          (route,report_id,target_kind,target_id,reason,evidence,reporter_account_id,created_at,recorded_transaction_id)
          VALUES ($1,$2,'thread',$3,'spam','Private evidence',$4,now(),$5)`,
          [0x5678, reportId, threadId, actorId, context.transactionId],
        );
        return {
          value: { reportId },
          events: [
            {
              type: 'com.rezics.content.report.created.v1',
              subject: reportId,
              data: { reportId, targetKind: target.kind, targetId: target.id },
            },
          ],
        };
      });
      const candidates = () => readBoardCandidates(db, boardId, null, 100);
      const reports = async () => ({
        entries: (
          await db.query<{ id: string }>(
            `SELECT report_id AS id FROM content.report_target
         WHERE route=$1 AND target_kind=$2 AND target_id=$3 ORDER BY report_id`,
            [routeOf(target.id), target.kind, target.id],
          )
        ).rows,
      });
      await until(async () =>
        (await candidates()).candidates.some((candidate) => candidate.id === thread.value.threadId),
      );
      await until(async () => (await reports()).entries.some((entry) => entry.id === report.value.reportId));
      expect(partitionOf(routeOf(boardId)!)).not.toBe(thread.partition);
      expect(report.partition).not.toBe(thread.partition);
      const partition = 2700;
      const envelope = await append(
        partition,
        [{ type: 'com.rezics.content.media.uploaded.v1', data: uploaded(partition) }],
        db,
      );
      const event = envelope.events[0]!;
      const enqueueEffect = effects.find((effect) => effect.types.includes(event.type))!;
      const effectId = effectWorkflowId(envelope, 0, enqueueEffect.name);
      await DBOS.retrieveWorkflow(effectId).getResult();
      const id = contentWorkWorkflowId(envelope, 0, 'image');
      expect(await row(id, dbAdmin)).toMatchObject({
        status: 'ENQUEUED',
        queue_partition_key: String(partition),
        inputs: JSON.stringify([
          { mediaId: (event.data as { mediaId: string }).mediaId, source: contentWorkSource(envelope, 0) },
        ]),
      });
      expect((await dbAdmin.query('SELECT last_value FROM public.content_enqueue_attempt')).rows[0].last_value).toBe(
        '2',
      );
      expect(
        (await dbAdmin.query('SELECT 1 FROM dbos.workflow_status WHERE workflow_uuid=$1', [id])).rows,
      ).toHaveLength(1);
      const before = await candidates();
      const beforeReports = await reports();
      for (const effect of effects.slice(0, 2)) {
        const { rows } = await dbAdmin.query(
          `SELECT wi.inputs FROM dbos.workflow_status ws JOIN dbos.workflow_input wi USING (workflow_uuid)
         WHERE ws.name=$1 AND wi.inputs::jsonb->'json'->>0=$2`,
          ['effect', effect.name],
        );
        for (const stored of rows) await effect.run(JSON.parse(stored.inputs).json[1]);
      }
      expect((await candidates()).candidates).toEqual(before.candidates);
      expect((await reports()).entries).toEqual(beforeReports.entries);
      expect(
        (await dbAdmin.query("SELECT DISTINCT consumer FROM core.consumer_checkpoint WHERE consumer LIKE 'content_%'"))
          .rows,
      ).toEqual([]);
      expect(await workClient.getWorkflow(effectId)).toMatchObject({
        status: 'SUCCESS',
        queuePartitionKey: String(partition),
      });
    } finally {
      register.mockRestore();
      await worker?.stop();
      await workClient.close();
      await dbAdmin.end();
      await db.end();
    }
  },
  60_000,
);

test('checkGrowth measures actual deterministic native enqueue against same-partition media history and work', async () => {
  const db = await openGrowthDatabase(url);
  const work = await createWorkClient(url, db.openPool({ max: 2 }));
  const partition = freshPartition();
  const envelope = await append(
    partition,
    [{ type: 'com.rezics.content.media.uploaded.v1', data: uploaded(partition) }],
    db.pool,
  );
  const event = envelope.events[0]!;
  const effect = effectFor(event, db.pool, work);
  try {
    // Native table sizes are informative before the smallest measured scale.
    // Checkpoints span many partitions/consumers without touching the target.
    await db.admin.query(`INSERT INTO core.consumer_checkpoint (partition_no,consumer,epoch,position)
      SELECT 3000 + n % 500, 'growth_' || (n / 500)::text, NULL, 0 FROM generate_series(0,999) AS n`);
    for (let index = 0; index < 512; index++) {
      const data = uploaded(partition + 1);
      const source = await append(partition + 1, [{ type: event.type, data }], db.pool);
      await effect.run(source.events[0]!);
    }
    const report = await checkGrowth(db, {
      name: 'content native enqueue fixed source and changed set',
      scales: [32, 256, 2048],
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      async grow(_database, scale, previous) {
        for (let index = previous; index < scale; index++) {
          const data = uploaded(partition);
          await seedMedia(data, db.admin);
          const source = await append(partition, [{ type: event.type, data }], db.pool);
          await effect.run(source.events[0]!);
        }
        for (const relation of [
          'core.outbox',
          'core.consumer_checkpoint',
          'content.media',
          'dbos.workflow_status',
          'dbos.workflow_input',
        ])
          await db.admin.query(`VACUUM (ANALYZE) ${relation}`);
      },
      async operation() {
        await effect.run(event);
      },
    });
    expect(report.samples.map((sample) => sample.scale)).toEqual([32, 256, 2048]);
    expect(report.samples.every((sample) => sample.cost.rows > 0 && sample.cost.statements > 0)).toBe(true);
    expect(report.samples.at(-1)!.cost.relations?.['core.outbox']?.sequentialScans).toBe(0);
    expect(await row(contentWorkWorkflowId(envelope, 0, 'image'))).toMatchObject({ status: 'ENQUEUED' });
    console.info(JSON.stringify(report));
  } finally {
    await work.close();
    await db.close();
  }
}, 90_000);
