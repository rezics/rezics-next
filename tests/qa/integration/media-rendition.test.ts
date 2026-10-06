import { isForegroundOperation } from './support/operation-cost.ts';
import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import sharp from 'sharp';
import {
  MediaRenditionStore,
  RENDITION_CANDIDATES_SQL,
} from '../../../services/main/src/modules/media-rendition/store.ts';
import { requestUseRenditions } from '../../../services/main/src/modules/media-rendition/request.ts';
import { MediaRenditionWorker } from '../../../services/main/src/modules/media-rendition/worker.ts';
import { LocalImageTransformer } from '../../../services/main/src/modules/media-rendition/transform.ts';
import {
  parseProfile,
  RENDITION_LIMITS,
} from '../../../services/main/src/modules/media-rendition/policy.ts';
import { DEFAULT_MEDIA_CONTEXT } from '../../../services/main/src/modules/media/store.ts';
import { renditionProfiles } from '../../../services/main/src/modules/media-rendition/policy.ts';
import { sha, startMediaStack, type MediaStack } from './media-support.ts';

let started: Promise<MediaStack> | undefined;
const stack = () => (started ??= startMediaStack('media-rendition', { autoClearUploads: false }));
afterAll(async () => {
  if (started) await (await started).stop();
});
const transformer = new LocalImageTransformer();

async function selectedImage(label: string, width = 80, height = 80, crop: string | null = null) {
  const fixture = await stack();
  const owner = await fixture.member(label);
  const work = await fixture.publicWork(owner.actor);
  const colour = randomUUID().replaceAll('-', '');
  const bytes = await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: {
        r: parseInt(colour.slice(0, 2), 16),
        g: parseInt(colour.slice(2, 4), 16),
        b: parseInt(colour.slice(4, 6), 16),
        alpha: 0.5,
      },
    },
  })
    .png()
    .toBuffer();
  const image = await owner.upload(bytes);
  await owner.grant(`media:avatar:${work.work}`, 'media.avatar');
  const selected = await owner.send(
    'PUT',
    `/v1/resources/${work.work.slice('https://rezics.com/id/'.length)}/avatar`,
    {
      profile: 'resource-avatar-selection-v1',
      expectedSelection: null,
      asset: image.asset,
      crop,
      actingSubject: owner.actor,
    },
  );
  expect(selected.status).toBe(201);
  const selection = ((await selected.json()) as { selection: string }).selection;
  const use = (
    await fixture.contentPool.query<{ use_id: string }>(
      'SELECT use_id FROM media.selection_revision WHERE id = $1',
      [selection],
    )
  ).rows[0].use_id;
  const renditions = fixture.store.renditions;
  const worker = new MediaRenditionWorker(renditions, transformer, fixture.objects);
  return { ...fixture, owner, work, bytes, image, use, selection, renditions, worker };
}

async function otherUse(
  fixture: Awaited<ReturnType<typeof selectedImage>>,
  target: string,
  crop: string | null,
) {
  const result = await fixture.store.selectAvatar(
    {
      admissionId: randomUUID(),
      principalId: fixture.owner.principalId,
      actingSubject: fixture.owner.actor,
      authorityEpoch: '0',
      requestDigest: sha(randomUUID()),
    },
    {
      target,
      context: DEFAULT_MEDIA_CONTEXT,
      expectedSelection: null,
      asset: fixture.image.asset,
      crop,
    },
  );
  expect(result.outcome).toBe('succeeded');
  return (
    await fixture.contentPool.query<{ use_id: string }>(
      'SELECT use_id FROM media.selection_revision WHERE id = $1',
      [result.id],
    )
  ).rows[0].use_id;
}

