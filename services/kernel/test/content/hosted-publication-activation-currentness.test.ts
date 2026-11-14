import { afterAll, beforeAll, expect, setDefaultTimeout, spyOn, test } from 'bun:test';
import { Pool, type PoolClient } from 'pg';
import type { AccessClient } from '../../src/request/access.ts';
import * as reads from '../../src/content/reads.ts';
import readChain from '../../src/content/read-chain.sql';
import { createAppeal, resolveAppeal } from '../../src/content/appeals.ts';
import {
  activateHostedPublicationCandidate,
  advanceHostedPublicationActivationAuthority,
  HostedPublicationActivationNotFoundError,
  startHostedPublicationActivation,
  type HostedPublicationActivationDependencies,
} from '../../src/content/hosted-publication-activation.ts';
import { cancelHostedPublicationStaging } from '../../src/content/hosted-publication-staging.ts';
import { observeHostedPublicationActivationTarget } from '../../src/content/hosted-publication-point-eligibility.ts';
import { RevisionPreconditionError } from '../../src/content/commands.ts';
import { restrictPostRevision } from '../../src/content/moderation.ts';
import {
  capturePublicationAuthorityVector,
  lockAndComparePublicationAuthorityHomes,
} from '../../src/database/publication-authority.ts';
import { issueRevisionDisclosure, revokeRevisionDisclosure } from '../../src/content/revision-disclosure.ts';
import type { HostedChapterTarget, HostedPlacement } from '../../src/content/hosted-chapters-model.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { seedGovernanceAuthority } from './support/disclosure-fixtures.ts';
import { hostedChaptersFixture } from './support/hosted-chapters-fixture.ts';
import { observeSql } from './support/sql-observer.ts';

setDefaultTimeout(360_000);

let f: Awaited<ReturnType<typeof hostedChaptersFixture>>;
let secondPool: Pool;

beforeAll(async () => {
  f = await hostedChaptersFixture();
  const connectionString = (
    f.native.system.database.pool as unknown as {
      options: { connectionString?: string };
    }
  ).options.connectionString;
  if (!connectionString) throw new Error('The native fixture pool has no isolated connection string');
  secondPool = new Pool({ connectionString });
});

afterAll(async () => {
  await secondPool?.end();
  await f?.close();
});

const commandContext = (idempotencyKey = crypto.randomUUID()) => ({
  idempotencyKey,
  deadline: Date.now() + 120_000,
  requestId: crypto.randomUUID(),
});

function dependencies(pool: Pool, disclosureBarrier?: HostedPublicationActivationDependencies['disclosureBarrier']) {
  return {
    pool,
    access: f.native.system.access,
    tokens: f.native.system.tokenKeys,
    routeKey: f.native.system.routeKey,
    clock: () => new Date(),
    ...(disclosureBarrier ? { disclosureBarrier } : {}),
  } satisfies HostedPublicationActivationDependencies;
}

async function preparedCandidate(
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
    const advanced = await f.native.call('POST', `${stagePath}:advance`, { stepId: f.newOccurrenceIdFor(catalogueId) });
    expect(advanced.status).toBe(200);
    progress = advanced.value;
  }
  const sealed = await f.native.call('POST', `${stagePath}:seal`, {});
  expect(sealed.status).toBe(200);
  expect(sealed.value.candidateReady).toBe(true);
  return { stageId, candidate: sealed.value.candidate };
}

async function publicationId(catalogueId: string): Promise<string | null> {
  const route = routeOf(catalogueId);
  const result = await f.native.pool.query<{ publication_id: string | null }>(
    `SELECT publication_id FROM content.hosted_catalogue WHERE route=$1 AND catalogue_id=$2`,
    [route, catalogueId],
  );
  return result.rows[0]?.publication_id ?? null;
}

async function changeTargetVisibility(target: HostedChapterTarget, visibility: 'draft' | 'published' | 'taken_down') {
  await secondPool.query(
    `UPDATE content.post SET visibility=$3,security_revision=security_revision+1
     WHERE route=$1 AND thread_id=$2 AND post_id=$4`,
    [routeOf(target.threadId), target.threadId, visibility, target.postId],
  );
}

async function changeBoardVisibility(boardId: string, visibility: 'published' | 'protected') {
  await secondPool.query(
    `UPDATE content.board SET visibility=$3,security_revision=security_revision+1
     WHERE route=$1 AND board_id=$2`,
    [routeOf(boardId), boardId, visibility],
  );
}

