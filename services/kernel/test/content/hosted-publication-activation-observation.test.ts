import { afterAll, beforeAll, expect, setDefaultTimeout, spyOn, test } from 'bun:test';
import type { Pool } from 'pg';
import type { AccountActor } from '../../src/request/access.ts';
import * as activationEligibility from '../../src/content/hosted-publication-point-eligibility.ts';
import {
  advanceHostedPublicationActivationAuthority,
  HostedPublicationActivationConflictError,
  startHostedPublicationActivation,
  type HostedPublicationActivationDependencies,
} from '../../src/content/hosted-publication-activation.ts';
import { issueRevisionDisclosure } from '../../src/content/revision-disclosure.ts';
import type { HostedPlacement } from '../../src/content/hosted-chapters-model.ts';
import { routeOf } from '../../src/route/route.ts';
import { hostedChaptersFixture } from './support/hosted-chapters-fixture.ts';
import type { ContentCredential } from './support/system.ts';

setDefaultTimeout(360_000);

let f: Awaited<ReturnType<typeof hostedChaptersFixture>>;

beforeAll(async () => {
  f = await hostedChaptersFixture();
});

afterAll(async () => {
  await f?.close();
});

const commandContext = () => ({
  idempotencyKey: crypto.randomUUID(),
  deadline: Date.now() + 120_000,
  requestId: crypto.randomUUID(),
});

async function nativeRequest<T, Context extends { deadline: number }>(
  credential: ContentCredential,
  deps: HostedPublicationActivationDependencies,
  context: Context,
  operation: (actor: AccountActor, context: Context) => Promise<T>,
): Promise<T> {
  const actor = await f.native.system.access.authenticate(credential.bearer, {
    pool: deps.pool,
    deadline: context.deadline,
  });
  return operation(actor, context);
}

function dependencies(pool: Pool) {
  return {
    pool,
    access: f.native.system.access,
    tokens: f.native.system.tokenKeys,
    routeKey: f.native.system.routeKey,
    clock: () => new Date(),
  } satisfies HostedPublicationActivationDependencies;
}

function startActivation(deps: HostedPublicationActivationDependencies, catalogueId: string, stageId: string) {
  const context = commandContext();
  return nativeRequest(f.native.author, deps, context, (actor, request) =>
    startHostedPublicationActivation(deps, actor, catalogueId, stageId, request),
  );
}

function advanceActivation(
  deps: HostedPublicationActivationDependencies,
  catalogueId: string,
  stageId: string,
  context = commandContext(),
) {
  return nativeRequest(f.native.author, deps, context, (actor, request) =>
    advanceHostedPublicationActivationAuthority(deps, actor, catalogueId, stageId, request),
  );
}

async function prepareCandidate(
  catalogueId: string,
  path: string,
  expectedRevisionId: string,
  expectedPublicationId: string,
) {
  const stageId = f.newOccurrenceIdFor(catalogueId);
  const stagePath = `${path}/publicationPreparations/${stageId}`;
  const started = await f.native.call('POST', `${path}:prepareRelease`, {
    stageId,
    expectedRevisionId,
    expectedPublicationId,
    mode: 'whole',
  });
  expect(started.status).toBe(202);
  let progress = started.value;
  let pages = 0;
  while (!progress.candidate?.coverageComplete) {
    if (++pages > 16) throw new Error('The bounded candidate fixture did not complete');
    const advanced = await f.native.call('POST', `${stagePath}:advance`, {
      stepId: f.newOccurrenceIdFor(catalogueId),
    });
    expect(advanced.status).toBe(200);
    progress = advanced.value;
  }
  const sealed = await f.native.call('POST', `${stagePath}:seal`, {});
  expect(sealed.status).toBe(200);
  expect(sealed.value.candidateReady).toBe(true);
  return stageId;
}

