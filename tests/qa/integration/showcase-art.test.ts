import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { MediaRenditionWorker } from '../../../services/main/src/modules/media-rendition/worker.ts';
import { LocalImageTransformer } from '../../../services/main/src/modules/media-rendition/transform.ts';
import { SHOWCASE_BATCH_SQL } from '../../../services/main/src/modules/media/showcase-store.ts';
import { configureDisclosure } from '../../../services/main/src/modules/disclosure/read.ts';
import type { ShowcaseArt } from '../../../services/main/src/modules/media/showcase-contract.ts';
import { startMediaStack, type MediaStack } from './media-support.ts';
import { requireQa } from './recommendation-support.ts';
import { cloneQaOwnerDatabases } from '../support/databases.ts';

let started: Promise<MediaStack> | undefined;
// One migrated template copy per file keeps the actual rendition queue isolated
// from jobs left by preceding files, without building new background data.
const stack = () =>
  (started ??= (async () => {
    const owners = await cloneQaOwnerDatabases(requireQa(), ['access', 'content', 'relay'], 'privileged');
    try {
      const fixture = await startMediaStack('showcase-art', { ownerUrls: owners.urls });
      return {
        ...fixture,
        stop: async () => {
          try {
            await fixture.stop();
          } finally {
            await owners.close();
          }
        },
      };
    } catch (error) {
      await owners.close();
      throw error;
    }
  })());
afterAll(async () => {
  if (started) await (await started).stop();
});
const artPath = (work: string) => `/v1/resources/${work.split('/').at(-1)}/showcase/art`;
const trailerPath = (work: string) => `/v1/resources/${work.split('/').at(-1)}/showcase/trailer`;
async function image(width: number, height: number, alpha = true) {
  return sharp({
    create: {
      width,
      height,
      channels: alpha ? 4 : 3,
      background: { r: 20, g: 40, b: 60, ...(alpha ? { alpha: 0.5 } : {}) },
    },
  })
    .png()
    .toBuffer();
}
async function status(response: Response, expected: number) {
  if (response.status !== expected)
    throw new Error(`expected ${expected}, got ${response.status}: ${await response.text()}`);
  return response;
}
async function read(targets: string[], context?: string) {
  const response = await status(
    await (
      await stack()
    ).call('POST', '/v1/resources/showcase', {
      body: { profile: 'work-showcase-batch-v1', targets, ...(context ? { context } : {}) },
    }),
    200,
  );
  return (await response.json()) as {
    items: Array<ShowcaseArt | { reference: string; status: 'unavailable' }>;
    generation: { media: string };
    cost: { mediaQueries: number; graphQueries: number; accessQueries: number };
  };
}
function available(item: ShowcaseArt | { reference: string; status: 'unavailable' }): ShowcaseArt {
  expect(item.status).toBe('available');
  return item as ShowcaseArt;
}

