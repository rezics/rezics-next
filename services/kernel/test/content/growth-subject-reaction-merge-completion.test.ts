import { afterAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createSubject } from '../../src/semantic/subject.ts';
import { mergeSubjects } from '../../src/semantic/merges.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { readReactionCounts } from '../../src/content/reaction-projection.ts';
import { setReaction } from '../../src/content/reactions.ts';
import { GrantDeniedError } from '../../src/access/grant-commands.ts';
import { accessCommandAuthorization, type AccountActor } from '../../src/request/access.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { effectWorkflowId } from '../../src/events/effects.ts';
import { readBatch, type Envelope } from '../../src/events/log.ts';
import { SUBJECT_MERGED } from '../../src/semantic/events.ts';
import { subjectReactionMergeWorkflowId } from '../../src/content/work-contract.ts';
import {
  assertGrowthAccessPaths,
  checkGrowth,
  openGrowthDatabase,
  seed,
  type GrowthDatabase,
  type ReportSample,
} from '../support/growth.ts';
import {
  createReactionRelayBase,
  readPartitionPosition,
  type ReactionRelayBase,
} from './reaction-relay-convergence-fixture.ts';
import {
  primeEffectRelayAtCurrentHead,
  startRegisteredMergeRuntime,
  unrelatedMergePopulation,
  type RegisteredMergeRuntime,
} from './support/growth-subject-reaction-merge-completion-fixture.ts';
import { registerNativeContentAccount } from './support/native-system.ts';

const scales = [256, 1024, 4096] as const;
const selectedActors = 100;
const survivorCollisions = 10;
const subjectReadName = 'com.rezics.content.reaction.changed.v1';

type Scenario = 'terminal' | 'checkpoint-replay';
type Axis = 'subjects' | 'actors' | 'history';
type FixturePhase = 'warmup' | 'measured';
type MergeCase = Readonly<{
  scenario: Scenario;
  scale: number;
  phase: FixturePhase;
  source: string;
  middle?: string;
  final: string;
}>;
type ActorEventCheckpoint = Readonly<{ consumer: string; partitions: readonly number[] }>;
type CapturedReactionEvent = Readonly<{ envelope: Envelope; eventIndex: number }>;
type OperationEvidence = Readonly<{
  scale: number;
  scenario: Scenario;
  source: string;
  final: string;
  pageReads: number;
  intermediatePageReads: number | null;
  reactionEvents: number;
  sourceClears: number;
  survivorAdds: number;
}>;

let base: ReactionRelayBase | undefined;
let growth: GrowthDatabase | undefined;
let runtime: RegisteredMergeRuntime | undefined;
let actors: AccountActor[] = [];
let author: AccountActor | undefined;
let governance: AccountActor | undefined;
let deniedActor: AccountActor | undefined;

afterAll(async () => {
  try {
    await runtime?.close();
  } finally {
    try {
      await growth?.close();
    } finally {
      await base?.system.close();
    }
  }
});

async function registerNativeActors(
  f: ReactionRelayBase,
  count: number,
): Promise<readonly { accountId: string; bearer: string }[]> {
  const identities: { accountId: string; bearer: string }[] = [];
  const unique = randomUUID().replaceAll('-', '');
  for (let start = 0; start < count; start += 10) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(10, count - start) }, async (_, offset) => {
        const index = start + offset;
        const handle = `mergegrowth${unique}${index}`;
        const registered = await registerNativeContentAccount(f.system, {
          key: handle,
          handle,
          email: `${handle}@content.test`,
          password: 'ordinary native test password',
        });
        const credential = await f.system.auth.issue({
          accountId: registered.accountId,
          clientId: f.system.auth.ordinaryClient.id,
          scopes: f.system.auth.ordinaryScopes,
        });
        return { accountId: registered.accountId, bearer: credential.bearer };
      }),
    );
    identities.push(...batch);
  }
  return identities;
}

