import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createSubject } from '../../src/semantic/subject.ts';
import { mergeSubjects } from '../../src/semantic/merges.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { processSubjectReactionMergePage, runSubjectReactionMerge } from '../../src/content/subject-reaction-merge.ts';
import { projectReactionCounts, readReactionCounts } from '../../src/content/reaction-projection.ts';
import { contentEffects } from '../../src/content/relays.ts';
import { subjectReactionMergeWorkflowId } from '../../src/content/work-contract.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { readBatch, type Envelope } from '../../src/events/log.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { WORK_QUEUES } from '../../src/work/queues.ts';
import { checkGrowth, seed, type Population } from '../support/growth.ts';
import { reactionFixture, request } from './reactions.test.ts';

let f: Awaited<ReturnType<typeof reactionFixture>>;
let commands: typeof import('../../src/content/reactions.ts');
let workPool: Pool;
let workClient: Awaited<ReturnType<typeof createWorkClient>>;

beforeAll(async () => {
  f = await reactionFixture();
  commands = await import('../../src/content/reactions.ts');
  await bootstrapRelease(f.db.pool, bundledRelease);
  workPool = new Pool({ connectionString: f.db.url, max: 10 });
  workClient = await createWorkClient(f.db.url, workPool);
  for (const [name, options] of Object.entries(WORK_QUEUES)) await workClient.registerQueue(name, options);
}, 120_000);

afterAll(async () => {
  await workClient?.close();
  await workPool?.end();
  await f?.close();
});

async function subject(label: string): Promise<string> {
  const id = newId(f.targetRoute);
  await createSubject(f.db.pool, {
    actor: await f.verified(f.managerId),
    target: { route: f.targetRoute, id },
    idempotencyKey: crypto.randomUUID(),
    digest: createHash('sha256').update(id).digest(),
    item: { type: 'schema:Book', labels: { en: label } },
    release: { digest: bundledDigest, release: bundledRelease },
    authorize: async () => true,
  });
  await f.grant(id, ['reaction:set']);
  return id;
}

async function merge(left: string, right: string) {
  return mergeSubjects(f.db.pool, {
    subjects: [left, right],
    actor: await f.verified(f.managerId),
    idempotencyKey: crypto.randomUUID(),
    digest: createHash('sha256').update(`${left}:${right}`).digest(),
    release: { digest: bundledDigest, release: bundledRelease },
    deadline: Date.now() + 30_000,
    authorization: {
      action: 'subject:merge',
      resource: { route: 0, id: GLOBAL_CONTEXT },
      denied: () => new Error('Denied'),
      async authorize() {
        return 'execute';
      },
    },
  });
}

async function mergeEnvelope(result: Awaited<ReturnType<typeof merge>>): Promise<Envelope> {
  const { partition, epoch, position } = result.component;
  const consumer = `subject_merge_${crypto.randomUUID().replaceAll('-', '')}`;
  await f.db.admin.query(
    `INSERT INTO core.consumer_checkpoint(partition_no,consumer,epoch,position)
     VALUES ($1,$2,$3,$4)`,
    [partition, consumer, epoch, position - 1n],
  );
  let envelope: Envelope | undefined;
  await readBatch(f.db.pool, {
    consumer,
    partition,
    envelopes: 1,
    apply: async (batch) => {
      envelope = batch[0];
    },
  });
  if (!envelope) throw new Error('Semantic merge event was not read');
  return envelope;
}

async function reactionCount(targetId: string) {
  const client = await f.db.pool.connect();
  try {
    return await readReactionCounts(client, { targetId });
  } finally {
    client.release();
  }
}