test('showcase selection reuses avatar authority, exact Use bases, idempotency, CAS and immediate removal', async () => {
  const fixture = await stack();
  const { member, publicWork, accessPool, contentPool, call, store, objects } = fixture;
  const owner = await member('selection-owner');
  const outsider = await member('selection-outsider');
  const work = await publicWork(owner.actor);
  const asset = await owner.upload(await image(1280, 720));
  const body = {
    profile: 'work-showcase-selection-v1',
    expectedSelection: null,
    asset: asset.asset,
    role: 'background-landscape',
    crop: 'xywh=percent:0,0,100,100',
    focalArea: 'xywh=percent:10,10,20,20',
    actingSubject: owner.actor,
  };
  await accessPool.query('INSERT INTO access.scope_gate(id) VALUES ($1)', [
    `media:avatar:${work.work}`,
  ]);
  const before = (
    await contentPool.query('SELECT count(*)::int AS n FROM media.selection_revision')
  ).rows[0].n;
  await status(await owner.send('PUT', artPath(work.work), body), 403);
  await status(
    await outsider.send('PUT', artPath(work.work), { ...body, actingSubject: outsider.actor }),
    403,
  );
  expect(
    (await contentPool.query('SELECT count(*)::int AS n FROM media.selection_revision')).rows[0].n,
  ).toBe(before);
  await owner.grant(`media:avatar:${work.work}`, 'media.avatar');
  const key = `showcase-${randomUUID()}`;
  const selected = (await (
    await status(await owner.send('PUT', artPath(work.work), body, key), 201)
  ).json()) as { selection: string };
  expect(
    await (await status(await owner.send('PUT', artPath(work.work), body, key), 200)).json(),
  ).toMatchObject({ selection: selected.selection, replayed: true });
  await status(await owner.send('PUT', artPath(work.work), { ...body, focalArea: null }, key), 409);
  const basis = (
    await contentPool.query(
      `SELECT u.*,revision.body FROM media.selection_revision s
    JOIN media.use u ON u.id=s.use_id JOIN content.revision revision ON revision.id=u.asset_revision_id WHERE s.id=$1`,
      [selected.selection],
    )
  ).rows[0];
  expect(basis).toMatchObject({
    role: 'showcase-background-landscape',
    asset_revision_id: asset.revision,
    representation_id: asset.representation,
    focal_area: body.focalArea,
    oriented_width: 1280,
    oriented_height: 720,
  });
  const first = available((await read([work.work])).items[0]).images[0];
  expect(first).toMatchObject({
    selection: selected.selection,
    role: 'background-landscape',
    width: 1280,
    height: 720,
    crop: body.crop,
    focalArea: body.focalArea,
    srcset: [],
  });
  await status(await call('GET', first.url), 200);
  // Both codecs become candidates from the actual selected Use, with no second
  // producer call from the client. The owner worker executes real native bytes.
  const worker = new MediaRenditionWorker(store.renditions, new LocalImageTransformer(), objects);
  await worker.tick();
  const rendered = available((await read([work.work])).items[0]).images[0];
  expect(rendered.srcset.length).toBe(8);
  expect([...new Set(rendered.srcset.map((candidate) => candidate.type))].sort()).toEqual([
    'image/avif',
    'image/webp',
  ]);
  for (const candidate of rendered.srcset) await status(await call('GET', candidate.url), 200);

  const staleKey = `stale-${randomUUID()}`;
  const stale = await (
    await status(await owner.send('PUT', artPath(work.work), body, staleKey), 409)
  ).json();
  expect(stale).toMatchObject({ current: selected.selection, code: 'stale_head' });
  const replacements = await Promise.all([
    owner.send('PUT', artPath(work.work), {
      ...body,
      expectedSelection: selected.selection,
      focalArea: 'xywh=percent:20,20,10,10',
    }),
    owner.send('PUT', artPath(work.work), {
      ...body,
      expectedSelection: selected.selection,
      focalArea: null,
    }),
  ]);
  expect(replacements.map((response) => response.status).sort()).toEqual([201, 409]);
  const winner = (await replacements.find((response) => response.status === 201)!.json()) as {
    selection: string;
  };
  expect(available((await read([work.work])).items[0]).images[0].selection).toBe(winner.selection);
  await status(await call('GET', first.url), 404);
  await status(await call('GET', rendered.srcset[0].url), 404);
  // A durable stale retry preserves the head observed by the failed command,
  // even after a later successful replacement changes the current slot.
  expect(
    await (await status(await owner.send('PUT', artPath(work.work), body, staleKey), 409)).json(),
  ).toMatchObject({ current: selected.selection, replayed: true });
  const removed = (await (
    await status(
      await owner.send('PUT', artPath(work.work), {
        ...body,
        expectedSelection: winner.selection,
        asset: null,
        crop: null,
        focalArea: null,
      }),
      201,
    )
  ).json()) as { selection: string };
  expect(available((await read([work.work])).items[0]).images).toEqual([]);
  expect(
    (
      await contentPool.query('SELECT use_id FROM media.selection_revision WHERE id=$1', [
        removed.selection,
      ])
    ).rows[0].use_id,
  ).toBeNull();
  const sealed = await accessPool.query(
    `SELECT state,graph_outcome FROM access.admission WHERE idempotency_key=$1`,
    [key],
  );
  expect(sealed.rows[0]).toMatchObject({ state: 'sealed', graph_outcome: 'succeeded' });
}, 120_000);