async function installReactionGrants(pool: Pool, accountIds: readonly string[]): Promise<void> {
  await pool.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
     SELECT 0,$1,account_id,'reaction:set','(,)',account_id
     FROM unnest($2::uuid[]) AS selected(account_id)
     ON CONFLICT DO NOTHING`,
    [GLOBAL_CONTEXT, accountIds],
  );
}

function requiredRoute(id: string): number {
  const route = routeOf(id);
  if (route === null) throw new TypeError(`Expected a routed native identifier: ${id}`);
  return route;
}

async function nativeSubject(label: string, route: number): Promise<string> {
  if (!base || !growth || !author) throw new Error('Native Semantic fixture is not ready');
  const id = newId(route);
  const deadline = Date.now() + 30_000;
  const authorization = await accessCommandAuthorization(
    base.system.access,
    author,
    'subject:create',
    { route: 0, id: GLOBAL_CONTEXT },
    { pool: growth.pool, deadline },
    () => new Error('Native subject creation was denied'),
  );
  const created = await createSubject(growth.pool, {
    actor: author,
    target: { route, id },
    idempotencyKey: `merge-growth-subject-${randomUUID()}`,
    digest: createHash('sha256').update(`${label}:${id}`).digest(),
    item: { type: 'schema:Book', labels: { en: label } },
    release: { digest: bundledDigest, release: bundledRelease },
    authorization,
    deadline,
  });
  if (created.subject.id !== id) throw new Error('Native Semantic creation returned a different subject');
  return id;
}

async function nativeMerge(source: string, survivor: string, idempotencyKey: string) {
  if (!base || !growth || !governance) throw new Error('Native Semantic fixture is not ready');
  const deadline = Date.now() + 30_000;
  const authorization = await accessCommandAuthorization(
    base.system.access,
    governance,
    'subject:merge',
    { route: 0, id: GLOBAL_CONTEXT },
    { pool: growth.pool, deadline },
    () => new Error('Native subject merge was denied'),
  );
  return mergeSubjects(growth.pool, {
    subjects: [source, survivor],
    survivor,
    actor: governance,
    idempotencyKey,
    digest: createHash('sha256').update(`${source}:${survivor}:${idempotencyKey}`).digest(),
    release: { digest: bundledDigest, release: bundledRelease },
    authorization,
    deadline,
  });
}

async function createCase(scenario: Scenario, scale: number, phase: FixturePhase, route: number): Promise<MergeCase> {
  const suffix = `${scenario}-${scale}-${phase}-${randomUUID()}`;
  const source = await nativeSubject(`Reaction merge source ${suffix}`, route);
  const final = await nativeSubject(`Reaction merge final ${suffix}`, route);
  if (scenario === 'checkpoint-replay') return { scenario, scale, phase, source, final };
  const middle = await nativeSubject(`Reaction merge middle ${suffix}`, route);
  return { scenario, scale, phase, source, middle, final };
}

async function setReactionSlot(actor: AccountActor, targetId: string, kind: 'like' | 'love', label: string) {
  if (!base || !growth) throw new Error('Native reaction fixture is not ready');
  const result = await setReaction(
    { pool: growth.pool, access: base.system.access },
    actor,
    { targetKind: 'subject', targetId, kind },
    {
      idempotencyKey: `merge-growth-reaction-${label}-${randomUUID()}`,
      deadline: Date.now() + 30_000,
      requestId: randomUUID(),
    },
  );
  if (!result || result.value.kind !== kind)
    throw new Error(`Native reaction command did not create ${kind} for ${actor.accountId}/${targetId}`);
}

async function setSelectedSlots(cases: readonly MergeCase[]): Promise<void> {
  if (actors.length !== selectedActors) throw new Error('The selected reaction actor set must contain exactly 100 accounts');
  for (const item of cases) {
    for (let start = 0; start < actors.length; start += 20) {
      await Promise.all(
        actors.slice(start, start + 20).map((actor) =>
          setReactionSlot(actor, item.source, 'like', `${item.scenario}-${item.scale}-${item.phase}`),
        ),
      );
    }
    await Promise.all(
      actors.slice(0, survivorCollisions).map((actor) =>
        setReactionSlot(actor, item.final, 'love', `${item.scenario}-${item.scale}-${item.phase}-survivor`),
      ),
    );
  }
}

async function reactionCounts(targetId: string) {
  if (!growth) throw new Error('Growth database is not ready');
  const client = await growth.pool.connect();
  try {
    return await readReactionCounts(client, { targetId });
  } finally {
    client.release();
  }
}

async function waitForInitialProjection(item: MergeCase): Promise<void> {
  const deadline = Date.now() + 180_000;
  for (;;) {
    const [source, final] = await Promise.all([reactionCounts(item.source), reactionCounts(item.final)]);
    if (
      JSON.stringify(source.counts) === JSON.stringify([{ kind: 'like', count: selectedActors }]) &&
      JSON.stringify(final.counts) === JSON.stringify([{ kind: 'love', count: survivorCollisions }])
    )
      return;
    if (Date.now() >= deadline) throw new Error(`Registered reaction projection did not settle for ${item.source}`);
    await Bun.sleep(25);
  }
}

async function provisionCases(scenario: Scenario, route: number): Promise<Map<number, { warmup: MergeCase; measured: MergeCase }>> {
  if (!runtime) throw new Error('Registered Content runtime is not ready');
  const cases = new Map<number, { warmup: MergeCase; measured: MergeCase }>();
  for (const scale of scales) {
    cases.set(scale, {
      warmup: await createCase(scenario, scale, 'warmup', route),
      measured: await createCase(scenario, scale, 'measured', route),
    });
  }
  // Subject creation is fixture setup. Start the registered effects relay at its exact head,
  // then let only the real selected reaction commands produce measured projection state.
  await primeEffectRelayAtCurrentHead(growth!.pool);
  const selected = [...cases.values()].flatMap(({ warmup, measured }) => [warmup, measured]);
  await setSelectedSlots(selected);
  runtime.resume();
  await Promise.all(selected.map(waitForInitialProjection));
  await runtime.pause();
  return cases;
}

async function captureActorEvents(): Promise<ActorEventCheckpoint> {
  if (!growth) throw new Error('Growth database is not ready');
  const partitions = [
    ...new Set(
      actors.map((actor) => {
        const route = requiredRoute(actor.accountId);
        return partitionOf(route);
      }),
    ),
  ];
  const consumer = `merge_growth_${randomUUID().replaceAll('-', '')}`;
  for (const partition of partitions) {
    const before = await readPartitionPosition(growth.pool, partition);
    await growth.pool.query(
      `INSERT INTO core.consumer_checkpoint(partition_no,consumer,epoch,position)
       VALUES ($1,$2,$3,$4)`,
      [partition, consumer, before.epoch, before.position],
    );
  }
  return { consumer, partitions };
}

async function mergeWorkflowId(
  result: Awaited<ReturnType<typeof mergeSubjects>>,
  mergedId: string,
): Promise<string> {
  if (!growth) throw new Error('Growth database is not ready');
  const { partition, epoch, position } = result.component;
  const consumer = `merge_event_${randomUUID().replaceAll('-', '')}`;
  await growth.pool.query(
    `INSERT INTO core.consumer_checkpoint(partition_no,consumer,epoch,position)
     VALUES ($1,$2,$3,$4)`,
    [partition, consumer, epoch, position - 1n],
  );
  const envelopes: Envelope[] = [];
  const batch = await readBatch(growth.pool, {
    consumer,
    partition,
    envelopes: 1,
    apply: async (read) => {
      envelopes.push(...read);
    },
  });
  const envelope = envelopes[0];
  if (batch.status !== 'read' || !envelope || envelope.position !== position)
    throw new Error('Native Semantic merge event was not returned by the registered event reader');
  const eventIndex = envelope.events.findIndex((event) => event.type === SUBJECT_MERGED);
  if (eventIndex < 0) throw new Error('Native Semantic merge event was absent from its committed envelope');
  return subjectReactionMergeWorkflowId(envelope, eventIndex, mergedId);
}

async function readReactionEvents(checkpoint: ActorEventCheckpoint): Promise<CapturedReactionEvent[]> {
  if (!growth) throw new Error('Growth database is not ready');
  const events: CapturedReactionEvent[] = [];
  for (const partition of checkpoint.partitions) {
    for (;;) {
      const envelopes: Envelope[] = [];
      const result = await readBatch(growth.pool, {
        consumer: checkpoint.consumer,
        partition,
        envelopes: 64,
        apply: async (read) => {
          envelopes.push(...read);
        },
      });
      if (result.status === 'stopped') throw new Error(`Actor reaction event read stopped: ${result.reason}`);
      if (result.status !== 'read' || result.envelopes === 0) break;
      for (const envelope of envelopes)
        for (const [eventIndex, event] of envelope.events.entries())
          if (event.type === subjectReadName) events.push({ envelope, eventIndex });
    }
  }
  return events;
}

async function assertSurvivorState(item: MergeCase): Promise<void> {
  if (!growth) throw new Error('Growth database is not ready');
  const queried = await growth.admin.query<{ actor_account_id: string; kind: 'like' | 'love'; target_id: string }>(
    `SELECT actor_account_id,target_id,kind
       FROM content.reaction
      WHERE target_kind='subject' AND target_id=ANY($1::uuid[])
      ORDER BY actor_account_id,target_id`,
    [item.middle ? [item.source, item.middle, item.final] : [item.source, item.final]],
  );
  const expected: Array<{ actor_account_id: string; target_id: string; kind: 'like' | 'love' }> = actors
    .map((actor, index) => ({
      actor_account_id: actor.accountId,
      target_id: item.final,
      kind: index < survivorCollisions ? ('love' as const) : ('like' as const),
    }))
    .sort((left, right) => left.actor_account_id.localeCompare(right.actor_account_id));
  expect(queried.rows).toEqual(expected);
  const [sourceCounts, finalCounts, middleCounts] = await Promise.all([
    reactionCounts(item.source),
    reactionCounts(item.final),
    item.middle ? reactionCounts(item.middle) : Promise.resolve({ counts: [] }),
  ]);
  expect(sourceCounts.counts).toEqual([]);
  expect(middleCounts.counts).toEqual([]);
  expect(finalCounts.counts).toEqual([
    { kind: 'like', count: selectedActors - survivorCollisions },
    { kind: 'love', count: survivorCollisions },
  ]);
}

async function executeCase(
  item: MergeCase,
  actorEvents: ActorEventCheckpoint,
  failSecondPage: boolean,
): Promise<OperationEvidence> {
  if (!runtime) throw new Error('Registered Content runtime is not ready');
  await runtime.pause();
  const sourceReadsBefore = runtime.pageReads(item.source);
  const middleReadsBefore = item.middle ? runtime.pageReads(item.middle) : 0;
  if (!base || !growth || !deniedActor) throw new Error('The denied native actor is not ready');
  let denied: unknown;
  try {
    await setReaction(
      { pool: growth.pool, access: base.system.access },
      deniedActor,
      { targetKind: 'subject', targetId: item.final, kind: 'like' },
      {
        idempotencyKey: `merge-growth-denied-${item.scenario}-${item.scale}-${randomUUID()}`,
        deadline: Date.now() + 30_000,
        requestId: randomUUID(),
      },
    );
  } catch (error) {
    denied = error;
  }
  if (!(denied instanceof GrantDeniedError)) throw new Error('Native Access did not deny the ungranted reaction actor');
  const idempotency = `${item.scenario}-${item.scale}-${item.phase}-${randomUUID()}`;
  const workflows: string[] = [];
  if (item.middle) {
    const first = await nativeMerge(item.source, item.middle, `${idempotency}-source`);
    workflows.push(await mergeWorkflowId(first, item.source));
    const second = await nativeMerge(item.middle, item.final, `${idempotency}-middle`);
    workflows.push(await mergeWorkflowId(second, item.middle));
  } else {
    const merged = await nativeMerge(item.source, item.final, `${idempotency}-source`);
    workflows.push(await mergeWorkflowId(merged, item.source));
  }
  if (failSecondPage) runtime.failSecondPageOnce();
  runtime.resume();
  await Promise.all(workflows.map((workflowId) => runtime!.waitForWorkflow(workflowId)));

  const reactionEvents = await readReactionEvents(actorEvents);
  const reactionWorkflowIds = reactionEvents.map(({ envelope, eventIndex }) =>
    effectWorkflowId(envelope, eventIndex, 'content_reaction_count'),
  );
  await Promise.all(reactionWorkflowIds.map((workflowId) => runtime!.waitForWorkflow(workflowId)));
  await runtime.pause();

  const sourceClears = reactionEvents.filter(({ envelope, eventIndex }) => {
    const event = envelope.events[eventIndex]!;
    const data = event.data as { targetId?: unknown; kind?: unknown; previousKind?: unknown };
    return data.targetId === item.source && data.previousKind === 'like' && data.kind === null;
  }).length;
  const survivorAdds = reactionEvents.filter(({ envelope, eventIndex }) => {
    const event = envelope.events[eventIndex]!;
    const data = event.data as { targetId?: unknown; kind?: unknown; previousKind?: unknown };
    return data.targetId === item.final && data.previousKind === null && data.kind === 'like';
  }).length;
  expect(reactionEvents).toHaveLength(selectedActors + selectedActors - survivorCollisions);
  expect(sourceClears).toBe(selectedActors);
  expect(survivorAdds).toBe(selectedActors - survivorCollisions);

  const pageReads = runtime.pageReads(item.source) - sourceReadsBefore;
  const intermediatePageReads = item.middle ? runtime.pageReads(item.middle) - middleReadsBefore : null;
  expect(pageReads).toBe(failSecondPage ? 3 : 2);
  if (item.middle) expect(intermediatePageReads).toBe(1);
  await assertSurvivorState(item);
  return {
    scale: item.scale,
    scenario: item.scenario,
    source: item.source,
    final: item.final,
    pageReads,
    intermediatePageReads,
    reactionEvents: reactionEvents.length,
    sourceClears,
    survivorAdds,
  };
}

function pressureRelation(axis: Axis): readonly string[] {
  if (axis === 'subjects') return ['semantic.subject'];
  if (axis === 'actors') return ['content.reaction', 'content.subject_reactor'];
  return ['core.receipt'];
}

function assertCostReport(name: string, samples: readonly ReportSample[], relations: readonly string[]): void {
  expect(samples.map(({ scale }) => scale)).toEqual([...scales]);
  for (const sample of samples) {
    expect(sample.repetitions).toHaveLength(1);
    expect(sample.cost.statements).toBeGreaterThan(0);
    expect(sample.cost.rows).toBeGreaterThan(0);
    expect(sample.cost.blocks).toBeGreaterThan(0);
    expect(sample.cost.sharedHit + sample.cost.sharedRead).toBeGreaterThan(0);
    expect(sample.statementRepetitions).toHaveLength(1);
    expect(sample.occurrenceRepetitions).toHaveLength(1);
    for (const relation of relations) {
      expect(sample.relationSizes[relation], `${name}: ${relation} seeded at this scale`).toBeDefined();
    }
    for (const relation of [
      'content.subject_reactor',
      'content.reaction',
      'content.reaction_count',
      'content.reaction_total',
      'core.receipt',
      'core.outbox',
    ])
      expect(sample.cost.relations[relation], `${name}: actual ${relation} runner or relay work`).toBeDefined();
  }
  assertGrowthAccessPaths(name, samples, [
    ...new Set([
      ...relations,
      'content.subject_reactor',
      'content.reaction',
      'content.reaction_count',
      'content.reaction_total',
      'core.receipt',
      'core.outbox',
    ]),
  ]);
  console.info(
    name,
    JSON.stringify(
      samples.map(({ scale, cost }) => ({
        scale,
        statements: cost.statements,
        rows: cost.rows,
        blocks: cost.blocks,
        sharedHit: cost.sharedHit,
        sharedRead: cost.sharedRead,
        relations: cost.relations,
      })),
    ),
  );
}

async function runCostSeries(scenario: Scenario, axis: Axis, route: number): Promise<void> {
  if (!base || !growth || !runtime || !governance) throw new Error('Native growth fixture is not ready');
  const unrelatedSubjectId = await nativeSubject(`Unrelated reactor population ${scenario}-${axis}`, route);
  await primeEffectRelayAtCurrentHead(growth.pool);
  const cases = await provisionCases(scenario, route);
  const population = unrelatedMergePopulation({
    axis,
    unrelatedSubjectId,
    unrelatedSubjectRoute: route,
    historyActorId: governance.accountId,
  });
  const seededRows = new Map<number, number>();
  const evidence: OperationEvidence[] = [];
  const prepared = new Map<number, ActorEventCheckpoint>();
  const name = `Native registered subject reaction merge ${scenario}: unrelated ${axis}`;
  const report = await checkGrowth(growth, {
    name,
    scales,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    repetitions: 1,
    warmups: 1,
    async grow(db, scale, previous) {
      await seed(db, population, { from: previous, to: scale });
      seededRows.set(scale, (scale - previous) * pressureRelation(axis).length);
    },
    async warmup(_db, scale) {
      const item = cases.get(scale)?.warmup;
      if (!item) throw new Error(`Missing ${scenario} warmup at scale ${scale}`);
      await executeCase(item, await captureActorEvents(), false);
    },
    async prepare(_db, scale) {
      if (!cases.get(scale)?.measured) throw new Error(`Missing ${scenario} measured case at scale ${scale}`);
      prepared.set(scale, await captureActorEvents());
    },
    async operation(_db, scale) {
      const item = cases.get(scale)?.measured;
      const capture = prepared.get(scale);
      if (!item || !capture) throw new Error(`Missing prepared ${scenario} case at scale ${scale}`);
      const result = await executeCase(item, capture, scenario === 'checkpoint-replay');
      evidence.push(result);
      return result;
    },
  });
  assertCostReport(name, report.samples, pressureRelation(axis));
  for (const sample of report.samples)
    expect(sample.seeding.rowsWritten).toBe(seededRows.get(sample.scale)!);
  expect(evidence.map(({ scale }) => scale)).toEqual([...scales]);
  for (const item of evidence) {
    expect(item.pageReads).toBe(scenario === 'checkpoint-replay' ? 3 : 2);
    expect(item.intermediatePageReads).toBe(scenario === 'terminal' ? 1 : null);
    expect(item.reactionEvents).toBe(190);
    expect(item.sourceClears).toBe(100);
    expect(item.survivorAdds).toBe(90);
  }
}

test(
  'registered Content completion and checkpoint retry retain fixed 100-actor pages across independent growth axes',
  async () => {
    base = await createReactionRelayBase();
    const identities = await registerNativeActors(base, selectedActors + 1);
    await installReactionGrants(
      base.system.database.pool,
      identities.slice(0, selectedActors).map(({ accountId }) => accountId),
    );
    growth = await openGrowthDatabase(base.system.database.pool.options.connectionString!);
    author = await base.system.access.authenticate(base.author.bearer, {
      pool: growth.pool,
      deadline: Date.now() + 30_000,
    });
    governance = await base.system.access.authenticate(base.governance.bearer, {
      pool: growth.pool,
      deadline: Date.now() + 30_000,
    });
    actors = await Promise.all(
      identities.slice(0, selectedActors).map(async ({ bearer }) =>
        base!.system.access.authenticate(bearer, { pool: growth!.pool, deadline: Date.now() + 30_000 }),
      ),
    );
    if (author.kind !== 'account' || governance.kind !== 'account' || actors.some((actor) => actor.kind !== 'account'))
      throw new Error('Native Auth did not restore each selected reaction actor');
    deniedActor = await base.system.access.authenticate(identities.at(-1)!.bearer, {
      pool: growth.pool,
      deadline: Date.now() + 30_000,
    });
    const subjectRoute = requiredRoute(base.mainBoardId);
    runtime = await startRegisteredMergeRuntime({
      pool: growth.pool,
      databaseUrl: growth.url,
      routeKey: base.system.routeKey,
      executorId: `subject-reaction-merge-growth-${randomUUID()}`,
    });
    await primeEffectRelayAtCurrentHead(growth.pool);

    for (const scenario of ['terminal', 'checkpoint-replay'] as const)
      for (const axis of ['subjects', 'actors', 'history'] as const) await runCostSeries(scenario, axis, subjectRoute);
  },
  900_000,
);
