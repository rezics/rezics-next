import { expect, setDefaultTimeout, test } from 'bun:test';
import {
  activateHostedPublicationCandidate as activate,
  advanceHostedPublicationActivationAuthority as advance,
  HostedPublicationActivationConflictError,
  HostedPublicationActivationNotFoundError,
  startHostedPublicationActivation as start,
  type HostedPublicationActivationDependencies,
} from '../../src/content/hosted-publication-activation.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { hostedChaptersFixture } from './support/hosted-chapters-fixture.ts';

setDefaultTimeout(360_000);
const activationProgressEvent = 'com.rezics.content.hosted-catalogue.activation.changed.v1';
const activationEvent = 'com.rezics.content.hosted-catalogue.publication.activated.v1';
const activationEventTypes = [activationProgressEvent, activationEvent];
const context = () => ({
  idempotencyKey: crypto.randomUUID(),
  deadline: Date.now() + 120_000,
  requestId: crypto.randomUUID(),
});

async function activationEventCounts(
  f: Awaited<ReturnType<typeof hostedChaptersFixture>>,
  catalogueId: string,
) {
  const result = await f.native.pool.query<{ type: string; count: number }>(
    `SELECT type,count(*)::integer AS count FROM core.outbox
     WHERE partition_no=$1 AND subject=$2 AND type=ANY($3::text[]) GROUP BY type`,
    [partitionOf(routeOf(catalogueId)!), catalogueId, activationEventTypes],
  );
  const counts = new Map(result.rows.map((row) => [row.type, row.count]));
  return {
    progress: counts.get(activationProgressEvent) ?? 0,
    activated: counts.get(activationEvent) ?? 0,
  };
}