test('showcase admission refuses wrong ratios, small crops, missing alpha and foreign assets without owner effects', async () => {
  const { member, publicWork, contentPool } = await stack();
  const owner = await member('admission-owner');
  const other = await member('admission-other');
  const work = await publicWork(owner.actor);
  await owner.grant(`media:avatar:${work.work}`, 'media.avatar');
  const opaque = await owner.upload(await image(1280, 720, false));
  const transparent = await owner.upload(await image(1280, 720));
  const foreign = await other.upload(await image(1280, 720));
  const small = await owner.upload(await image(1264, 711));
  const body = {
    profile: 'work-showcase-selection-v1',
    expectedSelection: null,
    asset: opaque.asset,
    role: 'background-landscape',
    actingSubject: owner.actor,
  };
  const count = (await contentPool.query('SELECT count(*)::int AS n FROM media.use')).rows[0].n;
  for (const [change, code] of [
    [{ crop: 'xywh=percent:0,0,99,100' }, 'showcase_ratio_mismatch'],
    [{ asset: small.asset }, 'showcase_resolution_too_small'],
    [{ crop: 'xywh=percent:0,0,101,100' }, 'showcase_crop_invalid'],
    [{ role: 'cutout' }, 'showcase_alpha_required'],
    [
      { role: 'logo', language: 'en', tone: 'light', anchor: 'center-bottom' },
      'showcase_alpha_required',
    ],
  ] as const)
    expect(
      await (
        await status(await owner.send('PUT', artPath(work.work), { ...body, ...change }), 422)
      ).json(),
    ).toMatchObject({ code });
  await status(await owner.send('PUT', artPath(work.work), { ...body, asset: foreign.asset }), 404);
  expect((await contentPool.query('SELECT count(*)::int AS n FROM media.use')).rows[0].n).toBe(
    count,
  );
  const logo = {
    ...body,
    role: 'logo',
    asset: transparent.asset,
    language: 'ZH-hant',
    tone: 'dark',
    anchor: 'center-top',
  };
  const head = (await (
    await status(await owner.send('PUT', artPath(work.work), logo), 201)
  ).json()) as { selection: string };
  await status(
    await owner.send('PUT', artPath(work.work), {
      ...logo,
      language: 'zh-Hant',
      anchor: 'center-bottom',
    }),
    409,
  );
  await status(
    await owner.send('PUT', artPath(work.work), { ...logo, language: 'zxx', tone: 'light' }),
    201,
  );
  await status(
    await owner.send('PUT', artPath(work.work), {
      ...body,
      role: 'cutout',
      asset: transparent.asset,
    }),
    201,
  );
  const art = available((await read([work.work])).items[0]);
  expect(art.images.filter((item) => item.role === 'logo')).toHaveLength(2);
  expect(art.images.find((item) => item.selection === head.selection)).toMatchObject({
    language: 'zh-Hant',
    tone: 'dark',
    anchor: 'center-top',
  });
}, 120_000);

test('showcase reads preserve per-key context removal and conceal hidden, erased and unreadable art in a fixed-cost batch', async () => {
  const { member, publicWork, privateWork, contentPool, fuseki, mediaAccess, store } =
    await stack();
  const owner = await member('context-owner');
  const work = await publicWork(owner.actor);
  const context = `https://rezics.com/id/${randomUUID()}`;
  await owner.grant(`media:avatar:${work.work}`, 'media.avatar');
  const asset = await owner.upload(await image(960, 1280));
  const body = {
    profile: 'work-showcase-selection-v1',
    expectedSelection: null,
    asset: asset.asset,
    role: 'background-portrait',
    actingSubject: owner.actor,
  };
  await status(await owner.send('PUT', artPath(work.work), body), 201);
  expect(available((await read([work.work], context)).items[0]).images).toHaveLength(1);
  const override = (await (
    await status(await owner.send('PUT', artPath(work.work), { ...body, context }), 201)
  ).json()) as { selection: string };
  expect(available((await read([work.work], context)).items[0]).images[0]).toMatchObject({
    context,
    selection: override.selection,
  });
  await status(
    await owner.send('PUT', artPath(work.work), {
      ...body,
      context,
      expectedSelection: override.selection,
      asset: null,
    }),
    201,
  );
  expect(available((await read([work.work], context)).items[0]).images).toEqual([]);
  expect(available((await read([work.work])).items[0]).images).toHaveLength(1);
  const beforeHide = available((await read([work.work])).items[0]).images[0];
  const hidden = await (
    await status(
      await owner.send('POST', `/v1/media/assets/${asset.asset}/state`, {
        profile: 'media-asset-state-v1',
        expectedState: asset.stateHead,
        disclosure: 'private',
        lifecycle: 'active',
        actingSubject: owner.actor,
      }),
      201,
    )
  ).json();
  expect(available((await read([work.work])).items[0]).images).toEqual([]);
  await status(await (await stack()).call('GET', beforeHide.url), 404);
  await status(
    await owner.send('POST', `/v1/media/assets/${asset.asset}/state`, {
      profile: 'media-asset-state-v1',
      expectedState: hidden.id,
      disclosure: 'public',
      lifecycle: 'erased',
      actingSubject: owner.actor,
    }),
    201,
  );
  expect(available((await read([work.work])).items[0]).images).toEqual([]);
  const privateTarget = await privateWork(owner.actor);
  const targets = [
    work.work,
    privateTarget.work,
    ...Array.from({ length: 62 }, () => `https://rezics.com/id/${randomUUID()}`),
  ];
  const original = contentPool.query.bind(contentPool);
  let mediaQueries = 0;
  const querySpy = (...args: Parameters<typeof original>) => {
    if (args[0] === SHOWCASE_BATCH_SQL) mediaQueries++;
    return original(...args);
  };
  contentPool.query = querySpy as typeof contentPool.query;
  const graphBefore = fuseki.queries;
  const accessBefore = mediaAccess.batches;
  try {
    const batch = await read(targets);
    expect(batch.items).toHaveLength(64);
    expect(batch.items[1]).toEqual({ reference: privateTarget.work, status: 'unavailable' });
    expect(batch.cost).toMatchObject({ mediaQueries: 1, accessQueries: 0 });
    expect(mediaQueries).toBe(1);
    expect(fuseki.queries - graphBefore).toBeLessThanOrEqual(4);
    expect(mediaAccess.batches - accessBefore).toBe(0);
  } finally {
    contentPool.query = original;
  }
  // Small fixtures can prefer sequential scans. Prove that the production
  // predicates admit the exact slot and source/crop indexes too.
  const planner = await contentPool.connect();
  try {
    await planner.query('BEGIN; SET LOCAL enable_seqscan=off');
    const plan = (
      await planner.query(`EXPLAIN (FORMAT JSON) ${SHOWCASE_BATCH_SQL}`, [
        targets,
        [context, 'urn:rezics:media:context:default'],
      ])
    ).rows[0]['QUERY PLAN'][0];
    const indexes = JSON.stringify(plan);
    expect(indexes).toContain('selection_showcase_target_idx');
    expect(indexes).toContain('representation_width_candidates_idx');
    expect(indexes).toContain('selection_revision_pkey');
  } finally {
    await planner.query('ROLLBACK');
    planner.release();
  }
  expect((await store.showcase.readBatch([work.work], context)).art.get(work.work)?.images).toEqual(
    [],
  );
  await status(
    await (
      await stack()
    ).call('POST', '/v1/resources/showcase', {
      body: { profile: 'work-showcase-batch-v1', targets: [...targets, targets[0]] },
    }),
    400,
  );
}, 120_000);

