import { afterAll, beforeAll, expect, test } from 'bun:test';
import { suspendAccount } from '../support/native-suspension-driver.ts';
import { assertGrowthAccessPaths, checkGrowth } from '../support/growth.ts';
import { withReactionCounts } from '../../src/content/reads.ts';
import {
  createSubjectReactionBoundaryFixture,
  openSubjectReactionBoundaryObservation,
  seedRetainedReactionReceipts,
  seedUnrelatedSubjectReactions,
  subjectReactionPaths,
  type SubjectReactionBoundaryFixture,
  type SubjectReactionBoundaryObservation,
} from './support/growth-subject-reaction-boundaries-fixture.ts';

const scales = [64, 512, 4096] as const;

let fixture: SubjectReactionBoundaryFixture | undefined;

beforeAll(async () => {
  fixture = await createSubjectReactionBoundaryFixture();
}, 120_000);

afterAll(async () => {
  await fixture?.close();
});

function requiredFixture(): SubjectReactionBoundaryFixture {
  if (!fixture) throw new Error('Subject reaction boundary fixture was not started');
  return fixture;
}

type GrowthAxis = 'unrelated subject reactions' | 'retained command receipts';

async function profile(
  name: string,
  axis: GrowthAxis,
  operation: (observation: SubjectReactionBoundaryObservation) => Promise<void>,
  relations: readonly string[] = [],
): Promise<void> {
  const base = requiredFixture();
  const observation = await openSubjectReactionBoundaryObservation(base);
  try {
    const report = await checkGrowth(observation.database, {
      name: `${name} with ${axis}`,
      scales,
      repetitions: 1,
      warmups: 1,
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      async grow(database, scale, previous) {
        if (axis === 'unrelated subject reactions')
          await seedUnrelatedSubjectReactions(database, base.targets.unrelatedActorRoute, previous, scale);
        else await seedRetainedReactionReceipts(database, base.targets.unrelatedActorRoute, previous, scale);
      },
      async operation() {
        await operation(observation);
      },
    });
    expect(report.samples.map(({ scale }) => scale)).toEqual(scales);
    const first = report.samples[0]!.cost;
    expect(report.samples.map(({ cost }) => cost.rows)).toEqual([first.rows, first.rows, first.rows]);
    expect(report.samples.map(({ cost }) => cost.statements)).toEqual([
      first.statements,
      first.statements,
      first.statements,
    ]);
    if (relations.length > 0) assertGrowthAccessPaths(report.name, report.samples, relations);
  } finally {
    await observation.close();
  }
}

async function ownEmptySlot(observation: SubjectReactionBoundaryObservation): Promise<void> {
  const base = requiredFixture();
  const result = await observation.call('GET', subjectReactionPaths.reactionPath(base.targets.ownSlot), {
    bearer: base.base.author.bearer,
  });
  expect(result.response.status).toBe(200);
  expect(result.value).toEqual({ kind: null });
  expect(result.value).not.toHaveProperty('counts');
}

async function zeroPublicCount(observation: SubjectReactionBoundaryObservation): Promise<void> {
  const result = await observation.call('GET', subjectReactionPaths.reactionsPath(requiredFixture().targets.zeroCount));
  expect(result.response.status).toBe(200);
  expect(result.value?.counts).toEqual([]);
  expect(result.value).not.toHaveProperty('viewer');
}

async function deniedPublicCount(observation: SubjectReactionBoundaryObservation): Promise<void> {
  const base = requiredFixture();
  const result = await observation.call('GET', subjectReactionPaths.reactionsPath(base.targets.deniedRead), {
    bearer: base.base.governance.bearer,
  });
  expect(result.response.status).toBe(404);
  expect(result.value).not.toHaveProperty('counts');
}

async function emptyInternalBatch(observation: SubjectReactionBoundaryObservation): Promise<void> {
  const result = await withReactionCounts(observation.readDependencies, [], Date.now() + 30_000);
  expect(result).toEqual({ items: [], reactionsAsOf: null });
}