test('a selected Use queues idempotent crop-width jobs, executes both real codecs in RustFS and reads exact srcset candidates', async () => {
  const fixture = await selectedImage('crop', 800, 400, 'xywh=percent:25,0,50,100');
  const { renditions, objects, use, worker, contentPool, image, call, bytes } = fixture;
  expect(
    (
      await contentPool.query('SELECT id FROM media.transform_job WHERE source_id = $1 AND profile <> \'required-image-match-v1\'', [
        image.representation,
      ])
    ).rowCount,
  ).toBe(0);
  const requested = await Promise.all([
    requestUseRenditions(renditions, objects, use),
    requestUseRenditions(renditions, objects, use),
  ]);
  expect(requested.map((result) => result.queued).sort()).toEqual([0, 4]);
  expect((await renditions.candidatesBatch([use])).get(use)).toEqual([]);
  for (let i = 0; i < 4; i++) await worker.tick();
  const candidates = (await renditions.candidatesBatch([use])).get(use)!;
  expect(candidates.map(({ width, height, type }) => ({ width, height, type }))).toEqual([
    { width: 320, height: 320, type: 'image/avif' },
    { width: 320, height: 320, type: 'image/webp' },
    { width: 400, height: 400, type: 'image/avif' },
    { width: 400, height: 400, type: 'image/webp' },
  ]);
  for (const candidate of candidates) {
    const response = await call('GET', candidate.url);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(candidate.type);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    const result = new Uint8Array(await response.arrayBuffer());
    expect(await sharp(result).metadata()).toMatchObject({
      width: candidate.width,
      height: candidate.height,
      hasAlpha: true,
    });
    expect(sha(result)).not.toBe(sha(bytes));
    const representation = new URL(candidate.url, 'http://main.local').pathname.split('/')[4];
    const record = (
      await contentPool.query(
        `SELECT p.byte_digest,p.crop,p.clearance,j.status,r.action,o.recipe
      FROM media.representation p JOIN media.transform_job j ON j.id = p.transform_job_id
      JOIN content.receipt r ON r.operation_id = p.operation_id JOIN content.outbox o ON o.operation_id = r.operation_id
      WHERE p.id = $1`,
        [representation],
      )
    ).rows[0];
    expect(record).toMatchObject({
      byte_digest: sha(result),
      crop: 'xywh=percent:25,0,50,100',
      clearance: 'cleared',
      status: 'succeeded',
      action: 'media.transform.settle',
      recipe: 'media-v1',
    });
    expect(sha(await objects(`media/asset/${image.asset}/`).get(record.byte_digest))).toBe(
      sha(result),
    );
  }
  const receipts = (await contentPool.query('SELECT count(*)::int AS n FROM content.receipt'))
    .rows[0].n;
  expect(await requestUseRenditions(renditions, objects, use)).toEqual({ queued: 0 });
  expect(
    (await contentPool.query('SELECT count(*)::int AS n FROM content.receipt')).rows[0].n,
  ).toBe(receipts);
  const secondTarget = await fixture.publicWork(fixture.owner.actor);
  const differentCrop = await otherUse(fixture, secondTarget.work, 'xywh=percent:0,0,50,100');
  expect((await renditions.candidatesBatch([differentCrop])).get(differentCrop)).toEqual([]);
  const mismatched = new URL(candidates[0].url, 'http://main.local');
  mismatched.searchParams.set('use', differentCrop);
  expect((await call('GET', `${mismatched.pathname}${mismatched.search}`)).status).toBe(404);
  expect(await requestUseRenditions(renditions, objects, differentCrop)).toEqual({ queued: 4 });
  for (let i = 0; i < 4; i++) await worker.tick();
  expect((await renditions.candidatesBatch([differentCrop])).get(differentCrop)).toHaveLength(4);
}, 60_000);

