import { expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import sharp from 'sharp';
import { CONTENT_COLLECTION_SCHEDULE } from '../../src/content/work.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import {
  MEDIA_NATIVE_BASE,
  MEDIA_NATIVE_CUT,
  createHttpMedia,
  createMediaObjectStore,
  contentHttp,
  databaseUrlForSystem,
  sha256,
  startNativeCollectionWorker,
  type HttpMedia,
  type MediaObjectStore,
} from './media-native-collection-fixture.ts';
import { contentGovernanceCredential, createContentSystem, type ContentSystem } from './support/system.ts';
import { provisionMediaContainers } from './support/media-fixtures.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

type MediaSnapshot = {
  readonly state: string;
  readonly collection_pending: boolean;
  readonly claimed_at: string | null;
  readonly claimed_item_id: string | null;
  readonly sha256: string | null;
  readonly decision: string | null;
  readonly erased: boolean;
  readonly taken_down: boolean;
  readonly security_revision: string;
  readonly variants: readonly {
    readonly format: string;
    readonly width: number;
    readonly height: number;
    readonly byte_count: string;
    readonly sha256: string;
    readonly key: string;
  }[];
};

async function mediaSnapshot(system: ContentSystem, id: string): Promise<MediaSnapshot | null> {
  const media = await system.database.pool.query<{
    state: string;
    collection_pending: boolean;
    claimed_at: string | null;
    claimed_item_id: string | null;
    sha256: string | null;
    decision: string | null;
    erased: boolean;
    taken_down: boolean;
    security_revision: string;
  }>(
    `SELECT state,collection_pending,claimed_at::text,claimed_item_id,sha256,decision,erased,taken_down,
            security_revision::text
       FROM content.media WHERE route=$1 AND media_id=$2`,
    [routeOf(id), id],
  );
  const row = media.rows[0];
  if (!row) return null;
  const variants = await system.database.pool.query<MediaSnapshot['variants'][number]>(
    `SELECT format,width,height,byte_count::text,sha256,key
       FROM content.media_variant WHERE route=$1 AND media_id=$2 ORDER BY format,width`,
    [routeOf(id), id],
  );
  return {
    ...row,
    claimed_at: row.claimed_at,
    variants: variants.rows,
  };
}

async function sourcePost(system: ContentSystem, postId: string) {
  const response = await contentHttp(system, null, 'GET', `/v1/posts/${postId}`);
  expect(response.response.status).toBe(200);
  expect(response.body?.post).toBeDefined();
  return response.body!.post as Record<string, unknown>;
}

function withoutRequestId(body: Record<string, unknown> | undefined) {
  if (!body) throw new Error('An HTTP problem response must have a JSON body');
  const { request_id: _requestId, ...problem } = body;
  return problem;
}