test('target observations run outside command checkout and stale pages cannot advance twice', async () => {
  const catalogue = await f.native.thread('published');
  const catalogueId = catalogue.firstPost.id;
  const path = `/v1/hostedCatalogues/${catalogueId}`;
  const openingSource = await f.native.thread('published');
  const openingOccurrence = f.newOccurrenceIdFor(catalogueId);
  const initial = await f.native.command('/v1/hostedCatalogues', {
    postId: catalogueId,
    threadId: catalogue.id,
    placements: [
      {
        occurrenceId: openingOccurrence,
        parentId: null,
        position: 0,
        title: 'Selected release',
        kind: 'chapter',
        target: f.target(openingSource),
      },
    ] satisfies HostedPlacement[],
  });
  const release = await f.native.command(
    `${path}:publish`,
    { expectedRevisionId: initial.revisionId, expectedPublicationId: null, occurrenceIds: [openingOccurrence] },
    200,
  );

  const sources: Awaited<ReturnType<typeof f.native.thread>>[] = [];
  for (let index = 0; index < 21; index += 1) sources.push(await f.native.thread('draft'));
  const targets = sources.map((source) => f.target(source));
  const ranked = targets.sort((left, right) => {
    if (left.threadId < right.threadId) return -1;
    if (left.threadId > right.threadId) return 1;
    return 0;
  });
  const placements = ranked.map((target, index) => ({
    occurrenceId: f.newOccurrenceIdFor(catalogueId),
    parentId: null,
    position: index,
    title: `Chapter ${index + 1}`,
    kind: 'chapter' as const,
    target,
  }));
  const revised = await f.native.command(`${path}:revise`, { expectedRevisionId: initial.revisionId, placements }, 200);
  const deps = dependencies(f.native.pool);
  for (const target of ranked) {
    const context = commandContext();
    await nativeRequest(f.native.author, deps, context, (actor, request) =>
      issueRevisionDisclosure(deps, actor, { catalogueId, target }, request),
    );
  }
  const stageId = await prepareCandidate(catalogueId, path, revised.revisionId, release.revisionId);
  await startActivation(deps, catalogueId, stageId);

  const pageEndTarget = ranked[18]!;
  const observe = activationEligibility.observeHostedPublicationActivationTarget;
  let arrivals = 0;
  let bothPrepared!: () => void;
  let releaseObservers!: () => void;
  const bothAtPageEnd = new Promise<void>((resolve) => {
    bothPrepared = resolve;
  });
  const held = new Promise<void>((resolve) => {
    releaseObservers = resolve;
  });
  const observer = spyOn(activationEligibility, 'observeHostedPublicationActivationTarget').mockImplementation(
    async (...args) => {
      const result = await observe(...args);
      if (args[1].target.postId === pageEndTarget.postId && result) {
        arrivals += 1;
        if (arrivals === 2) bothPrepared();
        await held;
      }
      return result;
    },
  );

  const first = advanceActivation(deps, catalogueId, stageId);
  const second = advanceActivation(deps, catalogueId, stageId);
  const settled = Promise.allSettled([first, second]);
  try {
    const boundary = await Promise.race([
      bothAtPageEnd.then(() => 'observed' as const),
      settled.then(() => 'settled' as const),
    ]);
    expect(boundary).toBe('observed');
  } finally {
    releaseObservers();
    observer.mockRestore();
  }

  const results = await settled;
  const accepted = results.filter((result) => result.status === 'fulfilled');
  const rejected = results.filter((result) => result.status === 'rejected');
  expect(accepted).toHaveLength(1);
  expect(rejected).toHaveLength(1);
  const success = accepted[0];
  const failure = rejected[0];
  if (success?.status !== 'fulfilled' || failure?.status !== 'rejected') throw new Error('Expected one stale advance');
  expect(success.value.value).toMatchObject({ state: 'checking', checkedTargetCount: '20', totalTargetCount: '22' });
  expect(failure.reason).toBeInstanceOf(HostedPublicationActivationConflictError);

  const retained = await f.native.pool.query<{
    state: string;
    target_checked_count: string;
    target_total_count: string;
  }>(
    `SELECT state,target_checked_count::text,target_total_count::text
     FROM content.hosted_publication_activation WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3`,
    [routeOf(catalogueId), catalogueId, stageId],
  );
  expect(retained.rows[0]).toEqual({ state: 'checking', target_checked_count: '20', target_total_count: '22' });
});