test('showcase trailers share selection authority, canonical retries, replace, removal and context precedence', async () => {
  const { member, publicWork } = await stack();
  const owner = await member('trailer-owner');
  const work = await publicWork(owner.actor);
  await owner.grant(`media:avatar:${work.work}`, 'media.avatar');
  const body = {
    profile: 'work-showcase-trailer-v1',
    expectedSelection: null,
    url: 'https://youtu.be/dQw4w9WgXcQ?si=track',
    actingSubject: owner.actor,
  };
  const key = `trailer-${randomUUID()}`;
  const first = (await (
    await status(await owner.send('PUT', trailerPath(work.work), body, key), 201)
  ).json()) as { selection: string };
  expect(available((await read([work.work])).items[0]).trailer).toMatchObject({
    selection: first.selection,
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    provider: 'youtube',
  });
  await status(
    await owner.send(
      'PUT',
      trailerPath(work.work),
      { ...body, url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
      key,
    ),
    200,
  );
  const second = (await (
    await status(
      await owner.send('PUT', trailerPath(work.work), {
        ...body,
        expectedSelection: first.selection,
        url: 'https://www.bilibili.com/video/BV1La411N7Nd/?p=2&spm=track',
      }),
      201,
    )
  ).json()) as { selection: string };
  expect(available((await read([work.work])).items[0]).trailer).toMatchObject({
    url: 'https://www.bilibili.com/video/BV1La411N7Nd/?p=2',
    provider: 'bilibili',
  });
  const context = `https://rezics.com/id/${randomUUID()}`;
  await status(
    await owner.send('PUT', trailerPath(work.work), { ...body, context, url: null }),
    201,
  );
  expect(available((await read([work.work], context)).items[0]).trailer).toBeNull();
  expect(available((await read([work.work])).items[0]).trailer).not.toBeNull();
  await status(
    await owner.send('PUT', trailerPath(work.work), {
      ...body,
      expectedSelection: second.selection,
      url: null,
    }),
    201,
  );
  expect(available((await read([work.work])).items[0]).trailer).toBeNull();
}, 120_000);

test('a lost rendition request or Access reconciliation replays the committed showcase selection without duplicate effects', async () => {
  const fixture = await stack();
  const { member, publicWork, store, contentPool, accessPool, access } = fixture;
  const owner = await member('recovery-owner');
  const work = await publicWork(owner.actor);
  await owner.grant(`media:avatar:${work.work}`, 'media.avatar');
  const asset = await owner.upload(await image(32, 32));
  const body = {
    profile: 'work-showcase-selection-v1',
    expectedSelection: null,
    asset: asset.asset,
    role: 'cutout',
    actingSubject: owner.actor,
  };
  const key = `recovery-${randomUUID()}`;
  const queue = store.renditions.queue.bind(store.renditions);
  store.renditions.queue = async () => {
    throw new Error('rendition queue unavailable');
  };
  try {
    await status(await owner.send('PUT', artPath(work.work), body, key), 503);
  } finally {
    store.renditions.queue = queue;
  }
  const committed = (
    await contentPool.query(
      `SELECT head FROM media.selection_slot WHERE target=$1 AND role='showcase-cutout'`,
      [work.work],
    )
  ).rows[0].head;
  expect(
    (
      await contentPool.query(
        'SELECT count(*)::int AS n FROM media.transform_job WHERE source_id=$1',
        [asset.representation],
      )
    ).rows[0].n,
  ).toBe(0);
  expect(
    await (await status(await owner.send('PUT', artPath(work.work), body, key), 200)).json(),
  ).toMatchObject({ selection: committed, replayed: true });
  expect(
    (
      await contentPool.query(
        'SELECT count(*)::int AS n FROM media.transform_job WHERE source_id=$1',
        [asset.representation],
      )
    ).rows[0].n,
  ).toBe(2);
  expect(
    (await accessPool.query('SELECT state FROM access.admission WHERE idempotency_key=$1', [key]))
      .rows[0].state,
  ).toBe('sealed');

  const sealingKey = `reconcile-${randomUUID()}`;
  const seal = access.recordGraphOutcome.bind(access);
  access.recordGraphOutcome = async () => {
    throw new Error('Access unavailable');
  };
  const replacement = {
    ...body,
    expectedSelection: committed,
    focalArea: 'xywh=percent:10,10,10,10',
  };
  try {
    await status(await owner.send('PUT', artPath(work.work), replacement, sealingKey), 503);
  } finally {
    access.recordGraphOutcome = seal;
  }
  const retry = (await (
    await status(await owner.send('PUT', artPath(work.work), replacement, sealingKey), 200)
  ).json()) as { selection: string };
  expect(retry.selection).not.toBe(committed);
  expect(
    (
      await contentPool.query(
        'SELECT count(*)::int AS n FROM media.transform_job WHERE source_id=$1',
        [asset.representation],
      )
    ).rows[0].n,
  ).toBe(2);
  expect(
    (
      await contentPool.query(
        `SELECT count(*)::int AS n FROM media.selection_revision WHERE target=$1 AND role='showcase-cutout'`,
        [work.work],
      )
    ).rows[0].n,
  ).toBe(2);
}, 120_000);

test('shared media disclosure conceals showcase Uses and assets on both batch and representation delivery', async () => {
  const fixture = await stack();
  const { member, publicWork, call, env } = fixture;
  const owner = await member('disclosure-owner');
  const work = await publicWork(owner.actor);
  await owner.grant(`media:avatar:${work.work}`, 'media.avatar');
  const asset = await owner.upload(await image(40, 40));
  await status(
    await owner.send('PUT', artPath(work.work), {
      profile: 'work-showcase-selection-v1',
      expectedSelection: null,
      asset: asset.asset,
      role: 'cutout',
      actingSubject: owner.actor,
    }),
    201,
  );
  const art = available((await read([work.work])).items[0]).images[0];
  const hidden = new Set<string>();
  let mediaBatches = 0;
  configureDisclosure(env, {
    read: async (targets, _viewer, channel) => {
      if (channel === 'media') mediaBatches++;
      return targets.map((target) =>
        target.owner === 'media' && hidden.has(target.resource) ? 'hidden' : 'visible',
      );
    },
  });
  try {
    hidden.add(`https://rezics.com/id/${art.use}`);
    expect(available((await read([work.work])).items[0]).images).toEqual([]);
    await status(await call('GET', art.url), 404);
    hidden.clear();
    expect(available((await read([work.work])).items[0]).images).toHaveLength(1);
    await status(await call('GET', art.url), 200);
    hidden.add(`https://rezics.com/id/${asset.asset}`);
    expect(available((await read([work.work])).items[0]).images).toEqual([]);
    await status(await call('GET', art.url), 404);
    await status(await call('GET', `/v1/media/representations/${asset.representation}/bytes`), 404);
    expect(mediaBatches).toBeGreaterThanOrEqual(7);
  } finally {
    configureDisclosure(env, null);
  }
}, 120_000);