test('both owner reads withhold each codec until its whole ladder is deliverable, including after candidate loss', async () => {
  const fixture = await selectedImage('complete-ladder', 1280, 720);
  const { store, renditions, objects, use, bytes, image, work, owner, contentPool } = fixture;
  const selected = await store.showcase.select(
    {
      admissionId: randomUUID(),
      principalId: owner.principalId,
      actingSubject: owner.actor,
      authorityEpoch: '0',
      requestDigest: sha(randomUUID()),
    },
    {
      target: work.work,
      context: DEFAULT_MEDIA_CONTEXT,
      role: 'background-landscape',
      asset: image.asset,
      crop: null,
      focalArea: null,
      expectedSelection: null,
    },
    () => transformer.inspect(bytes, 'image/png'),
  );
  expect(selected.outcome).toBe('succeeded');
  const profiles = renditionProfiles(1280);
  const outputs = await transformer.transformCrop(
    bytes,
    'image/png',
    profiles.map((profile) => ({ profile, crop: null })),
  );
  expect(await requestUseRenditions(renditions, objects, use)).toEqual({ queued: 8 });
  for (let index = 0; index < profiles.length; index++) {
    const lease = (await renditions.leaseNext())!;
    const output = outputs[profiles.indexOf(lease.profile)]!;
    expect(
      await renditions.settle(lease, output, () => objects(lease.namespace).put(output.bytes)),
    ).toBe(true);
    const candidates = (await renditions.candidatesBatch([use])).get(use)!;
    const showcase = (await store.showcase.readBatch([work.work], DEFAULT_MEDIA_CONTEXT)).art.get(
      work.work,
    )!.images[0].srcset;
    const expectedTypes =
      index < 6
        ? []
        : index === 6
          ? Array(4).fill('image/avif')
          : Array.from({ length: 4 }, () => ['image/avif', 'image/webp']).flat();
    expect(candidates.map((candidate) => candidate.type)).toEqual(expectedTypes);
    expect(showcase.map((candidate) => candidate.type)).toEqual(expectedTypes);
    expect(candidates.map((candidate) => candidate.width)).toEqual(
      index < 6
        ? []
        : index === 6
          ? [320, 640, 960, 1280]
          : [320, 320, 640, 640, 960, 960, 1280, 1280],
    );
  }
  await contentPool.query(
    `UPDATE media.representation SET availability = 'unavailable'
    WHERE source_id = $1 AND profile = 'image-width-1280-avif-v1'`,
    [image.representation],
  );
  expect(
    (await renditions.candidatesBatch([use])).get(use)!.map((candidate) => candidate.type),
  ).toEqual(Array(4).fill('image/webp'));
  expect(
    (await store.showcase.readBatch([work.work], DEFAULT_MEDIA_CONTEXT)).art
      .get(work.work)!
      .images[0].srcset.map((candidate) => candidate.type),
  ).toEqual(Array(4).fill('image/webp'));
}, 60_000);

test('crop leases are disjoint between workers and a live sibling prevents a second decode', async () => {
  const fixture = await selectedImage('crop-lease', 640, 360);
  await requestUseRenditions(fixture.renditions, fixture.objects, fixture.use);
  const [first, second] = await Promise.all([
    fixture.renditions.leaseCrop(),
    fixture.renditions.leaseCrop(),
  ]);
  const leases = first.length ? first : second;
  expect(leases).toHaveLength(4);
  expect(first.length && second.length).toBe(0);
  expect(await fixture.renditions.leaseCrop()).toEqual([]);
  const outputs = await transformer.transformCrop(
    fixture.bytes,
    'image/png',
    leases.map(({ profile, crop }) => ({ profile, crop })),
  );
  for (const [index, lease] of leases.entries()) {
    const output = outputs[index];
    expect(
      await fixture.renditions.settle(lease, output, () =>
        fixture.objects(lease.namespace).put(output.bytes),
      ),
    ).toBe(true);
  }
  expect((await fixture.renditions.candidatesBatch([fixture.use])).get(fixture.use)).toHaveLength(
    4,
  );
}, 60_000);

interface PlanNode {
  'Node Type': string;
  'Index Name'?: string;
  'Index Cond'?: string;
  'Actual Loops': number;
  'Actual Rows': number;
  Plans?: PlanNode[];
}
function flatten(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans?.flatMap(flatten) ?? [])];
}