async function grantManagerReaction(subjectId: string) {
  await f.db.admin.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
     VALUES ($1,$2,$3,'reaction:set','(,)',$3) ON CONFLICT DO NOTHING`,
    [routeOf(subjectId), subjectId, f.managerId],
  );
}

async function relayReactionPartitions(actorIds: readonly string[]) {
  for (const partition of new Set(actorIds.map((id) => partitionOf(routeOf(id)!)))) {
    for (;;) {
      const result = await projectReactionCounts(f.db.pool, partition);
      if (result.status === 'read' && result.envelopes === 0) break;
      if (result.status === 'stopped') throw new Error(`Reaction relay stopped: ${result.reason}`);
    }
  }
}

function stepHarness() {
  const saved = new Map<string, Awaited<ReturnType<typeof processSubjectReactionMergePage>>>();
  let failAfterFirstCheckpoint = true;
  let pageBodies = 0;
  const step = async (
    name: string,
    action: () => Promise<Awaited<ReturnType<typeof processSubjectReactionMergePage>>>,
  ) => {
    const prior = saved.get(name);
    if (prior) return prior;
    const result = await action();
    pageBodies++;
    saved.set(name, result);
    if (failAfterFirstCheckpoint) {
      failAfterFirstCheckpoint = false;
      throw new Error('simulated worker restart after cursor checkpoint');
    }
    return result;
  };
  return { saved, step, pageBodies: () => pageBodies };
}

test('a real subject merge queues one event-derived job and reactions converge with survivor slots preserved', async () => {
  const first = await subject('Reaction merge survivor candidate');
  const second = await subject('Reaction merge source candidate');
  const survivor = [first, second].sort()[0]!;
  const merged = [first, second].sort()[1]!;
  const actorA = await f.verified();
  const actorB = await f.verified(f.managerId);
  await grantManagerReaction(survivor);
  await grantManagerReaction(merged);

  await commands.setReaction(
    { pool: f.db.pool, access: f.access },
    actorA,
    { targetKind: 'subject', targetId: merged, kind: 'like' },
    request(),
  );
  await commands.setReaction(
    { pool: f.db.pool, access: f.access },
    actorA,
    { targetKind: 'subject', targetId: survivor, kind: 'love' },
    request(),
  );
  await commands.setReaction(
    { pool: f.db.pool, access: f.access },
    actorB,
    { targetKind: 'subject', targetId: merged, kind: 'laugh' },
    request(),
  );
  await relayReactionPartitions([f.accountId, f.managerId]);

  const mergedResult = await merge(first, second);
  const envelope = await mergeEnvelope(mergedResult);
  const event = envelope.events[0]!;
  const mergeEffect = contentEffects(f.db.pool, workClient).find((effect) => effect.types.includes(event.type));
  expect(mergeEffect).toBeDefined();
  await mergeEffect!.run(event);
  await mergeEffect!.run(event);

  const workflowId = subjectReactionMergeWorkflowId(envelope, 0, merged);
  const queued = await f.db.admin.query<{ name: string; queue_name: string; inputs: unknown }>(
    `SELECT workflow_status.name,workflow_status.queue_name,workflow_input.inputs
       FROM dbos.workflow_status JOIN dbos.workflow_input USING(workflow_uuid)
     WHERE workflow_uuid=$1`,
    [workflowId],
  );
  expect(queued.rows).toHaveLength(1);
  expect(queued.rows[0]).toMatchObject({
    name: 'content.subjectReactionMerge',
    queue_name: 'effects',
  });

  const durable = stepHarness();
  const run = () =>
    runSubjectReactionMerge({ id: merged, survivor }, (cursor) =>
      durable.step(`page:${cursor ?? 'start'}`, () =>
        processSubjectReactionMergePage({ pool: f.db.pool, access: f.access }, { id: merged, survivor, cursor }),
      ),
    );
  await expect(run()).rejects.toThrow('simulated worker restart after cursor checkpoint');
  await run();
  expect(durable.pageBodies()).toBe(1);

  await relayReactionPartitions([f.accountId, f.managerId]);
  expect(await reactionCount(merged)).toMatchObject({ counts: [] });
  expect((await reactionCount(survivor)).counts).toEqual([
    { kind: 'laugh', count: 1 },
    { kind: 'love', count: 1 },
  ]);
  const reactors = await f.db.admin.query<{ actor_account_id: string; kind: string }>(
    `SELECT actor_account_id,kind FROM content.subject_reactor WHERE route=$1 AND subject_id=$2
     ORDER BY actor_account_id`,
    [routeOf(survivor), survivor],
  );
  expect(reactors.rows).toEqual(
    [
      { actor_account_id: f.accountId, kind: 'love' },
      { actor_account_id: f.managerId, kind: 'laugh' },
    ].sort((a, b) => a.actor_account_id.localeCompare(b.actor_account_id)),
  );
});

test('a restarted merge job uses its saved actor cursor and a chained merge resolves the final survivor', async () => {
  const pair = [await subject('Cursor merge survivor'), await subject('Cursor merge source')].sort();
  const merged = pair[1]!;
  const survivor = pair[0]!;
  await merge(pair[0]!, pair[1]!);
  const actors = Array.from({ length: 256 }, () => newId(f.home));
  await f.db.admin.query(
    `INSERT INTO content.reaction(route,actor_account_id,target_kind,target_route,target_id,kind,updated_at)
     SELECT (get_byte(uuid_send(actor_id),10)*256+get_byte(uuid_send(actor_id),11)),
            actor_id,'subject',$2,$3,'like','2026-10-27T00:00:00Z'
     FROM unnest($1::uuid[]) AS actors(actor_id)`,
    [actors, routeOf(merged), merged],
  );
  await f.db.admin.query(
    `INSERT INTO content.subject_reactor(route,subject_id,actor_account_id,kind)
     SELECT $1,$2,actor_id,'like' FROM unnest($3::uuid[]) AS actors(actor_id)`,
    [routeOf(merged), merged, actors],
  );

  const durable = stepHarness();
  const run = () =>
    runSubjectReactionMerge({ id: merged, survivor }, (cursor) =>
      durable.step(`page:${cursor ?? 'start'}`, () =>
        processSubjectReactionMergePage({ pool: f.db.pool, access: f.access }, { id: merged, survivor, cursor }),
      ),
    );
  await expect(run()).rejects.toThrow('simulated worker restart after cursor checkpoint');
  await run();
  expect(durable.pageBodies()).toBe(3);
  expect(durable.saved.size).toBe(3);
  expect(await f.db.admin.query('SELECT 1 FROM content.reaction WHERE target_id=$1', [merged])).toMatchObject({
    rows: [],
  });
  expect(
    await f.db.admin.query('SELECT count(*)::int AS count FROM content.reaction WHERE target_id=$1', [survivor]),
  ).toMatchObject({ rows: [{ count: 256 }] });
  await relayReactionPartitions(actors);
  expect((await reactionCount(merged)).counts).toEqual([]);
  expect((await reactionCount(survivor)).counts).toEqual([{ kind: 'like', count: 256 }]);

  const chain = [await subject('Chain earliest'), await subject('Chain middle'), await subject('Chain latest')].sort();
  const [finalSurvivor, intermediate, chainSource] = chain as [string, string, string];
  await commands.setReaction(
    { pool: f.db.pool, access: f.access },
    await f.verified(),
    { targetKind: 'subject', targetId: chainSource, kind: 'sad' },
    request(),
  );
  await relayReactionPartitions([f.accountId]);
  await merge(intermediate, chainSource);
  await merge(finalSurvivor, intermediate);
  const chained = stepHarness();
  const runChained = () =>
    runSubjectReactionMerge({ id: chainSource, survivor: intermediate }, (cursor) =>
      chained.step(`page:${cursor ?? 'start'}`, () =>
        processSubjectReactionMergePage(
          { pool: f.db.pool, access: f.access },
          { id: chainSource, survivor: intermediate, cursor },
        ),
      ),
    );
  await expect(runChained()).rejects.toThrow('simulated worker restart after cursor checkpoint');
  await runChained();
  await relayReactionPartitions([f.accountId]);
  expect((await reactionCount(finalSurvivor)).counts).toEqual([{ kind: 'sad', count: 1 }]);
  expect((await reactionCount(chainSource)).counts).toEqual([]);
});

test('one merge page', async () => {
  const scales: [number, number, number] = [256, 1024, 4096];
  const measured = [await subject('Measured merge page survivor'), await subject('Measured merge page source')].sort();
  await merge(measured[0]!, measured[1]!);
  const warmups: Array<{ source: string; survivor: string }> = [];
  for (const scale of scales) {
    const pair = [
      await subject(`Warmup merge page ${scale} survivor`),
      await subject(`Warmup merge page ${scale} source`),
    ].sort();
    await merge(pair[0]!, pair[1]!);
    warmups.push({ source: pair[1]!, survivor: pair[0]! });
  }
  const measuredPair = { source: measured[1]!, survivor: measured[0]! };
  const allSources = [measuredPair.source, ...warmups.map(({ source }) => source)];
  const population: Population = {
    name: `subject-reaction-merge-pages-${crypto.randomUUID()}`,
    hotPartition: partitionOf(f.home),
    hotShare: 1,
    rows: ({ route }) => {
      const actorId = newId(route);
      const rows = allSources.map((targetId) => ({
        route,
        actor_account_id: actorId,
        target_kind: 'subject',
        target_route: routeOf(targetId),
        target_id: targetId,
        kind: 'like',
        updated_at: '2026-10-27T00:00:00Z',
      }));
      const reactors = allSources.map((subjectId) => ({
        route: routeOf(subjectId),
        subject_id: subjectId,
        actor_account_id: actorId,
        kind: 'like',
      }));
      return { 'content.reaction': rows, 'content.subject_reactor': reactors };
    },
  };
  const index = new Map<number, number>(scales.map((scale, ordinal) => [scale, ordinal]));
  let measuredCursor: string | null = null;
  const report = await checkGrowth(f.db, {
    name: 'Subject reaction merge page',
    scales,
    warmups: 1,
    repetitions: 1,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    async grow(database, scale, previous) {
      await seed(database, population, { from: previous, to: scale });
    },
    async warmup(_database, scale) {
      const { source, survivor } = warmups[index.get(scale)!]!;
      await processSubjectReactionMergePage(
        { pool: f.db.pool, access: f.access },
        { id: source, survivor, cursor: null },
      );
    },
    async operation(_database, scale) {
      const page = await processSubjectReactionMergePage(
        { pool: f.db.pool, access: f.access },
        { ...measuredPair, id: measuredPair.source, cursor: measuredCursor },
      );
      expect(page.complete).toBe(false);
      measuredCursor = page.cursor;
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
  expect(report.samples[0]!.cost.relations['content.subject_reactor']!.rows).toBe(100);
  expect(report.samples[1]!.cost.relations['content.subject_reactor']!.rows).toBe(100);
  expect(report.samples[2]!.cost.relations['content.subject_reactor']!.rows).toBe(100);
  expect(report.samples[0]!.cost.statements).toBe(report.samples[2]!.cost.statements);
});