function assertConcealedProblem(body: Record<string, unknown> | undefined) {
  expect(body).toMatchObject({
    status: 404,
    code: 'not_found',
    effect_status: 'not_applicable',
  });
  const serialized = JSON.stringify(body);
  expect(serialized).not.toMatch(/m\/[0-9a-f-]{36}\//i);
  expect(serialized).not.toMatch(/"(?:key|sha256)"\s*:/i);
}

async function claimMedia(
  system: ContentSystem,
  actor: ContentSystem['actors']['author'],
  threadId: string,
  media: HttpMedia,
  key: string,
) {
  return contentHttp(
    system,
    actor,
    'POST',
    `/v1/threads/${threadId}/posts`,
    { body: fromPlainText(key), licence: 'MIT', mediaIds: [media.id] },
    key,
  );
}

async function upload(
  system: ContentSystem,
  store: MediaObjectStore,
  runtime: Parameters<typeof createHttpMedia>[0]['runtime'],
  actor: ContentSystem['actors']['author'],
  uploader: ContentSystem['actors']['worker'],
  containerId: string,
  bytes: Uint8Array,
  label: string,
) {
  return createHttpMedia({
    system,
    store,
    runtime,
    actor,
    uploader,
    containerId,
    bytes,
    keyPrefix: label,
  });
}

async function assertPhysicalImage(store: MediaObjectStore, image: HttpMedia) {
  const physical = store.inspect(`m/${image.id}/`);
  const expected = [
    { key: `m/${image.id}/original`, sha256: image.sourceDigest },
    ...image.image.variants.map(({ key, sha256 }) => ({ key, sha256 })),
  ].sort((left, right) => left.key.localeCompare(right.key));
  expect(physical).toEqual(expected);
}

async function workflowCollectionResult(
  client: Awaited<ReturnType<typeof createWorkClient>>,
  workflowId: string,
  partition: number,
) {
  const result = await client.getWorkflow(workflowId);
  const childId = `${workflowId}:partition:${partition}`;
  const child = await client.getWorkflow(childId);
  const steps = await client.listWorkflowSteps(childId);
  return { result, child, steps: steps ?? [] };
}

test('Media lifecycle: HTTP-produced objects retain uploader and claim authority through the native twenty-four-hour collection handoff.', async () => {
  const store = createMediaObjectStore();
  let system: ContentSystem | undefined;
  let client: Awaited<ReturnType<typeof createWorkClient>> | undefined;
  let worker: Awaited<ReturnType<typeof startNativeCollectionWorker>> | undefined;
  let releaseFailedDeletion: (() => void) | undefined;
  try {
    system = await createContentSystem({
      databaseUrl,
      namespace: `native_media_collection_${crypto.randomUUID().replaceAll('-', '')}`,
    });
    await system.clock.setCommandTime(MEDIA_NATIVE_BASE);
    const { containers } = await provisionMediaContainers(system, {
      namespace: crypto.randomUUID(),
    });
    const thread = containers.thread;
    expect(routeOf(thread.id)).toBe(thread.route);
    expect(routeOf(thread.id)).not.toBe(routeOf(system.actors.author.actor.accountId));

    const governance = await contentGovernanceCredential(system);
    const grant = await contentHttp(
      system,
      governance,
      'POST',
      '/v1/grants',
      {
        resource: { route: thread.route, id: thread.id },
        subject: { kind: 'account', id: system.actors.other.actor.accountId },
        actions: ['media:create', 'post:create'],
        valid: '(,)',
      },
      `media-native-other-${crypto.randomUUID()}`,
    );
    expect(grant.response.status).toBe(201);

    const systemUrl = await databaseUrlForSystem(system, databaseUrl);
    const workClient = await createWorkClient(systemUrl);
    client = workClient;
    worker = await startNativeCollectionWorker({
      entryPath: new URL('./media-native-collection-fixture.ts', import.meta.url).pathname,
      databaseUrl: systemUrl,
      endpoint: store.endpoint,
      routeKey: system.routeKey,
      partitions: [thread.partition],
      now: MEDIA_NATIVE_BASE,
    });
    const runtime = { client: workClient, relayThrough: worker.relayThrough };

    const source = await sharp({
      create: {
        width: 64,
        height: 48,
        channels: 3,
        background: { r: 38, g: 102, b: 177 },
      },
    })
      .png()
      .toBuffer();
    const oversized = await sharp({
      create: {
        width: 6401,
        height: 6400,
        channels: 3,
        background: { r: 14, g: 12, b: 9 },
      },
    })
      .png()
      .toBuffer();
    expect(oversized.byteLength).toBeLessThan(20 * 1024 * 1024);

    const abandoned = await upload(
      system,
      store,
      runtime,
      system.actors.author,
      system.actors.worker,
      thread.id,
      source,
      'abandoned',
    );
    const claimed = await upload(
      system,
      store,
      runtime,
      system.actors.author,
      system.actors.worker,
      thread.id,
      source,
      'claimed',
    );
    const claimedResponse = await claimMedia(system, system.actors.author, thread.id, claimed, 'claimed-post');
    expect(claimedResponse.response.status).toBe(201);
    const claimedPost = (claimedResponse.body?.post ?? {}) as {
      id?: unknown;
      revisionId?: unknown;
      mediaIds?: unknown;
    };
    expect(typeof claimedPost.id).toBe('string');
    expect(typeof claimedPost.revisionId).toBe('string');
    expect(claimedPost.mediaIds).toEqual([claimed.id]);
    if (typeof claimedPost.id !== 'string' || typeof claimedPost.revisionId !== 'string')
      throw new Error('The HTTP media claim did not return its post and revision IDs');
    const claimedPostId = claimedPost.id;
    const claimedRevisionId = claimedPost.revisionId;

    const otherControl = await upload(
      system,
      store,
      runtime,
      system.actors.otherWorker,
      system.actors.otherWorker,
      thread.id,
      source,
      'other-control',
    );
    const otherClaimResponse = await claimMedia(
      system,
      system.actors.otherWorker,
      thread.id,
      otherControl,
      'other-control-post',
    );
    expect(otherClaimResponse.response.status).toBe(201);
    const otherPost = otherClaimResponse.body?.post as { id?: unknown; revisionId?: unknown } | undefined;
    expect(typeof otherPost?.id).toBe('string');
    expect(typeof otherPost?.revisionId).toBe('string');
    if (!otherPost || typeof otherPost.id !== 'string' || typeof otherPost.revisionId !== 'string')
      throw new Error('The other uploader media claim did not return its post and revision IDs');
    const otherPostId = otherPost.id;
    const otherRevisionId = otherPost.revisionId;

    for (const object of [abandoned, claimed, otherControl]) {
      expect(object.image.state).toBe('available');
      expect(object.image.variants.length).toBeGreaterThan(0);
      await assertPhysicalImage(store, object);
    }
    const abandonedInitial = await mediaSnapshot(system, abandoned.id);
    const claimedInitial = await mediaSnapshot(system, claimed.id);
    const otherInitial = await mediaSnapshot(system, otherControl.id);
    expect(abandonedInitial?.state).toBe('available');
    expect(abandonedInitial?.claimed_at).toBeNull();
    expect(claimedInitial?.claimed_item_id).toBe(claimedPostId);
    expect(otherInitial?.claimed_item_id).toBe(otherPostId);
    const claimedPostBefore = await sourcePost(system, claimedPostId);
    const otherPostBefore = await sourcePost(system, otherPostId);
    const claimedRevisionBefore = await contentHttp(
      system,
      null,
      'GET',
      `/v1/posts/${claimedPostId}/revisions/${claimedRevisionId}`,
    );
    expect(claimedRevisionBefore.response.status).toBe(200);
    const claimedBodyBefore = claimedRevisionBefore.body?.post;
    const otherRevisionBefore = await contentHttp(
      system,
      null,
      'GET',
      `/v1/posts/${otherPostId}/revisions/${otherRevisionId}`,
    );
    expect(otherRevisionBefore.response.status).toBe(200);
    const otherBodyBefore = otherRevisionBefore.body?.post;
    const claimedPhysical = store.inspect(`m/${claimed.id}/`);
    const otherPhysical = store.inspect(`m/${otherControl.id}/`);

    const anonymousUnclaimedVariant = await contentHttp(
      system,
      null,
      'GET',
      `/v1/media/${abandoned.id}:authorizeDownload?variant=${encodeURIComponent(abandoned.image.variants[0]!.key.split('/').at(-1)!)}`,
    );
    const ownerUnclaimedVariant = await contentHttp(
      system,
      system.actors.author,
      'GET',
      `/v1/media/${abandoned.id}:authorizeDownload?variant=${encodeURIComponent(abandoned.image.variants[0]!.key.split('/').at(-1)!)}`,
    );
    expect(anonymousUnclaimedVariant.response.status).toBe(404);
    expect(ownerUnclaimedVariant.response.status).toBe(404);
    const ownerOriginal = await contentHttp(
      system,
      system.actors.author,
      'GET',
      `/v1/media/${abandoned.id}:authorizeDownload?variant=original`,
    );
    expect(ownerOriginal.response.status).toBe(200);
    expect(ownerOriginal.body).toMatchObject({
      key: `m/${abandoned.id}/original`,
      sha256: abandoned.sourceDigest,
    });
    expect(ownerOriginal.response.headers.get('cache-control')).toBe('private, no-store');
    const publicVariant = claimed.image.variants[0]!;
    const publicDecision = await contentHttp(
      system,
      null,
      'GET',
      `/v1/media/${claimed.id}:authorizeDownload?variant=${publicVariant.format}-${publicVariant.width}`,
    );
    expect(publicDecision.response.status).toBe(200);
    expect(publicDecision.body).toMatchObject({
      key: publicVariant.key,
      sha256: publicVariant.sha256,
      mediaType: publicVariant.mediaType,
      byteCount: publicVariant.byteCount,
      publicCache: false,
    });
    expect(publicDecision.response.headers.get('cache-control')).toBe('private, no-cache');
    const anonymousOriginal = await contentHttp(
      system,
      null,
      'GET',
      `/v1/media/${claimed.id}:authorizeDownload?variant=original`,
    );
    expect(anonymousOriginal.response.status).toBe(404);

    const completionBody = {
      containerId: thread.id,
      reservationRequestId: abandoned.reservationKey,
      byteCount: abandoned.sourceBytes.byteLength,
      sha256: abandoned.sourceDigest,
    };
    const otherCompletion = await contentHttp(
      system,
      system.actors.otherWorker,
      'POST',
      `/v1/media/${abandoned.id}:complete`,
      completionBody,
      `other-completion-${crypto.randomUUID()}`,
    );
    expect(otherCompletion.response.status).toBe(403);
    expect(otherCompletion.body).toMatchObject({
      status: 403,
      code: 'forbidden',
    });
    const otherClaim = await claimMedia(
      system,
      system.actors.otherWorker,
      thread.id,
      abandoned,
      'other-abandoned-claim',
    );
    expect(otherClaim.response.status).toBe(409);
    expect(otherClaim.body).toMatchObject({
      status: 409,
      code: 'media_unavailable',
    });
    expect((await mediaSnapshot(system, abandoned.id))?.claimed_at).toBeNull();

    const ownerConcealed = await contentHttp(system, system.actors.otherWorker, 'GET', `/v1/media/${abandoned.id}`);
    const missingMediaId = newId(thread.route);
    const ownerMissing = await contentHttp(system, system.actors.author, 'GET', `/v1/media/${missingMediaId}`);
    expect(ownerConcealed.response.status).toBe(404);
    expect(ownerMissing.response.status).toBe(404);
    assertConcealedProblem(ownerConcealed.body);
    assertConcealedProblem(ownerMissing.body);
    expect(withoutRequestId(ownerConcealed.body)).toEqual(withoutRequestId(ownerMissing.body));
    const missingOriginalDownload = await contentHttp(
      system,
      system.actors.author,
      'GET',
      `/v1/media/${missingMediaId}:authorizeDownload?variant=original`,
    );
    expect(missingOriginalDownload.response.status).toBe(404);
    assertConcealedProblem(missingOriginalDownload.body);

    const beforeCollection = new Map(
      [abandoned, claimed, otherControl].map((media) => [media.id, store.inspect(`m/${media.id}/`)]),
    );
    await system.clock.setCommandTime('2030-01-01T23:59:59.999Z');
    await worker.setClock('2030-01-01T23:59:59.999Z');
    const beforeHandle = await client.triggerSchedule(CONTENT_COLLECTION_SCHEDULE);
    await beforeHandle.getResult();
    const beforeWorkflow = await workflowCollectionResult(client, beforeHandle.workflowID, thread.partition);
    expect(beforeWorkflow.result?.status).toBe('SUCCESS');
    expect(beforeWorkflow.child?.status).toBe('SUCCESS');
    expect(beforeWorkflow.steps.map((step) => step.name)).toContain('content.collect.step');
    const beforeStep = beforeWorkflow.steps.find((step) => step.name === 'content.collect.step');
    expect(beforeStep?.output).toMatchObject({
      partition: thread.partition,
      examined: 0,
      collected: 0,
      complete: true,
    });
    expect(await mediaSnapshot(system, abandoned.id)).toEqual(abandonedInitial);
    expect(await mediaSnapshot(system, claimed.id)).toEqual(claimedInitial);
    expect(await mediaSnapshot(system, otherControl.id)).toEqual(otherInitial);
    for (const media of [abandoned, claimed, otherControl])
      expect(store.inspect(`m/${media.id}/`)).toEqual(beforeCollection.get(media.id)!);

    const rejected = await upload(
      system,
      store,
      runtime,
      system.actors.author,
      system.actors.worker,
      thread.id,
      oversized,
      'rejected',
    );
    expect(rejected.image.state).toBe('rejected');
    expect(rejected.image.variants).toEqual([]);
    expect(store.inspect(`m/${rejected.id}/`)).toEqual([]);
    const rejectedInitial = await mediaSnapshot(system, rejected.id);
    expect(rejectedInitial?.state).toBe('rejected');

    await system.clock.setCommandTime(MEDIA_NATIVE_CUT);
    await worker.setClock(MEDIA_NATIVE_CUT);
    const failure = await store.failDeleteOnce(`m/${abandoned.id}/`);
    releaseFailedDeletion = failure.release;
    const atCut = await client.triggerSchedule(CONTENT_COLLECTION_SCHEDULE);
    await failure.entered;

    const pendingSnapshot = await mediaSnapshot(system, abandoned.id);
    expect(pendingSnapshot).toMatchObject({
      state: 'available',
      collection_pending: true,
      claimed_at: null,
    });
    const pendingFence = await system.database.pool.query(
      `SELECT r.command_kind,r.idempotency_key,r.response
           FROM core.receipt r
          WHERE r.partition_no=$1 AND r.principal_id=$2 AND r.command_kind='content.media.collection.fence'
            AND r.idempotency_key=$3`,
      [thread.partition, system.actors.author.actor.accountId, abandoned.id],
    );
    expect(pendingFence.rows).toHaveLength(1);
    expect(pendingFence.rows[0]).toMatchObject({
      command_kind: 'content.media.collection.fence',
      idempotency_key: abandoned.id,
      response: { mediaId: abandoned.id, containerId: thread.id },
    });
    const pendingEvents = await system.database.pool.query(
      `SELECT type,data FROM core.outbox WHERE partition_no=$1 AND subject=$2
          AND type IN ('com.rezics.content.media.collection-pending.v1','com.rezics.content.media.collected.v1')
          ORDER BY position,event_seq`,
      [thread.partition, abandoned.id],
    );
    expect(pendingEvents.rows).toEqual([
      {
        type: 'com.rezics.content.media.collection-pending.v1',
        data: {
          mediaId: abandoned.id,
          containerId: thread.id,
          actorId: system.actors.author.actor.accountId,
        },
      },
    ]);
    expect((await client.getWorkflow(atCut.workflowID))?.status).toBe('PENDING');

    const pendingOwnerDownload = await contentHttp(
      system,
      system.actors.author,
      'GET',
      `/v1/media/${abandoned.id}:authorizeDownload?variant=original`,
    );
    const pendingOtherDownload = await contentHttp(
      system,
      system.actors.otherWorker,
      'GET',
      `/v1/media/${abandoned.id}:authorizeDownload?variant=original`,
    );
    for (const decision of [pendingOwnerDownload, pendingOtherDownload]) {
      expect(decision.response.status).toBe(404);
      assertConcealedProblem(decision.body);
    }
    expect(withoutRequestId(pendingOwnerDownload.body)).toEqual(withoutRequestId(pendingOtherDownload.body));
    expect(withoutRequestId(pendingOwnerDownload.body)).toEqual(withoutRequestId(missingOriginalDownload.body));

    const countsBeforeRace = await system.database.pool.query(
      `SELECT (SELECT count(*)::integer FROM content.post WHERE route=$1) AS posts,
                (SELECT count(*)::integer FROM content.revision WHERE route=$1) AS revisions,
                (SELECT count(*)::integer FROM content.revision
                  WHERE route=$1 AND media_ids @> ARRAY[$3::uuid]) AS media_references,
                (SELECT count(*)::integer FROM core.receipt WHERE partition_no=$2) AS receipts,
                (SELECT count(*)::integer FROM core.outbox WHERE partition_no=$2) AS events`,
      [thread.route, thread.partition, abandoned.id],
    );
    const ownerPendingClaim = await claimMedia(
      system,
      system.actors.author,
      thread.id,
      abandoned,
      'owner-pending-claim',
    );
    expect(ownerPendingClaim.response.status).toBe(409);
    expect(ownerPendingClaim.body).toMatchObject({
      status: 409,
      code: 'media_unavailable',
    });
    const otherPendingClaim = await claimMedia(
      system,
      system.actors.otherWorker,
      thread.id,
      abandoned,
      'other-pending-claim',
    );
    expect(otherPendingClaim.response.status).toBe(409);
    expect(otherPendingClaim.body).toMatchObject({
      status: 409,
      code: 'media_unavailable',
    });
    const pendingCompletion = await contentHttp(
      system,
      system.actors.otherWorker,
      'POST',
      `/v1/media/${abandoned.id}:complete`,
      completionBody,
      `owner-pending-completion-${crypto.randomUUID()}`,
    );
    expect(pendingCompletion.response.status).toBe(403);
    expect(pendingCompletion.body).toMatchObject({
      status: 403,
      code: 'forbidden',
    });
    const countsAfterRace = await system.database.pool.query(
      `SELECT (SELECT count(*)::integer FROM content.post WHERE route=$1) AS posts,
                (SELECT count(*)::integer FROM content.revision WHERE route=$1) AS revisions,
                (SELECT count(*)::integer FROM content.revision
                  WHERE route=$1 AND media_ids @> ARRAY[$3::uuid]) AS media_references,
                (SELECT count(*)::integer FROM core.receipt WHERE partition_no=$2) AS receipts,
                (SELECT count(*)::integer FROM core.outbox WHERE partition_no=$2) AS events`,
      [thread.route, thread.partition, abandoned.id],
    );
    expect(countsAfterRace.rows).toEqual(countsBeforeRace.rows);
    expect(await mediaSnapshot(system, abandoned.id)).toEqual(pendingSnapshot);
    expect(pendingEvents.rows).toHaveLength(1);

    failure.release();
    await atCut.getResult();
    const afterWorkflow = await workflowCollectionResult(client, atCut.workflowID, thread.partition);
    expect(afterWorkflow.result?.status).toBe('SUCCESS');
    expect(afterWorkflow.child?.status).toBe('SUCCESS');
    const collectionSteps = afterWorkflow.steps.filter((step) => step.name === 'content.collect.step');
    expect(collectionSteps).toHaveLength(1);
    expect(collectionSteps[0]?.output).toMatchObject({
      partition: thread.partition,
      complete: true,
    });
    expect((collectionSteps[0]?.output as { collected?: unknown }).collected).toBeGreaterThan(0);
    expect(store.failedDeletes).toHaveLength(1);
    expect(store.failedDeletes[0]).toMatch(new RegExp(`^m/${abandoned.id}/`));
    expect(store.listPrefixes.filter((prefix) => prefix === `m/${abandoned.id}/`)).toHaveLength(2);
    expect(store.inspect(`m/${abandoned.id}/`)).toEqual([]);
    expect(await mediaSnapshot(system, abandoned.id)).toBeNull();
    expect(await mediaSnapshot(system, rejected.id)).toBeNull();

    for (const media of [abandoned, rejected]) {
      const events = await system.database.pool.query<{ type: string }>(
        `SELECT type FROM core.outbox WHERE partition_no=$1 AND subject=$2
            AND type IN ('com.rezics.content.media.collection-pending.v1','com.rezics.content.media.collected.v1')
            ORDER BY position,event_seq`,
        [thread.partition, media.id],
      );
      expect(events.rows.map(({ type }) => type)).toEqual([
        'com.rezics.content.media.collection-pending.v1',
        'com.rezics.content.media.collected.v1',
      ]);
      const fences = await system.database.pool.query(
        `SELECT count(*)::integer AS count FROM core.receipt
            WHERE partition_no=$1 AND principal_id=$2 AND command_kind='content.media.collection.fence'
              AND idempotency_key=$3`,
        [thread.partition, system.actors.author.actor.accountId, media.id],
      );
      const finishes = await system.database.pool.query(
        `SELECT count(*)::integer AS count FROM core.receipt
            WHERE partition_no=$1 AND principal_id=$2 AND command_kind='content.media.collection.finish'
              AND idempotency_key=$3`,
        [thread.partition, system.actors.author.actor.accountId, media.id],
      );
      expect(fences.rows[0]?.count).toBe(1);
      expect(finishes.rows[0]?.count).toBe(1);
    }

    expect(await mediaSnapshot(system, claimed.id)).toEqual(claimedInitial);
    expect(await mediaSnapshot(system, otherControl.id)).toEqual(otherInitial);
    expect(store.inspect(`m/${claimed.id}/`)).toEqual(claimedPhysical);
    expect(store.inspect(`m/${otherControl.id}/`)).toEqual(otherPhysical);
    expect(await sourcePost(system, claimedPostId)).toEqual(claimedPostBefore);
    expect(await sourcePost(system, otherPostId)).toEqual(otherPostBefore);
    const claimedRevisionAfter = await contentHttp(
      system,
      null,
      'GET',
      `/v1/posts/${claimedPostId}/revisions/${claimedRevisionId}`,
    );
    expect(claimedRevisionAfter.response.status).toBe(200);
    expect(claimedRevisionAfter.body?.post).toEqual(claimedBodyBefore);
    const otherRevisionAfter = await contentHttp(
      system,
      null,
      'GET',
      `/v1/posts/${otherPostId}/revisions/${otherRevisionId}`,
    );
    expect(otherRevisionAfter.response.status).toBe(200);
    expect(otherRevisionAfter.body?.post).toEqual(otherBodyBefore);
    const publicStillWorks = await contentHttp(
      system,
      null,
      'GET',
      `/v1/media/${claimed.id}:authorizeDownload?variant=${publicVariant.format}-${publicVariant.width}`,
    );
    expect(publicStillWorks.response.status).toBe(200);
    expect(publicStillWorks.body).toMatchObject({
      key: publicVariant.key,
      sha256: publicVariant.sha256,
    });
    const otherPublicVariant = otherControl.image.variants[0]!;
    const otherPublicStillWorks = await contentHttp(
      system,
      null,
      'GET',
      `/v1/media/${otherControl.id}:authorizeDownload?variant=${otherPublicVariant.format}-${otherPublicVariant.width}`,
    );
    expect(otherPublicStillWorks.response.status).toBe(200);
    expect(otherPublicStillWorks.body).toMatchObject({
      key: otherPublicVariant.key,
      sha256: otherPublicVariant.sha256,
    });
    const privateOriginalStillPrivate = await contentHttp(
      system,
      null,
      'GET',
      `/v1/media/${claimed.id}:authorizeDownload?variant=original`,
    );
    expect(privateOriginalStillPrivate.response.status).toBe(404);
    const controlOriginalStillPrivate = await contentHttp(
      system,
      null,
      'GET',
      `/v1/media/${otherControl.id}:authorizeDownload?variant=original`,
    );
    expect(controlOriginalStillPrivate.response.status).toBe(404);

    const replayed = await client.retrieveWorkflow(atCut.workflowID).getResult();
    expect(replayed).toEqual(await atCut.getResult());
    const collected = await system.database.pool.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM core.outbox
          WHERE partition_no=$1 AND subject=$2 AND type='com.rezics.content.media.collected.v1'`,
      [thread.partition, abandoned.id],
    );
    expect(collected.rows[0]?.count).toBe(1);
    expect(abandoned.sourceDigest).toBe(sha256(abandoned.sourceBytes));
    expect(rejected.sourceDigest).toBe(sha256(rejected.sourceBytes));
    expect(claimed.image.variants.map((variant) => variant.sha256).sort()).toEqual(
      claimedPhysical
        .filter(({ key }) => !key.endsWith('/original'))
        .map(({ sha256: digest }) => digest)
        .sort(),
    );
  } finally {
    releaseFailedDeletion?.();
    try {
      await worker?.stop();
    } finally {
      if (client) {
        try {
          await client.deleteSchedule(CONTENT_COLLECTION_SCHEDULE);
        } finally {
          await client.close();
        }
      }
      try {
        await system?.close();
      } finally {
        store.close();
      }
    }
  }
}, 300_000);