test('64 resolved Uses use one SQL batch and bounded exact source/crop index probes', async () => {
  const { renditions, objects, use, worker, contentPool } = await selectedImage('batch');
  const { queued } = await requestUseRenditions(renditions, objects, use);
  for (let i = 0; i < queued; i++) await worker.tick();
  const copies = await contentPool.query<{ id: string }>(
    `INSERT INTO media.use (id,asset_id,asset_variant_id,asset_revision_id,
    representation_id,target,context,role,crop,actor,operation_id)
    SELECT gen_random_uuid(),u.asset_id,u.asset_variant_id,u.asset_revision_id,u.representation_id,u.target,u.context,
      u.role,u.crop,u.actor,u.operation_id FROM media.use u CROSS JOIN generate_series(1,63) WHERE u.id = $1 RETURNING id`,
    [use],
  );
  const uses = [use, ...copies.rows.map((row) => row.id)];
  let queries = 0;
  const counted = new MediaRenditionStore({
    query: async (sql: string, params: unknown[]) => {
      if (isForegroundOperation()) queries++;
      return contentPool.query(sql, params);
    },
  } as unknown as Pool);
  const batch = await counted.candidatesBatch(uses);
  expect(queries).toBe(1);
  expect(batch.size).toBe(64);
  expect([...batch.values()].every((candidates) => candidates.length === 2)).toBe(true);
  expect([...batch.values()].flat().length).toBeLessThanOrEqual(64 * RENDITION_LIMITS.candidates);
  const client = await contentPool.connect();
  try {
    await client.query('BEGIN; SET LOCAL enable_seqscan = off');
    const explain = await client.query<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${RENDITION_CANDIDATES_SQL}`,
      [uses],
    );
    const nodes = flatten(explain.rows[0]['QUERY PLAN'][0].Plan);
    const cropProbe = nodes.find(
      (node) => node['Index Name'] === 'representation_width_candidates_idx',
    );
    expect(cropProbe).toBeDefined();
    expect(cropProbe!['Index Cond']).toContain('source_id');
    expect(cropProbe!['Index Cond']).toContain('COALESCE(crop');
    expect(cropProbe!['Actual Loops']).toBeLessThanOrEqual(64);
    expect(
      nodes.some(
        (node) =>
          node['Node Type'] === 'Limit' && node['Actual Rows'] <= RENDITION_LIMITS.candidates,
      ),
    ).toBe(true);
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
}, 60_000);

test('a shared rendition retains the requesting Use target, private media access and labels derived from its source', async () => {
  const fixture = await selectedImage('authority');
  const { renditions, objects, use, worker, call, owner, image, store } = fixture;
  await owner.grant(`media:owner:${owner.actor}`, 'media.labels');
  await owner.grant(`media:owner:${owner.actor}`, 'media.conceal');
  const { queued } = await requestUseRenditions(renditions, objects, use);
  for (let i = 0; i < queued; i++) await worker.tick();
  const privateTarget = await fixture.privateWork(owner.actor);
  await owner.grant(`work:read:${privateTarget.work}`, 'work.read');
  const privateUse = await otherUse(fixture, privateTarget.work, null);
  expect(await requestUseRenditions(renditions, objects, privateUse)).toEqual({ queued: 0 });
  const privateCandidates = (await renditions.candidatesBatch([privateUse])).get(privateUse)!;
  expect(privateCandidates).toHaveLength(2);
  expect((await call('GET', privateCandidates[0].url)).status).toBe(404);
  expect((await owner.read(privateCandidates[0].url)).status).toBe(200);
  const sourceLabels = await owner.send(
    'POST',
    `/v1/media/representations/${image.representation}/labels`,
    {
      actingSubject: owner.actor,
      expectedValueHead: null,
      basis: { head: null, epoch: '0', protection: null },
      field: 'nsfw',
      value: 'nsfw',
      mode: 'edit',
    },
  );
  expect(sourceLabels.status).toBe(201);
  const candidate = privateCandidates[0];
  const representation = new URL(candidate.url, 'http://main.local').pathname.split('/')[4];
  const [metadata] = await store.presentation.metadata([{ representation, use: privateUse }]);
  // A rendition shows its source's label as derived until it is labelled itself (media contract).
  expect(metadata?.metadata.nsfw).toBe('nsfw');
  expect(metadata?.metadata.nsfwSourceId).toContain(image.representation);
  expect(metadata?.target).toBe(privateTarget.work);
  const conceal = await owner.send('POST', `/v1/media/uses/${privateUse}/conceal`, {
    actingSubject: owner.actor,
    expectedValueHead: null,
    basis: { head: null, epoch: '0', protection: null },
    value: true,
    mode: 'edit',
  });
  expect(conceal.status).toBe(201);
  expect(
    (await store.presentation.metadata([{ representation, use: privateUse }]))[0]?.metadata.conceal,
  ).toBe(true);
  const asset = await store.readAsset(image.asset);
  const change = await owner.send('POST', `/v1/media/assets/${image.asset}/state`, {
    profile: 'media-asset-state-v1',
    expectedState: asset!.state,
    disclosure: 'private',
    lifecycle: 'active',
    actingSubject: owner.actor,
  });
  expect(change.status).toBe(201);
  const publicCandidate = (await renditions.candidatesBatch([use])).get(use)![0];
  expect((await call('GET', publicCandidate.url)).status).toBe(404);
  await owner.grant(`work:read:${fixture.work.work}`, 'work.read');
  const privateDownload = await owner.read(publicCandidate.url);
  expect(privateDownload.status).toBe(200);
  expect(privateDownload.headers.get('cache-control')).toBe('private, no-store');
  await privateDownload.arrayBuffer();
  const outsider = await fixture.member('outsider');
  expect((await outsider.read(publicCandidate.url)).status).toBe(404);
}, 60_000);

test('suppression markers deny retained renditions before an asset batch advances, and source unavailability denies all delivery forms', async () => {
  const fixture = await selectedImage('suppression');
  const { renditions, objects, use, worker, contentPool, store, bytes, image, call } = fixture;
  const { queued } = await requestUseRenditions(renditions, objects, use);
  for (let i = 0; i < queued; i++) await worker.tick();
  const candidates = (await renditions.candidatesBatch([use])).get(use)!;
  await store.suppressIdenticalCopies(sha(bytes), 'ffffffff-ffff-ffff-ffff-ffffffffffff', 1);
  expect((await store.readAsset(image.asset))?.moderation).toBe('none');
  expect((await renditions.candidatesBatch([use])).get(use)).toEqual([]);
  for (const candidate of candidates) {
    expect((await call('GET', candidate.url)).status).toBe(404);
    expect((await call('GET', candidate.url.split('?')[0])).status).toBe(404);
  }
  await expect(requestUseRenditions(renditions, objects, use)).rejects.toThrow();

  const unavailable = await selectedImage('unavailable', 81, 81);
  const request = await requestUseRenditions(
    unavailable.renditions,
    unavailable.objects,
    unavailable.use,
  );
  for (let i = 0; i < request.queued; i++) await unavailable.worker.tick();
  const available = (await unavailable.renditions.candidatesBatch([unavailable.use])).get(
    unavailable.use,
  )!;
  await contentPool.query(
    "UPDATE media.representation SET availability = 'unavailable' WHERE id = $1",
    [unavailable.image.representation],
  );
  expect(
    (await unavailable.renditions.candidatesBatch([unavailable.use])).get(unavailable.use),
  ).toEqual([]);
  for (const candidate of available) expect((await call('GET', candidate.url)).status).toBe(404);
}, 60_000);

test('expired and replaced lease tokens cannot persist output; re-leasing settles once with no upscaling', async () => {
  const { renditions, objects, use, contentPool, bytes } = await selectedImage('lease', 31, 23);
  expect(await requestUseRenditions(renditions, objects, use)).toEqual({ queued: 2 });
  const first = (await renditions.leaseNext(30))!;
  expect(first).not.toBeNull();
  await Bun.sleep(40);
  const output = await transformer.transform(bytes, first.mediaType, {
    profile: first.profile,
    crop: first.crop,
  });
  expect(output).toMatchObject({ width: 31, height: 23 });
  let puts = 0;
  const persist = async () => {
    puts++;
    return objects(first.namespace).put(output.bytes);
  };
  expect(await renditions.settle(first, output, persist)).toBe(false);
  expect(puts).toBe(0);
  const second = (await renditions.leaseNext())!;
  expect(second.job).toBe(first.job);
  expect(second.token).not.toBe(first.token);
  expect(second.attempt).toBe(2);
  expect(await renditions.settle(first, output, persist)).toBe(false);
  expect(await renditions.settle(second, output, persist)).toBe(true);
  expect(await renditions.settle(second, output, persist)).toBe(false);
  expect(puts).toBe(1);
  expect(
    (
      await contentPool.query('SELECT id FROM media.representation WHERE transform_job_id = $1', [
        first.job,
      ])
    ).rowCount,
  ).toBe(1);
  const remaining = (await renditions.leaseNext())!;
  const next = await transformer.transform(bytes, remaining.mediaType, {
    profile: remaining.profile,
    crop: remaining.crop,
  });
  expect(
    await renditions.settle(remaining, next, () => objects(remaining.namespace).put(next.bytes)),
  ).toBe(true);
  expect((await renditions.candidatesBatch([use])).get(use)).toHaveLength(2);
}, 60_000);

test('an object storage outage retries after lease expiry and sixteen interrupted attempts retire durably', async () => {
  const fixture = await selectedImage('recovery', 32, 32);
  const { renditions, objects, use, contentPool, bytes } = fixture;
  await requestUseRenditions(renditions, objects, use);
  const outputs = await Promise.all(
    ['avif', 'webp'].map((codec) =>
      transformer.transform(bytes, 'image/png', {
        profile: `image-width-32-${codec}-v1`,
        crop: null,
      }),
    ),
  );
  class ShortLeaseStore extends MediaRenditionStore {
    override leaseCrop() {
      return super.leaseCrop(100);
    }
  }
  const failed = new MediaRenditionWorker(
    new ShortLeaseStore(contentPool),
    {
      inspect: transformer.inspect.bind(transformer),
      transform: async (_bytes, _type, plan) =>
        outputs.find((output) => output.type === parseProfile(plan.profile).type)!,
      transformCrop: async (_bytes, _type, plans) =>
        plans.map((plan) =>
          outputs.find((output) => output.type === parseProfile(plan.profile).type)!,
        ),
    },
    (namespace) => ({
      get: (digest) => objects(namespace).get(digest),
      put: async () => {
        throw new Error('object outage');
      },
    }),
  );
  await failed.tick();
  const interrupted = (
    await contentPool.query(
      'SELECT id,status FROM media.transform_job WHERE source_id = $1 AND profile <> \'required-image-match-v1\' ORDER BY created_at,id',
      [fixture.image.representation],
    )
  ).rows[0];
  expect(interrupted.status).toBe('leased');
  expect((await renditions.candidatesBatch([use])).get(use)).toEqual([]);
  await Bun.sleep(120);
  await fixture.worker.tick();
  expect(
    (
      await contentPool.query('SELECT status,attempt FROM media.transform_job WHERE id = $1', [
        interrupted.id,
      ])
    ).rows[0],
  ).toEqual({ status: 'succeeded', attempt: 2 });
  await fixture.worker.tick();

  const exhausted = await selectedImage('exhaustion', 33, 33);
  await requestUseRenditions(exhausted.renditions, exhausted.objects, exhausted.use);
  let job = '';
  for (let attempt = 1; attempt <= RENDITION_LIMITS.attempts; attempt++) {
    const lease = (await exhausted.renditions.leaseNext(30))!;
    if (attempt === 1) job = lease.job;
    expect(lease.job).toBe(job);
    expect(lease.attempt).toBe(attempt);
    await Bun.sleep(40);
  }
  expect(await exhausted.renditions.leaseNext()).toBeNull();
  expect(
    (
      await contentPool.query(
        'SELECT status,reason,settle_operation_id FROM media.transform_job WHERE id = $1',
        [job],
      )
    ).rows[0],
  ).toMatchObject({
    status: 'failed',
    reason: 'attempts-exhausted',
    settle_operation_id: `media-rendition-settle:${job}`,
  });
  expect(
    await requestUseRenditions(exhausted.renditions, exhausted.objects, exhausted.use),
  ).toEqual({ queued: 0 });
  await exhausted.worker.tick();
}, 60_000);

test('erasure during decoding refuses activation, and erasure waits for an in-flight fenced object put', async () => {
  const fixture = await selectedImage('erase', 34, 34);
  const { renditions, objects, use, contentPool, owner, image, store, bytes, call } = fixture;
  await requestUseRenditions(renditions, objects, use);
  const lease = (await renditions.leaseNext())!;
  const output = await transformer.transform(bytes, lease.mediaType, {
    profile: lease.profile,
    crop: lease.crop,
  });
  let signalPut!: () => void;
  let releasePut!: () => void;
  const putting = new Promise<void>((resolve) => {
    signalPut = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releasePut = resolve;
  });
  const settled = renditions.settle(lease, output, async () => {
    signalPut();
    await release;
    return objects(lease.namespace).put(output.bytes);
  });
  await putting;
  const asset = (await store.readAsset(image.asset))!;
  let erased = false;
  const erasure = owner
    .send('POST', `/v1/media/assets/${image.asset}/state`, {
      profile: 'media-asset-state-v1',
      expectedState: asset.state,
      disclosure: 'public',
      lifecycle: 'erased',
      actingSubject: owner.actor,
    })
    .then((response) => {
      erased = true;
      return response;
    });
  await Bun.sleep(100);
  expect(erased).toBe(false);
  releasePut();
  expect(await settled).toBe(true);
  expect((await erasure).status).toBe(201);
  expect((await renditions.candidatesBatch([use])).get(use)).toEqual([]);
  const representations = await contentPool.query<{ id: string; availability: string }>(
    'SELECT id,availability FROM media.representation WHERE asset_id = $1',
    [image.asset],
  );
  expect(representations.rows.every((row) => row.availability === 'erased')).toBe(true);
  for (const row of representations.rows)
    expect((await call('GET', `/v1/media/representations/${row.id}/bytes?use=${use}`)).status).toBe(
      404,
    );
  expect(
    await renditions.settle(lease, output, async () => {
      throw new Error('erased source must not put');
    }),
  ).toBe(false);
  await fixture.worker.tick();
  expect(
    (
      await contentPool.query(
        "SELECT status FROM media.transform_job WHERE source_id = $1 AND status <> 'succeeded'",
        [image.representation],
      )
    ).rows[0].status,
  ).toBe('cancelled');

  const decoding = await selectedImage('decode-erase', 35, 35);
  await requestUseRenditions(decoding.renditions, decoding.objects, decoding.use);
  let puts = 0;
  const revokeDuringDecode = new MediaRenditionWorker(
    decoding.renditions,
    {
      inspect: transformer.inspect.bind(transformer),
      transform: transformer.transform.bind(transformer),
      transformCrop: async (input, type, plans, signal) => {
        const asset = (await decoding.store.readAsset(decoding.image.asset))!;
        const response = await decoding.owner.send(
          'POST',
          `/v1/media/assets/${decoding.image.asset}/state`,
          {
            profile: 'media-asset-state-v1',
            expectedState: asset.state,
            disclosure: 'public',
            lifecycle: 'erased',
            actingSubject: decoding.owner.actor,
          },
        );
        expect(response.status).toBe(201);
        return transformer.transformCrop(input, type, plans, signal);
      },
    },
    (namespace) => ({
      get: (digest) => objects(namespace).get(digest),
      put: async (data) => {
        puts++;
        return objects(namespace).put(data);
      },
    }),
  );
  await revokeDuringDecode.tick();
  expect(puts).toBe(0);
  expect((await decoding.store.readAsset(decoding.image.asset))?.lifecycle).toBe('erased');
  expect((await decoding.renditions.candidatesBatch([decoding.use])).get(decoding.use)).toEqual([]);
  expect(
    (
      await contentPool.query(
        "SELECT id FROM media.representation WHERE source_id = $1 AND kind = 'rendition'",
        [decoding.image.representation],
      )
    ).rowCount,
  ).toBe(0);
}, 60_000);
