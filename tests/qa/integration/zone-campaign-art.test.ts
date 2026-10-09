import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { S3ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { readZoneConfiguration } from '../../../services/main/src/modules/zone/configuration.ts';
import { DEFAULT_ZONE_PRESENTATION } from '../../../services/main/src/modules/zone/presentation-format.ts';
import { MediaRenditionWorker } from '../../../services/main/src/modules/media-rendition/worker.ts';
import { LocalImageTransformer } from '../../../services/main/src/modules/media-rendition/transform.ts';
import { CAMPAIGN_ART_CREATE_COST } from '../../../services/main/src/modules/media/commands.ts';
import { startMediaStack, type MediaStack } from './media-support.ts';
import { requireQa } from './recommendation-support.ts';
import { cloneQaOwnerDatabases } from '../support/databases.ts';

let started: Promise<MediaStack> | undefined;
const stack = () => started ??= (async () => {
  const owners = await cloneQaOwnerDatabases(requireQa(), ['access', 'content', 'relay'], 'privileged');
  try {
    const fixture = await startMediaStack('zone-campaign-art', { ownerUrls: owners.urls });
    return { ...fixture, stop: async () => { try { await fixture.stop(); } finally { await owners.close(); } } };
  } catch (error) { await owners.close(); throw error; }
})();
afterAll(async () => { if (started) await (await started).stop(); });
const ref = () => `https://rezics.com/id/${randomUUID()}`;
async function json<T = Record<string, unknown>>(response: Response, expected = 200): Promise<T> {
  const body = await response.text();
  expect(response.status, body).toBe(expected);
  return JSON.parse(body) as T;
}
async function image(width: number, height: number, alpha = true) {
  return sharp({ create: { width, height, channels: alpha ? 4 : 3,
    background: { r: 20, g: 40, b: 60, ...(alpha ? { alpha: 0.5 } : {}) } } }).png().toBuffer();
}
async function fixture(label: string) {
  const s = await stack();
  const structures = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!, bucket: Bun.env.MAIN_S3_BUCKET!,
    region: Bun.env.MAIN_S3_REGION!, accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
    prefix: 'semantic/structure/' });
  await structures.initialize();
  (s.env as typeof s.env & { structureObjects: S3ImmutableObjects }).structureObjects = structures;
  const moderator = await s.member(label);
  await moderator.grant('space:create:root', 'space.create');
  const space = await json<{ space: string; realm: string }>(await moderator.send('POST', '/v1/spaces', {
    profile: 'space-realm-v1', name: label, capabilities: ['realm'], actingSubject: moderator.actor,
  }), 201);
  const zone = ref();
  await moderator.grant(`zone:edit:${zone}`, 'zone.edit');
  await json(await moderator.send('POST', '/v1/zones', { zone, space: space.space,
    disclosure: 'public', actingSubject: moderator.actor }), 201);
  const path = `/v1/zones/${zone.slice(-36)}`;
  const create = (body: Record<string, unknown>, key?: string) => moderator.send('POST', `${path}/campaign-art`, {
    profile: 'zone-campaign-art-v1', realm: space.realm, actingSubject: moderator.actor, ...body,
  }, key);
  return { ...s, ...space, zone, path, moderator, create };
}