test.serial('public counts and private own-slot controls follow the mounted subject routes', async () => {
  const base = requiredFixture();
  const observation = await openSubjectReactionBoundaryObservation(base);
  try {
    const publicCounts = await observation.call('GET', subjectReactionPaths.reactionsPath(base.targets.ownSlot));
    expect(publicCounts.response.status).toBe(200);
    expect(publicCounts.value?.counts).toEqual([{ kind: 'like', count: 1 }]);
    expect(publicCounts.value).not.toHaveProperty('viewer');

    const readerSlot = await observation.call('GET', subjectReactionPaths.reactionPath(base.targets.ownSlot), {
      bearer: base.base.author.bearer,
    });
    expect(readerSlot.response.status).toBe(200);
    expect(readerSlot.value).toEqual({ kind: null });

    const reactingActorSlot = await observation.call(
      'GET',
      subjectReactionPaths.reactionPath(base.targets.ownSlot),
      { bearer: base.base.other.bearer },
    );
    expect(reactingActorSlot.response.status).toBe(200);
    expect(reactingActorSlot.value).toEqual({ kind: 'like' });

    const anonymousOwnSlot = await observation.call('GET', subjectReactionPaths.reactionPath(base.targets.ownSlot));
    expect(anonymousOwnSlot.response.status).toBe(401);

    const zeroCount = await observation.call('GET', subjectReactionPaths.reactionsPath(base.targets.zeroCount));
    expect(zeroCount.response.status).toBe(200);
    expect(zeroCount.value?.counts).toEqual([]);
    expect(zeroCount.value).not.toHaveProperty('viewer');

    const allowedDeniedTarget = await observation.call(
      'GET',
      subjectReactionPaths.reactionsPath(base.targets.deniedRead),
    );
    expect(allowedDeniedTarget.response.status).toBe(200);
    expect(allowedDeniedTarget.value?.counts).toEqual([{ kind: 'like', count: 1 }]);
    expect(allowedDeniedTarget.value).not.toHaveProperty('viewer');
    await deniedPublicCount(observation);

    const nonemptyControl = await withReactionCounts(
      observation.readDependencies,
      [{ id: base.base.mainTarget.threadId }],
      Date.now() + 30_000,
    );
    expect(nonemptyControl.items).toHaveLength(1);
    expect(nonemptyControl.items[0]).toHaveProperty('reactions');
  } finally {
    await observation.close();
  }
}, 120_000);

test.serial('an empty own-slot HTTP result remains bounded across both independent growth axes', async () => {
  await profile('empty own-slot HTTP read', 'unrelated subject reactions', ownEmptySlot, [
    'content.reaction',
    'semantic.subject',
  ]);
  await profile('empty own-slot HTTP read', 'retained command receipts', ownEmptySlot, [
    'content.reaction',
    'semantic.subject',
  ]);
}, 600_000);

test.serial('a zero public count remains bounded across both independent growth axes', async () => {
  await profile('zero subject reaction count HTTP read', 'unrelated subject reactions', zeroPublicCount, [
    'content.reaction_total',
    'semantic.subject',
  ]);
  await profile('zero subject reaction count HTTP read', 'retained command receipts', zeroPublicCount, [
    'content.reaction_total',
    'semantic.subject',
  ]);
}, 600_000);

test.serial('an internal empty reaction-count batch performs zero native work at all scales', async () => {
  const assertNoWork = async (observation: SubjectReactionBoundaryObservation) => {
    await emptyInternalBatch(observation);
  };
  for (const axis of ['unrelated subject reactions', 'retained command receipts'] as const) {
    const base = requiredFixture();
    const observation = await openSubjectReactionBoundaryObservation(base);
    try {
      const report = await checkGrowth(observation.database, {
        name: `internal empty reaction-count batch with ${axis}`,
        scales,
        repetitions: 1,
        warmups: 1,
        bounds: { rows: 'constant', blocks: 'constant', statements: 'constant' },
        async grow(database, scale, previous) {
          if (axis === 'unrelated subject reactions')
            await seedUnrelatedSubjectReactions(database, base.targets.unrelatedActorRoute, previous, scale);
          else await seedRetainedReactionReceipts(database, base.targets.unrelatedActorRoute, previous, scale);
        },
        async operation() {
          await assertNoWork(observation);
        },
      });
      expect(report.samples.map(({ scale }) => scale)).toEqual(scales);
      expect(report.samples.map(({ cost }) => [cost.rows, cost.blocks, cost.statements])).toEqual([
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
      ]);
    } finally {
      await observation.close();
    }
  }
}, 600_000);

test.serial('a real Access-denied subject count request is captured at all scales', async () => {
  await profile('Access-denied subject reaction count HTTP read', 'unrelated subject reactions', deniedPublicCount, [
    'access.resource_denial',
    'semantic.subject',
  ]);
  await profile('Access-denied subject reaction count HTTP read', 'retained command receipts', deniedPublicCount, [
    'access.resource_denial',
    'semantic.subject',
  ]);
}, 600_000);

test.serial('a current suspension still rejects the existing own-slot bearer', async () => {
  const base = requiredFixture();
  await suspendAccount(base.base.system.database.admin, base.base.governance.accountId);
  const result = await base.base.call('GET', subjectReactionPaths.reactionPath(base.targets.ownSlot), {
    bearer: base.base.governance.bearer,
  });
  expect(result.response.status).toBe(401);
  expect(result.value).not.toHaveProperty('kind');
}, 120_000);