async function expectAuthorityBump(home: number, mutate: (client: PoolClient) => Promise<void>) {
  const client = await secondPool.connect();
  try {
    await client.query('BEGIN');
    const before = await client.query<{ epoch: string }>(
      `SELECT epoch::text FROM core.publication_authority_epoch WHERE home_no=$1`,
      [home],
    );
    await mutate(client);
    const after = await client.query<{ epoch: string }>(
      `SELECT epoch::text FROM core.publication_authority_epoch WHERE home_no=$1`,
      [home],
    );
    expect(BigInt(after.rows[0]!.epoch)).toBeGreaterThan(BigInt(before.rows[0]!.epoch));
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

async function publicationAuthorityEpoch(home: number): Promise<bigint> {
  const result = await secondPool.query<{ epoch: string }>(
    `SELECT epoch::text FROM core.publication_authority_epoch WHERE home_no=$1`,
    [home],
  );
  const epoch = result.rows[0]?.epoch;
  if (epoch === undefined) throw new Error(`Publication authority home ${home} is missing`);
  return BigInt(epoch);
}

async function postSecurityRevision(target: HostedChapterTarget): Promise<bigint> {
  const result = await secondPool.query<{ security_revision: string }>(
    `SELECT security_revision::text FROM content.post WHERE route=$1 AND post_id=$2`,
    [routeOf(target.postId), target.postId],
  );
  const revision = result.rows[0]?.security_revision;
  if (revision === undefined) throw new Error(`Post ${target.postId} is missing`);
  return BigInt(revision);
}

async function activeRevisionRestrictionCount(target: HostedChapterTarget): Promise<number> {
  const result = await secondPool.query<{ count: number }>(
    `SELECT count(*)::integer AS count FROM content.post_revision_restriction
     WHERE route=$1 AND revision_id=$2 AND lifted_at IS NULL`,
    [routeOf(target.postId), target.revisionId],
  );
  return result.rows[0]!.count;
}

async function restrictRevision(target: HostedChapterTarget, mode: 'public' | 'hard', context = commandContext()) {
  return restrictPostRevision(
    dependencies(f.native.pool),
    f.native.system.actors.moderator.actor,
    { postId: target.postId, revisionId: target.revisionId, mode, reason: `Hosted activation ${mode} restriction` },
    context,
  );
}

async function reverseLatestRevisionRestriction(target: HostedChapterTarget) {
  const decision = (
    await secondPool.query<{ decision_id: string }>(
      `SELECT decision_id FROM content.moderation_decision
       WHERE route=$1 AND target_kind='post' AND target_id=$2 AND revision_id=$3
       ORDER BY security_revision DESC LIMIT 1`,
      [routeOf(target.postId), target.postId, target.revisionId],
    )
  ).rows[0];
  if (!decision) throw new Error(`Post ${target.postId} has no exact restriction decision`);
  const appeal = await createAppeal(
    dependencies(f.native.pool),
    f.native.system.actors.author.actor,
    decision.decision_id,
    'Please restore this exact revision',
    commandContext(),
  );
  return resolveAppeal(
    dependencies(f.native.pool),
    f.native.system.actors.other.actor,
    appeal.value.id,
    { outcome: 'reverse', statement: 'The exact revision is restored after review' },
    commandContext(),
  );
}

test('21-target authority restarts after cross-home consent revoke and activates the preserved candidate', async () => {
  const catalogue = await f.native.thread('published');
  const catalogueId = catalogue.firstPost.id;
  const path = `/v1/hostedCatalogues/${catalogueId}`;
  const oldPublicSource = await f.native.thread('published');
  const oldPublicTarget = f.target(oldPublicSource);
  const sources = await Promise.all(Array.from({ length: 21 }, () => f.native.thread('draft')));
  const targets = sources.map((source) => f.target(source));
  const ranked = targets
    .map((target, index) => ({ target, index }))
    .sort((left, right) => left.target.threadId.localeCompare(right.target.threadId));
  const catalogueHome = partitionOf(routeOf(catalogueId)!);
  const victim = ranked
    .slice(0, 19)
    .find(({ target }) => partitionOf(routeOf(target.threadId)!) !== catalogueHome)?.target;
  if (!victim) throw new Error('The first authority page has no cross-home source');
  expect(partitionOf(routeOf(victim.threadId)!)).not.toBe(catalogueHome);
  const victimOccurrence = f.newOccurrenceIdFor(catalogueId);
  const initial = await f.native.command('/v1/hostedCatalogues', {
    postId: catalogueId,
    threadId: catalogue.id,
    placements: [
      {
        occurrenceId: victimOccurrence,
        parentId: null,
        position: 0,
        title: 'A stays selected',
        kind: 'chapter',
        target: oldPublicTarget,
      },
    ] satisfies HostedPlacement[],
  });
  const releaseA = await f.native.command(
    `${path}:publish`,
    {
      expectedRevisionId: initial.revisionId,
      expectedPublicationId: null,
      occurrenceIds: [victimOccurrence],
    },
    200,
  );
  const occurrences = targets.map((target, index) => ({
    occurrenceId: f.newOccurrenceIdFor(catalogueId),
    parentId: null,
    position: index,
    title: `Chapter ${index + 1}`,
    kind: 'chapter' as const,
    target,
  }));
  const revised = await f.native.command(
    `${path}:revise`,
    {
      expectedRevisionId: initial.revisionId,
      placements: occurrences,
    },
    200,
  );
  const activationDeps = dependencies(f.native.pool);
  const consentByTarget = new Map<string, string>();
  for (const target of targets) {
    const consent = await issueRevisionDisclosure(
      activationDeps,
      f.native.author.actor,
      { catalogueId, target },
      commandContext(),
    );
    consentByTarget.set(
      `${target.threadId}/${target.postId}/${target.revisionId}/${target.sha256}`,
      consent.value.disclosureId,
    );
  }
  let victimDisclosureId = consentByTarget.get(
    `${victim.threadId}/${victim.postId}/${victim.revisionId}/${victim.sha256}`,
  );
  if (!victimDisclosureId) throw new Error('The first authority page has no issued source consent');
  const candidate = await preparedCandidate(catalogueId, path, revised.revisionId, releaseA.revisionId);
  const started = await startHostedPublicationActivation(
    activationDeps,
    f.native.author.actor,
    catalogueId,
    candidate.stageId,
    commandContext(),
  );
  const originalGenerationId = started.value.candidateGenerationId;

  const nativeRead = reads.readBookScopedPostMetadata;
  let invalidated = false;
  const metadataSpy = spyOn(reads, 'readBookScopedPostMetadata').mockImplementation(async (...args) => {
    const result = await nativeRead(...args);
    if (args[2].postId === victim.postId && !invalidated) {
      invalidated = true;
      await revokeRevisionDisclosure(
        dependencies(secondPool),
        f.native.author.actor,
        { disclosureId: victimDisclosureId! },
        commandContext(),
      );
    }
    return result;
  });
  try {
    const firstPage = await advanceHostedPublicationActivationAuthority(
      dependencies(f.native.pool),
      f.native.author.actor,
      catalogueId,
      candidate.stageId,
      commandContext(),
    );
    expect(firstPage.value).toMatchObject({ state: 'checking', checkedTargetCount: '20', totalTargetCount: '22' });
  } finally {
    metadataSpy.mockRestore();
  }
  expect(invalidated).toBe(true);

  const staleFinal = await activateHostedPublicationCandidate(
    activationDeps,
    f.native.author.actor,
    catalogueId,
    candidate.stageId,
    commandContext(),
  );
  expect(staleFinal.value).toMatchObject({ state: 'restart', restartRequired: true });
  expect(staleFinal.value.candidateGenerationId).toBe(originalGenerationId);
  expect(await publicationId(catalogueId)).toBe(releaseA.revisionId);

  const renewedConsent = await issueRevisionDisclosure(
    activationDeps,
    f.native.author.actor,
    { catalogueId, target: victim },
    commandContext(),
  );
  victimDisclosureId = renewedConsent.value.disclosureId;
  let current = await advanceHostedPublicationActivationAuthority(
    activationDeps,
    f.native.author.actor,
    catalogueId,
    candidate.stageId,
    commandContext(),
  );
  expect(current.value).toMatchObject({ state: 'checking', checkedTargetCount: '20', totalTargetCount: '22' });
  const resumedPageContext = commandContext();
  current = await advanceHostedPublicationActivationAuthority(
    activationDeps,
    f.native.author.actor,
    catalogueId,
    candidate.stageId,
    resumedPageContext,
  );
  const resumedPageReplay = await advanceHostedPublicationActivationAuthority(
    activationDeps,
    f.native.author.actor,
    catalogueId,
    candidate.stageId,
    resumedPageContext,
  );
  expect(resumedPageReplay.value).toEqual(current.value);
  expect(current.value).toMatchObject({ state: 'ready', checkedTargetCount: '22', totalTargetCount: '22' });
  expect(current.value.candidateGenerationId).toBe(originalGenerationId);
  expect(current.value.checkedTargetCount).toBe('22');

  await changeBoardVisibility(f.native.board.id, 'protected');
  const staleContainer = await activateHostedPublicationCandidate(
    activationDeps,
    f.native.author.actor,
    catalogueId,
    candidate.stageId,
    commandContext(),
  );
  expect(staleContainer.value).toMatchObject({ state: 'restart', restartRequired: true });
  expect(staleContainer.value.candidateGenerationId).toBe(originalGenerationId);
  expect(await publicationId(catalogueId)).toBe(releaseA.revisionId);
  await changeBoardVisibility(f.native.board.id, 'published');
  current = await advanceHostedPublicationActivationAuthority(
    activationDeps,
    f.native.author.actor,
    catalogueId,
    candidate.stageId,
    commandContext(),
  );
  expect(current.value).toMatchObject({ state: 'checking', checkedTargetCount: '20', totalTargetCount: '22' });
  current = await advanceHostedPublicationActivationAuthority(
    activationDeps,
    f.native.author.actor,
    catalogueId,
    candidate.stageId,
    commandContext(),
  );
  expect(current.value).toMatchObject({ state: 'ready', checkedTargetCount: '22', totalTargetCount: '22' });
  expect(current.value.candidateGenerationId).toBe(originalGenerationId);

  const observer = observeSql(f.native.pool);
  const activationContext = commandContext();
  let activated: Awaited<ReturnType<typeof activateHostedPublicationCandidate>>;
  try {
    activated = await activateHostedPublicationCandidate(
      activationDeps,
      f.native.author.actor,
      catalogueId,
      candidate.stageId,
      activationContext,
    );
  } finally {
    await observer.close();
  }
  expect(activated.value).toMatchObject({ state: 'activated', restartRequired: false });
  expect(await publicationId(catalogueId)).toBe(activated.value.publicationId);
  const targetIds = new Set(targets.map((target) => target.postId));
  expect(
    observer.records.filter((record) => record.parameters.some((parameter) => targetIds.has(String(parameter)))),
  ).toHaveLength(0);

  const casDraft = await f.native.command(
    `${path}:revise`,
    {
      expectedRevisionId: revised.revisionId,
      placements: [{ ...occurrences[0]!, title: 'CAS candidate' }],
    },
    200,
  );
  const casCandidate = await preparedCandidate(catalogueId, path, casDraft.revisionId, activated.value.publicationId!);
  await startHostedPublicationActivation(
    activationDeps,
    f.native.author.actor,
    catalogueId,
    casCandidate.stageId,
    commandContext(),
  );
  let casProgress = await advanceHostedPublicationActivationAuthority(
    activationDeps,
    f.native.author.actor,
    catalogueId,
    casCandidate.stageId,
    commandContext(),
  );
  expect(casProgress.value.state).toBe('ready');
  await f.native.command(
    `${path}:revise`,
    {
      expectedRevisionId: casDraft.revisionId,
      placements: [{ ...occurrences[0]!, title: 'Competing edit' }],
    },
    200,
  );
  await expect(
    activateHostedPublicationCandidate(
      activationDeps,
      f.native.author.actor,
      catalogueId,
      casCandidate.stageId,
      commandContext(),
    ),
  ).rejects.toBeInstanceOf(RevisionPreconditionError);
  expect(await publicationId(catalogueId)).toBe(activated.value.publicationId);
  expect(
    observer.records.filter(
      (record) =>
        record.statement === readChain.sql && record.parameters[readChain.params.indexOf('include_body')] === true,
    ),
  ).toHaveLength(0);

  await revokeRevisionDisclosure(
    dependencies(secondPool),
    f.native.author.actor,
    { disclosureId: victimDisclosureId },
    commandContext(),
  );
  const replayed = await activateHostedPublicationCandidate(
    activationDeps,
    f.native.author.actor,
    catalogueId,
    candidate.stageId,
    activationContext,
  );
  expect(replayed.value).toEqual(activated.value);
  const reader = await f.native.call(
    'GET',
    `/v1/hostedCatalogues/${catalogueId}/occurrences/${victimOccurrence}?kind=publication&revisionId=${activated.value.publicationId}`,
    undefined,
    { anonymous: true },
  );
  expect(reader.status).toBe(200);
  expect(reader.value.occurrence.availability).toBe('unavailable');
  expect(reader.value.document).toBeNull();

  const restoredConsent = await issueRevisionDisclosure(
    activationDeps,
    f.native.author.actor,
    { catalogueId, target: victim },
    commandContext(),
  );
  expect(restoredConsent.value.state).toBe('issued');
  await changeTargetVisibility(victim, 'taken_down');
  const afterTakedown = await f.native.call(
    'GET',
    `/v1/hostedCatalogues/${catalogueId}/occurrences/${victimOccurrence}?kind=publication&revisionId=${activated.value.publicationId}`,
    undefined,
    { anonymous: true },
  );
  expect(afterTakedown.status).toBe(200);
  expect(afterTakedown.value.occurrence.availability).toBe('unavailable');
  expect(afterTakedown.value.document).toBeNull();
});

test('native revision restriction rollback, hard denial, and appealed lift preserve the sealed candidate', async () => {
  const catalogue = await f.native.thread('published');
  const catalogueId = catalogue.firstPost.id;
  const path = `/v1/hostedCatalogues/${catalogueId}`;
  const publicSource = await f.native.thread('published');
  const publicTarget = f.target(publicSource);
  const occurrenceId = f.newOccurrenceIdFor(catalogueId);
  const initial = await f.native.command('/v1/hostedCatalogues', {
    postId: catalogueId,
    threadId: catalogue.id,
    placements: [
      {
        occurrenceId,
        parentId: null,
        position: 0,
        title: 'A remains selected',
        kind: 'chapter',
        target: publicTarget,
      },
    ] satisfies HostedPlacement[],
  });
  const releaseA = await f.native.command(
    `${path}:publish`,
    { expectedRevisionId: initial.revisionId, expectedPublicationId: null, occurrenceIds: [occurrenceId] },
    200,
  );

  const privateSource = await f.native.thread('draft');
  const privateTarget = f.target(privateSource);
  const revised = await f.native.command(
    `${path}:revise`,
    {
      expectedRevisionId: initial.revisionId,
      placements: [
        {
          occurrenceId,
          parentId: null,
          position: 0,
          title: 'B waits for current authority',
          kind: 'chapter',
          target: privateTarget,
        },
      ] satisfies HostedPlacement[],
    },
    200,
  );
  const activationDeps = dependencies(f.native.pool);
  const consent = await issueRevisionDisclosure(
    activationDeps,
    f.native.author.actor,
    { catalogueId, target: privateTarget },
    commandContext(),
  );
  const candidate = await preparedCandidate(catalogueId, path, revised.revisionId, releaseA.revisionId);

  const moderator = f.native.system.actors.moderator.actor;
  const reviewer = f.native.system.actors.other.actor;
  for (const target of [publicTarget, privateTarget]) {
    for (const actor of [moderator, reviewer])
      await seedGovernanceAuthority(secondPool, routeOf(target.postId)!, target.postId, actor.accountId, [
        'moderation:takedown',
      ]);
  }

  const publicHome = partitionOf(routeOf(publicTarget.postId)!);
  const publicEpoch = await publicationAuthorityEpoch(publicHome);
  const publicSecurityRevision = await postSecurityRevision(publicTarget);
  const rollbackContext = commandContext();
  const suffix = crypto.randomUUID().replaceAll('-', '');
  const functionName = `hrrf_${suffix}`;
  const triggerName = `hrrt_${suffix}`;
  try {
    await secondPool.query(`CREATE FUNCTION public.${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.type='com.rezics.content.moderation.revision-restricted.v1' THEN
          RAISE EXCEPTION 'hosted restriction rollback fault';
        END IF;
        RETURN NEW;
      END $$`);
    await secondPool.query(
      `CREATE TRIGGER ${triggerName} BEFORE INSERT ON core.outbox
       FOR EACH ROW EXECUTE FUNCTION public.${functionName}()`,
    );
    await expect(restrictRevision(publicTarget, 'public', rollbackContext)).rejects.toThrow(
      'hosted restriction rollback fault',
    );
  } finally {
    await secondPool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON core.outbox`);
    await secondPool.query(`DROP FUNCTION IF EXISTS public.${functionName}()`);
  }
  expect(await publicationAuthorityEpoch(publicHome)).toBe(publicEpoch);
  expect(await postSecurityRevision(publicTarget)).toBe(publicSecurityRevision);
  expect(await activeRevisionRestrictionCount(publicTarget)).toBe(0);

  await restrictRevision(publicTarget, 'public', rollbackContext);
  const publicRestrictedEpoch = await publicationAuthorityEpoch(publicHome);
  expect(publicRestrictedEpoch).toBeGreaterThan(publicEpoch);
  const publicReadContext = { actor: { kind: 'anonymous' as const }, deadline: Date.now() + 120_000 };
  const authorReadContext = { actor: f.native.author.actor, deadline: Date.now() + 120_000 };
  expect(
    (
      await reads.readPost(
        activationDeps,
        publicTarget.threadId,
        publicTarget.postId,
        publicReadContext,
        publicTarget.revisionId,
      )
    ).value,
  ).toBeNull();
  expect(
    (
      await reads.readPost(
        activationDeps,
        publicTarget.threadId,
        publicTarget.postId,
        authorReadContext,
        publicTarget.revisionId,
      )
    ).value,
  ).not.toBeNull();
  await reverseLatestRevisionRestriction(publicTarget);
  expect(await publicationAuthorityEpoch(publicHome)).toBeGreaterThan(publicRestrictedEpoch);
  expect(await publicationId(catalogueId)).toBe(releaseA.revisionId);

  const started = await startHostedPublicationActivation(
    activationDeps,
    f.native.author.actor,
    catalogueId,
    candidate.stageId,
    commandContext(),
  );
  const candidateGenerationId = started.value.candidateGenerationId;
  const checked = await advanceHostedPublicationActivationAuthority(
    activationDeps,
    f.native.author.actor,
    catalogueId,
    candidate.stageId,
    commandContext(),
  );
  expect(checked.value).toMatchObject({ state: 'ready', checkedTargetCount: '2', totalTargetCount: '2' });

  const privateHome = partitionOf(routeOf(privateTarget.postId)!);
  const beforeHardRestriction = await publicationAuthorityEpoch(privateHome);
  await restrictRevision(privateTarget, 'hard');
  const hardRestrictedEpoch = await publicationAuthorityEpoch(privateHome);
  expect(hardRestrictedEpoch).toBeGreaterThan(beforeHardRestriction);
  expect(
    (
      await reads.readPost(
        activationDeps,
        privateTarget.threadId,
        privateTarget.postId,
        authorReadContext,
        privateTarget.revisionId,
      )
    ).value,
  ).toBeNull();

  const storedActivation = await secondPool.query<{ activation_revision_id: string }>(
    `SELECT activation_revision_id FROM content.hosted_publication_activation
     WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3`,
    [routeOf(catalogueId), catalogueId, candidate.stageId],
  );
  const activationRevisionId = storedActivation.rows[0]?.activation_revision_id;
  if (!activationRevisionId) throw new Error('The native activation revision was not retained');
  const hardConsentObservation = await observeHostedPublicationActivationTarget(
    activationDeps,
    { catalogueId, activationRevisionId, target: privateTarget, occurrenceId },
    { actor: { kind: 'anonymous' }, deadline: Date.now() + 120_000 },
  );
  expect(hardConsentObservation).toBeNull();

  const stale = await activateHostedPublicationCandidate(
    activationDeps,
    f.native.author.actor,
    catalogueId,
    candidate.stageId,
    commandContext(),
  );
  expect(stale.value).toMatchObject({ state: 'restart', restartRequired: true });
  expect(stale.value.candidateGenerationId).toBe(candidateGenerationId);
  expect(await publicationId(catalogueId)).toBe(releaseA.revisionId);

  const beforeReversal = await publicationAuthorityEpoch(privateHome);
  await reverseLatestRevisionRestriction(privateTarget);
  const reversedEpoch = await publicationAuthorityEpoch(privateHome);
  expect(reversedEpoch).toBeGreaterThan(beforeReversal);
  const resumed = await advanceHostedPublicationActivationAuthority(
    activationDeps,
    f.native.author.actor,
    catalogueId,
    candidate.stageId,
    commandContext(),
  );
  expect(resumed.value).toMatchObject({ state: 'ready', checkedTargetCount: '2', totalTargetCount: '2' });
  expect(resumed.value.candidateGenerationId).toBe(candidateGenerationId);

  const activated = await activateHostedPublicationCandidate(
    activationDeps,
    f.native.author.actor,
    catalogueId,
    candidate.stageId,
    commandContext(),
  );
  expect(activated.value).toMatchObject({ state: 'activated', restartRequired: false });
  if (!activated.value.publicationId) throw new Error('The activated Book has no publication ID');
  expect(await publicationId(catalogueId)).toBe(activated.value.publicationId);
  const readerPath = `${path}/occurrences/${occurrenceId}?kind=publication&revisionId=${activated.value.publicationId}`;
  const available = await f.native.call('GET', readerPath, undefined, { anonymous: true });
  expect(available.status).toBe(200);
  expect(available.value.occurrence.availability).toBe('available');
  expect(available.value.document).not.toBeNull();

  await restrictRevision(privateTarget, 'hard');
  const withheld = await f.native.call('GET', readerPath, undefined, { anonymous: true });
  expect(withheld.status).toBe(200);
  expect(withheld.value.occurrence.availability).toBe('unavailable');
  expect(withheld.value.document).toBeNull();
  expect(consent.value.state).toBe('issued');
});

test.each([true, false])(
  'cancellation and activation serialize on the stage (cancel first: %s)',
  async (cancelFirst) => {
    const catalogue = await f.native.thread('published');
    const catalogueId = catalogue.firstPost.id;
    const path = `/v1/hostedCatalogues/${catalogueId}`;
    const placement: HostedPlacement = {
      occurrenceId: f.newOccurrenceIdFor(catalogueId),
      parentId: null,
      position: 0,
      title: 'Original edition',
      kind: 'chapter',
      target: f.target(await f.native.thread('published')),
    };
    const initial = await f.native.command('/v1/hostedCatalogues', {
      postId: catalogueId,
      threadId: catalogue.id,
      placements: [placement],
    });
    const releaseA = await f.native.command(
      `${path}:publish`,
      {
        expectedRevisionId: initial.revisionId,
        expectedPublicationId: null,
        occurrenceIds: [placement.occurrenceId],
      },
      200,
    );
    const revised = await f.native.command(
      `${path}:revise`,
      {
        expectedRevisionId: initial.revisionId,
        placements: [{ ...placement, title: 'Prepared edition' }],
      },
      200,
    );
    const { stageId } = await preparedCandidate(catalogueId, path, revised.revisionId, releaseA.revisionId);
    const deps = dependencies(f.native.pool);
    const actor = f.native.author.actor;
    const locator = { catalogueId, stageId };
    const route = routeOf(catalogueId)!;
    const observer = observeSql(f.native.pool);
    const cancellingClient = await secondPool.connect();
    let activation: ReturnType<typeof activateHostedPublicationCandidate> | undefined;
    let cancellation: ReturnType<typeof cancelHostedPublicationStaging> | undefined;
    try {
      await startHostedPublicationActivation(deps, actor, catalogueId, stageId, commandContext());
      const ready = await advanceHostedPublicationActivationAuthority(
        deps,
        actor,
        catalogueId,
        stageId,
        commandContext(),
      );
      expect(ready.value.state).toBe('ready');
      // Discover the real statements from the same fixture, rather than duplicating
      // private SQL. Advancement uses the same candidate point read as activation.
      const stageSql = observer.records.find(
        ({ statement }) =>
          statement.includes('FROM content.hosted_publication_staging\n') && statement.endsWith('FOR UPDATE'),
      )!.statement;
      const candidateSql = observer.records.find(
        ({ statement }) =>
          statement.includes('FROM content.hosted_version_release_candidate candidate') &&
          !statement.includes('FOR UPDATE'),
      )!.statement;
      const boundary = observer.hold(
        { statement: cancelFirst ? stageSql : candidateSql },
        cancelFirst ? 'before' : 'after',
      );
      await cancellingClient.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      if (cancelFirst) {
        const cancelled = await cancelHostedPublicationStaging(cancellingClient as AccessClient, actor, locator);
        expect(cancelled.state).toBe('cancelled');
      }
      const context = commandContext();
      activation = activateHostedPublicationCandidate(deps, actor, catalogueId, stageId, context);
      // A cancellation may make the command reject while the test is coordinating it.
      void activation.catch(() => undefined);
      await Promise.race([
        boundary.entered,
        activation.then(() => {
          throw new Error('Activation bypassed its lifecycle boundary');
        }),
      ]);
      if (cancelFirst) {
        await cancellingClient.query('COMMIT');
        boundary.release();
        await expect(activation).rejects.toBeInstanceOf(HostedPublicationActivationNotFoundError);
        expect(await publicationId(catalogueId)).toBe(releaseA.revisionId);
        const retained = await secondPool.query<{ state: string; publication_id: string | null }>(
          `SELECT state,publication_id FROM content.hosted_publication_activation
         WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3`,
          [route, catalogueId, stageId],
        );
        expect(retained.rows[0]).toEqual({ state: 'ready', publication_id: null });
      } else {
        // The candidate has already been read, but the pointer has not moved. A
        // NOWAIT probe proves the stage is fenced without timing sleeps or polling.
        expect(await publicationId(catalogueId)).toBe(releaseA.revisionId);
        await cancellingClient.query('SAVEPOINT stage_probe');
        await expect(
          cancellingClient.query(
            `SELECT stage_id FROM content.hosted_publication_staging
         WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3 FOR UPDATE NOWAIT`,
            [route, catalogueId, stageId],
          ),
        ).rejects.toMatchObject({ code: '55P03' });
        await cancellingClient.query('ROLLBACK TO SAVEPOINT stage_probe');
        cancellation = cancelHostedPublicationStaging(cancellingClient as AccessClient, actor, locator);
        void cancellation.catch(() => undefined);
        boundary.release();
        const activated = await activation;
        expect(activated.value).toMatchObject({
          state: 'activated',
          candidateGenerationId: ready.value.candidateGenerationId,
        });
        expect((await cancellation).state).toBe('cancelled');
        await cancellingClient.query('COMMIT');
        expect(activated.value.publicationId).not.toBeNull();
        expect(await publicationId(catalogueId)).toBe(activated.value.publicationId);
        await secondPool.query(
          `UPDATE content.hosted_publication_staging SET expires_at='2000-01-01T00:00:00Z'
         WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3`,
          [route, catalogueId, stageId],
        );
        const replayed = await activateHostedPublicationCandidate(deps, actor, catalogueId, stageId, context);
        expect(replayed).toMatchObject({
          replayed: true,
          value: activated.value,
          transactionId: activated.transactionId,
          position: activated.position,
        });
        await expect(
          activateHostedPublicationCandidate(deps, actor, catalogueId, stageId, commandContext()),
        ).rejects.toBeInstanceOf(HostedPublicationActivationNotFoundError);
        expect(await publicationId(catalogueId)).toBe(activated.value.publicationId);
      }
    } finally {
      await observer.close();
      await cancellingClient.query('ROLLBACK');
      await Promise.allSettled([activation, cancellation]);
      cancellingClient.release();
    }
  },
);

test('dependency locking sorts reversed homes, releases on rollback, and permits an unrelated home writer', async () => {
  const vector = await capturePublicationAuthorityVector(f.native.system.database.pool as unknown as AccessClient);
  const expected = vector.slice(300, 303);
  const unrelated = vector.find((entry) => !expected.some((item) => item.home === entry.home))!;
  const client = await f.native.system.database.pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await lockAndComparePublicationAuthorityHomes(
      client as unknown as AccessClient,
      [...expected].reverse(),
    );
    expect(locked.matches).toBe(true);
    expect(locked.locked.map((entry) => entry.home)).toEqual(expected.map((entry) => entry.home));

    await secondPool.query(`UPDATE core.publication_authority_epoch SET epoch=epoch+1 WHERE home_no=$1`, [
      unrelated.home,
    ]);
    await client.query('ROLLBACK');
    const before = await secondPool.query<{ epoch: string }>(
      `SELECT epoch::text FROM core.publication_authority_epoch WHERE home_no=$1`,
      [expected[0]!.home],
    );
    await secondPool.query(`UPDATE core.publication_authority_epoch SET epoch=epoch+1 WHERE home_no=$1`, [
      expected[0]!.home,
    ]);
    const after = await secondPool.query<{ epoch: string }>(
      `SELECT epoch::text FROM core.publication_authority_epoch WHERE home_no=$1`,
      [expected[0]!.home],
    );
    expect(BigInt(after.rows[0]!.epoch)).toBe(BigInt(before.rows[0]!.epoch) + 1n);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
});

test('source, container, earliest erasure, and community lifecycle invalidators advance their home epochs', async () => {
  const source = f.target(await f.native.thread('draft'));
  const sourceHome = partitionOf(routeOf(source.threadId)!);
  await expectAuthorityBump(sourceHome, async (client) => {
    await client.query(
      `UPDATE content.post SET visibility='taken_down',security_revision=security_revision+1
       WHERE route=$1 AND thread_id=$2 AND post_id=$3`,
      [routeOf(source.threadId), source.threadId, source.postId],
    );
  });

  const boardHome = partitionOf(routeOf(f.native.board.id)!);
  await expectAuthorityBump(boardHome, async (client) => {
    await client.query(
      `UPDATE content.board SET security_revision=security_revision+1
       WHERE route=$1 AND board_id=$2`,
      [routeOf(f.native.board.id), f.native.board.id],
    );
  });

  const realmId = f.native.realm.realmId as string;
  const spaceId = f.native.realm.spaceId as string;
  const communityHome = partitionOf(routeOf(realmId)!);
  await expectAuthorityBump(communityHome, async (client) => {
    await client.query(
      `UPDATE community.realm SET state='removed',removed_at=transaction_timestamp(),removed_by=$3,
         remover_role='owner',removal_reason='Authority fixture',lifecycle_version=lifecycle_version+1
       WHERE route=$1 AND realm_id=$2`,
      [routeOf(realmId), realmId, f.native.author.actor.accountId],
    );
    await client.query(
      `UPDATE community.realm SET state='active',removed_at=NULL,removed_by=NULL,remover_role=NULL,
         removal_reason=NULL,lifecycle_version=lifecycle_version+1
       WHERE route=$1 AND realm_id=$2`,
      [routeOf(realmId), realmId],
    );
  });
  await expectAuthorityBump(communityHome, async (client) => {
    await client.query(
      `UPDATE community.space SET state='removed',removed_at=transaction_timestamp(),removed_by=$3,
         remover_role='owner',removal_reason='Authority fixture',lifecycle_version=lifecycle_version+1
       WHERE route=$1 AND space_id=$2`,
      [routeOf(spaceId), spaceId, f.native.author.actor.accountId],
    );
    await client.query(
      `UPDATE community.space SET state='active',removed_at=NULL,removed_by=NULL,remover_role=NULL,
         removal_reason=NULL,lifecycle_version=lifecycle_version+1
       WHERE route=$1 AND space_id=$2`,
      [routeOf(spaceId), spaceId],
    );
  });

  const accountId = f.native.author.actor.accountId;
  const route = routeOf(accountId)!;
  const home = partitionOf(route);
  await expectAuthorityBump(home, async (client) => {
    await client.query(
      `INSERT INTO access.erasure(route,account_id,version,at)
       VALUES ($1,$2,1,transaction_timestamp())`,
      [route, accountId],
    );
  });
  await expectAuthorityBump(home, async (client) => {
    await client.query(
      `INSERT INTO content.erasure_fence(route,account_id,closed_at)
       VALUES ($1,$2,transaction_timestamp())`,
      [route, accountId],
    );
  });
});