test('Zone moderators create independent campaign Uses, retry exactly once, configure a link slide and read srcset', async () => {
  const f = await fixture('campaign-create');
  const asset = await f.moderator.upload(await image(1280, 1440));
  const body = { asset: asset.asset, role: 'background-landscape', crop: 'xywh=percent:0,0,100,50',
    focalArea: 'xywh=percent:10,10,20,20' };
  const key = randomUUID();
  const graphBefore = f.fuseki.queries;
  const first = await json<{ id: string }>(await f.create(body, key), 201);
  expect(f.fuseki.queries - graphBefore).toBe(CAMPAIGN_ART_CREATE_COST.ownerGraphQueries);
  expect(await json(await f.create(body, key))).toMatchObject({ id: first.id, replayed: true });
  expect(await json(await f.create({ ...body, focalArea: null }, key), 409)).toMatchObject({ code: 'idempotency_conflict' });
  const second = await json<{ id: string }>(await f.create(body), 201);
  expect(second.id).not.toBe(first.id);
  const concurrentKey = randomUUID();
  const simultaneous = await Promise.all([f.create(body, concurrentKey), f.create(body, concurrentKey)]);
  expect(simultaneous.map(response => response.status).sort()).toEqual([200, 201]);
  const concurrent = await Promise.all(simultaneous.map(response => response.json() as Promise<{ id: string }>));
  expect(concurrent[0]!.id).toBe(concurrent[1]!.id);
  expect((await f.contentPool.query('SELECT id FROM media.use WHERE asset_id=$1', [asset.asset])).rows).toHaveLength(3);
  const rows = (await f.contentPool.query('SELECT * FROM media.use WHERE id=ANY($1::uuid[])', [[first.id, second.id]])).rows;
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({ target: f.realm, role: 'campaign-background-landscape', crop: body.crop,
    focal_area: body.focalArea, oriented_width: 1280, oriented_height: 1440 });
  expect((await f.contentPool.query('SELECT head FROM media.selection_slot WHERE target=$1', [f.realm])).rows).toHaveLength(0);
  const presentation = { ...DEFAULT_ZONE_PRESENTATION, slides: [{ id: 'launch', href: '/campaign',
    title: 'Launch', art: { landscape: { use: `https://rezics.com/id/${first.id}` } } }] };
  await json(await f.moderator.send('PUT', `${f.path}/configuration`, {
    expectedHead: (await readZoneConfiguration(f.env, f.zone)).revision, defaultRealm: f.realm,
    presentation, actingSubject: f.moderator.actor,
  }));
  const jobs = await f.contentPool.query('SELECT id FROM media.transform_job WHERE source_id=$1', [asset.representation]);
  expect(jobs.rows).toHaveLength(8);
  expect(jobs.rows.length).toBeLessThanOrEqual(CAMPAIGN_ART_CREATE_COST.maxRenditionRequests);
  const worker = new MediaRenditionWorker(f.store.renditions, new LocalImageTransformer(), f.objects);
  for (let i = 0; i < jobs.rows.length; i++) await worker.tick();
  const read = await json<{ slideMedia: Array<{ art: { landscape: {
    url: string; srcset: Array<{ url: string; width: number; height: number }> } } }> }>(await f.call('GET', `${f.path}/presentation`));
  const art = read.slideMedia[0]!.art.landscape;
  expect(art).toMatchObject({ crop: body.crop, focalArea: body.focalArea, cropWidth: 1280, cropHeight: 720 });
  expect(art.srcset).toHaveLength(8);
  expect(art.srcset.every(candidate => candidate.width * 9 === candidate.height * 16)).toBe(true);
  const original = await f.call('GET', art.url);
  expect(original.status).toBe(200);
  await original.arrayBuffer();
  for (const candidate of art.srcset) {
    const response = await f.call('GET', candidate.url);
    expect(response.status).toBe(200);
    await response.arrayBuffer();
  }
}, 120_000);

