import { afterAll, beforeAll, expect, setDefaultTimeout, spyOn, test } from 'bun:test';
import { Pool, type PoolClient } from 'pg';
import type { AccessClient } from '../../src/request/access.ts';
import * as reads from '../../src/content/reads.ts';
import readChain from '../../src/content/read-chain.sql';
import {
  activateHostedPublicationCandidate,
  advanceHostedPublicationActivationAuthority,
  startHostedPublicationActivation,
  type HostedPublicationActivationDependencies,
} from '../../src/content/hosted-publication-activation.ts';
import { RevisionPreconditionError } from '../../src/content/commands.ts';
import {
  capturePublicationAuthorityVector,
  lockAndComparePublicationAuthorityHomes,
} from '../../src/database/publication-authority.ts';
import { issueRevisionDisclosure, revokeRevisionDisclosure } from '../../src/content/revision-disclosure.ts';
import type { HostedChapterTarget, HostedPlacement } from '../../src/content/hosted-chapters-model.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
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