test('expired sealed Books refuse fresh activation work, retain the old edition and replay committed receipts', async () => {
  const f = await hostedChaptersFixture();
  try {
    const catalogueId = f.catalogueId;
    const route = routeOf(catalogueId)!;
    const path = `/v1/hostedCatalogues/${catalogueId}`;
    const actor = f.native.author.actor;
    const currentPublicationId = async () => {
      const result = await f.native.pool.query<{ publication_id: string | null }>(
        `SELECT publication_id FROM content.hosted_catalogue WHERE route=$1 AND catalogue_id=$2`,
        [route, catalogueId],
      );
      return result.rows[0]?.publication_id ?? null;
    };
    const target = f.target(await f.native.thread('published'));
    const oldId = f.newOccurrenceId();
    const nextId = f.newOccurrenceId();
    const placement = (occurrenceId: string, title: string) => ({
      occurrenceId,
      parentId: null,
      position: 0,
      kind: 'chapter' as const,
      title,
      target,
    });
    const created = await f.native.command('/v1/hostedCatalogues', {
      postId: catalogueId,
      threadId: f.threadId,
      placements: [placement(oldId, 'Edition A')],
    });
    const editionA = await f.native.command(
      `${path}:publish`,
      {
        expectedRevisionId: created.revisionId,
        expectedPublicationId: null,
        occurrenceIds: [oldId],
      },
      200,
    );
    const draft = await f.native.command(
      `${path}:revise`,
      {
        expectedRevisionId: created.revisionId,
        placements: [placement(nextId, 'Unpublished B')],
      },
      200,
    );
    const expiry = new Date(Date.now() + 360_000);
    let at = new Date(expiry.getTime() - 1);
    const deps: HostedPublicationActivationDependencies = {
      pool: f.native.pool,
      access: f.native.system.access,
      tokens: f.native.system.tokenKeys,
      routeKey: f.native.system.routeKey,
      clock: () => at,
    };
    async function prepare(expiresAt = expiry.toISOString()) {
      const stageId = f.newOccurrenceId();
      const stagePath = `${path}/publicationPreparations/${stageId}`;
      await f.native.command(
        `${path}:prepareRelease`,
        {
          stageId,
          expectedRevisionId: draft.revisionId,
          expectedPublicationId: editionA.revisionId,
          mode: 'whole',
        },
        202,
      );
      const built = await f.native.command(`${stagePath}:advance`, { stepId: f.newOccurrenceId() }, 200);
      expect(built.candidate.coverageComplete).toBe(true);
      expect((await f.native.command(`${stagePath}:seal`, {}, 200)).candidateReady).toBe(true);
      // Install the boundary directly; command time advances without a collector or a sleep.
      await f.native.pool.query(
        `UPDATE content.hosted_publication_staging SET expires_at=$4::timestamptz
         WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3`,
        [route, catalogueId, stageId, expiresAt],
      );
      return stageId;
    }
    const unstarted = await prepare();
    const checking = await prepare();
    const ready = await prepare();
    const precise = await prepare(`${expiry.toISOString().slice(0, -1)}001Z`);
    const committedExpiry = new Date(expiry.getTime() + 60_000);
    const committed = await prepare(committedExpiry.toISOString());
    const initialEvents = await activationEventCounts(f, catalogueId);
    const checkingContext = context();
    const checkingStarted = await start(deps, actor, catalogueId, checking, checkingContext);
    expect(checkingStarted.value.state).toBe('checking');
    const afterStartEvents = { ...initialEvents, progress: initialEvents.progress + 1 };
    expect(await activationEventCounts(f, catalogueId)).toEqual(afterStartEvents);
    expect(await start(deps, actor, catalogueId, checking, checkingContext)).toEqual({
      ...checkingStarted,
      replayed: true,
    });
    expect(await start(deps, actor, catalogueId, checking, context())).toMatchObject({ value: checkingStarted.value });
    expect(await activationEventCounts(f, catalogueId)).toEqual(afterStartEvents);

    const readyStarted = await start(deps, actor, catalogueId, ready, context());
    expect(readyStarted.value.state).toBe('checking');
    const afterReadyStartEvents = { ...afterStartEvents, progress: afterStartEvents.progress + 1 };
    expect(await activationEventCounts(f, catalogueId)).toEqual(afterReadyStartEvents);
    const readyContext = context();
    const readyProgress = await advance(deps, actor, catalogueId, ready, readyContext);
    expect(readyProgress.value.state).toBe('ready');
    const afterReadyEvents = { ...afterReadyStartEvents, progress: afterReadyStartEvents.progress + 1 };
    expect(await activationEventCounts(f, catalogueId)).toEqual(afterReadyEvents);
    expect(await advance(deps, actor, catalogueId, ready, readyContext)).toEqual({ ...readyProgress, replayed: true });
    expect(await advance(deps, actor, catalogueId, ready, context())).toMatchObject({ value: readyProgress.value });
    expect(await activationEventCounts(f, catalogueId)).toEqual(afterReadyEvents);

    at = expiry;
    // One microsecond remains live; JavaScript Date truncation would incorrectly refuse it.
    expect((await start(deps, actor, catalogueId, precise, context())).value.state).toBe('checking');
    for (const offset of [0, 1]) {
      at = new Date(expiry.getTime() + offset);
      await expect(start(deps, actor, catalogueId, unstarted, context())).rejects.toBeInstanceOf(
        HostedPublicationActivationConflictError,
      );
      for (const stageId of [checking, ready]) {
        await expect(start(deps, actor, catalogueId, stageId, context())).rejects.toBeInstanceOf(
          HostedPublicationActivationNotFoundError,
        );
        await expect(advance(deps, actor, catalogueId, stageId, context())).rejects.toBeInstanceOf(
          HostedPublicationActivationNotFoundError,
        );
      }
      await expect(activate(deps, actor, catalogueId, ready, context())).rejects.toBeInstanceOf(
        HostedPublicationActivationNotFoundError,
      );
    }
    const state = await f.native.pool.query<{
      publication_id: string;
      state: string;
      activation_revision_id: string;
      stage_status: string;
    }>(
      `SELECT catalogue.publication_id,activation.state,activation.activation_revision_id,stage.status AS stage_status
       FROM content.hosted_catalogue catalogue
       JOIN content.hosted_publication_activation activation USING (route,catalogue_id)
       JOIN content.hosted_publication_staging stage USING (route,catalogue_id,stage_id)
       WHERE catalogue.route=$1 AND catalogue.catalogue_id=$2 AND activation.stage_id=$3`,
      [route, catalogueId, ready],
    );
    expect(state.rows[0]).toMatchObject({
      publication_id: editionA.revisionId,
      state: 'ready',
      stage_status: 'sealed',
    });
    const old = await f.native.call('GET', `${path}/occurrences/${oldId}?kind=publication`, undefined, {
      anonymous: true,
    });
    expect(old.status).toBe(200);
    expect(old.value.document.sha256).toBe(target.sha256);
    const unpublished = await f.native.call(
      'GET',
      `${path}/occurrences/${nextId}?kind=publication&revisionId=${state.rows[0]!.activation_revision_id}`,
      undefined,
      { anonymous: true },
    );
    expect(unpublished.status).toBe(404);

    const committedStarted = await start(deps, actor, catalogueId, committed, context());
    expect(committedStarted.value.state).toBe('checking');
    const beforeCommittedAdvance = await activationEventCounts(f, catalogueId);
    const committedProgress = await advance(deps, actor, catalogueId, committed, context());
    expect(committedProgress.value.state).toBe('ready');
    expect((await activationEventCounts(f, catalogueId)).progress).toBe(beforeCommittedAdvance.progress + 1);
    const beforeActivationEvents = await activationEventCounts(f, catalogueId);
    expect(await currentPublicationId()).toBe(editionA.revisionId);
    const activationContext = context();
    const activated = await activate(deps, actor, catalogueId, committed, activationContext);
    expect(activated.value.state).toBe('activated');
    const afterActivationEvents = { ...beforeActivationEvents, activated: beforeActivationEvents.activated + 1 };
    expect(await activationEventCounts(f, catalogueId)).toEqual(afterActivationEvents);
    const activatedPointer = activated.value.publicationId;
    expect(await currentPublicationId()).toBe(activatedPointer);
    expect(await activate(deps, actor, catalogueId, committed, activationContext)).toEqual({
      ...activated,
      replayed: true,
    });
    expect(await activate(deps, actor, catalogueId, committed, context())).toMatchObject({ value: activated.value });
    expect(await activationEventCounts(f, catalogueId)).toEqual(afterActivationEvents);
    expect(await currentPublicationId()).toBe(activatedPointer);
    const activatedAdvanceContext = context();
    const activatedAdvance = await advance(deps, actor, catalogueId, committed, activatedAdvanceContext);
    expect(activatedAdvance.value).toEqual(activated.value);
    expect(await advance(deps, actor, catalogueId, committed, activatedAdvanceContext)).toEqual({
      ...activatedAdvance,
      replayed: true,
    });
    expect(await advance(deps, actor, catalogueId, committed, context())).toMatchObject({
      value: activatedAdvance.value,
    });
    expect(await activationEventCounts(f, catalogueId)).toEqual(afterActivationEvents);
    expect(await currentPublicationId()).toBe(activatedPointer);
    const laterDraft = await f.native.command(
      `${path}:revise`,
      {
        expectedRevisionId: draft.revisionId,
        placements: [placement(nextId, 'Edition C')],
      },
      200,
    );
    const editionC = await f.native.command(
      `${path}:publish`,
      {
        expectedRevisionId: laterDraft.revisionId,
        expectedPublicationId: activated.value.publicationId,
        occurrenceIds: [nextId],
      },
      200,
    );
    at = committedExpiry;
    for (const operation of [start, advance, activate]) {
      await expect(operation(deps, actor, catalogueId, committed, context())).rejects.toBeInstanceOf(
        HostedPublicationActivationNotFoundError,
      );
    }
    expect(await activate(deps, actor, catalogueId, committed, activationContext)).toEqual({
      ...activated,
      replayed: true,
    });
    const pointer = await f.native.pool.query<{ publication_id: string }>(
      `SELECT publication_id FROM content.hosted_catalogue WHERE route=$1 AND catalogue_id=$2`,
      [route, catalogueId],
    );
    expect(pointer.rows[0]!.publication_id).toBe(editionC.revisionId);
  } finally {
    await f.close();
  }
});