test('campaign art refuses non-moderators, other Realms, wrong ratio, small images, missing alpha and unavailable assets', async () => {
  const f = await fixture('campaign-refusals');
  const outsider = await f.member('campaign-outsider');
  const own = await outsider.upload(await image(1280, 720));
  expect(await json(await outsider.send('POST', `${f.path}/campaign-art`, {
    profile: 'zone-campaign-art-v1', realm: f.realm, actingSubject: outsider.actor,
    asset: own.asset, role: 'background-landscape',
  }), 403)).toMatchObject({ code: 'authority_denied' });
  for (const [width, height, alpha, role, code] of [
    [1281, 720, true, 'background-landscape', 'showcase_ratio_mismatch'],
    [640, 360, true, 'background-landscape', 'showcase_resolution_too_small'],
    [64, 64, false, 'cutout', 'showcase_alpha_required'],
    [64, 64, false, 'logo', 'showcase_alpha_required'],
  ] as const) {
    const source = await f.moderator.upload(await image(width, height, alpha));
    expect(await json(await f.create({ asset: source.asset, role,
      ...(role === 'logo' ? { language: 'zxx', tone: 'light', anchor: 'center-top' } : {}) }), 422)).toMatchObject({ code });
    expect((await f.contentPool.query('SELECT id FROM media.use WHERE asset_id=$1', [source.asset])).rows).toHaveLength(0);
  }
  const source = await f.moderator.upload(await image(1280, 720));
  await json(await f.create({ asset: source.asset, role: 'background-landscape', realm: ref() }), 404);
  await json(await f.create({ asset: own.asset, role: 'background-landscape' }), 404);
  const privateSource = await f.moderator.upload(await image(1280, 720), 'private');
  await json(await f.create({ asset: privateSource.asset, role: 'background-landscape' }), 404);
  expect((await f.contentPool.query('SELECT id FROM media.use WHERE asset_id=$1', [source.asset])).rows).toHaveLength(0);
}, 120_000);

test('campaign rendition queue failures replay the retained Use and logo metadata is canonical', async () => {
  const f = await fixture('campaign-retry');
  const asset = await f.moderator.upload(await image(48, 48));
  const body = { asset: asset.asset, role: 'logo', language: 'ZH-hant', tone: 'light', anchor: 'center-top' };
  const key = randomUUID();
  const queue = f.store.renditions.queue.bind(f.store.renditions);
  f.store.renditions.queue = async () => { throw new Error('queue unavailable'); };
  try { await json(await f.create(body, key), 503); }
  finally { f.store.renditions.queue = queue; }
  const uses = (await f.contentPool.query('SELECT id,role,logo_anchor FROM media.use WHERE asset_id=$1', [asset.asset])).rows;
  expect(uses).toHaveLength(1);
  expect(uses[0]).toMatchObject({ role: 'campaign-logo:zh-Hant:light', logo_anchor: 'center-top' });
  expect(await json(await f.create({ ...body, language: 'zh-Hant' }, key))).toMatchObject({ id: uses[0].id, replayed: true });
  expect((await f.contentPool.query('SELECT id FROM media.use WHERE asset_id=$1', [asset.asset])).rows).toHaveLength(1);
  const cutout = await json<{ id: string }>(await f.create({ asset: asset.asset, role: 'cutout' }), 201);
  const portraitSource = await f.moderator.upload(await image(960, 1280));
  const portrait = await json<{ id: string }>(await f.create({ asset: portraitSource.asset, role: 'background-portrait' }), 201);
  await json(await f.moderator.send('PUT', `${f.path}/configuration`, {
    expectedHead: (await readZoneConfiguration(f.env, f.zone)).revision, defaultRealm: f.realm,
    presentation: { ...DEFAULT_ZONE_PRESENTATION, slides: [{ id: 'logo', href: '/launch', art: {
      logos: [{ use: `https://rezics.com/id/${uses[0].id}`, language: 'zh-Hant', tone: 'light', anchor: 'center-top' }],
      cutout: { use: `https://rezics.com/id/${cutout.id}` }, portrait: { use: `https://rezics.com/id/${portrait.id}` },
    } }] }, actingSubject: f.moderator.actor,
  }));
  expect(await json(await f.call('GET', `${f.path}/presentation`))).toMatchObject({ slideMedia: [{ art: {
    logos: [{ language: 'zh-Hant', tone: 'light', anchor: 'center-top' }],
    cutout: { width: 48, height: 48 }, portrait: { width: 960, height: 1280 },
  } }] });
}, 120_000);
