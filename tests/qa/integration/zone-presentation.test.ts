import { afterAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { fromPlainText, type DocumentSnapshot } from '@rezics/document';
import { S3ImmutableObjects, type ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { readZoneConfiguration } from '../../../services/main/src/modules/zone/configuration.ts';
import { DEFAULT_ZONE_PRESENTATION, ZONE_PRESETS, type ZonePresentation }
  from '../../../services/main/src/modules/zone/presentation-format.ts';
import { ZONE_PROFILE } from '../../../services/main/src/modules/zone/config-format.ts';
import { GRAPHS, iri, prepareComponent } from '../../../services/main/src/modules/work/activate.ts';
import { MediaRenditionWorker } from '../../../services/main/src/modules/media-rendition/worker.ts';
import { LocalImageTransformer } from '../../../services/main/src/modules/media-rendition/transform.ts';
import { startMediaStack, type MediaStack } from './media-support.ts';
import { grantRecordedPlatformUse } from '../fixtures/platform-grant.ts';

let started: Promise<MediaStack> | undefined;
// Administrator Content admissions require the fixture's live Account recheck.
const stack = () => started ??= startMediaStack('zone-presentation', { library: true });
afterAll(async () => { if (started) await (await started).stop(); });
const ref = () => `https://rezics.com/id/${randomUUID()}`;
async function json<T>(response: Response, expected = 200): Promise<T> {
  const body = await response.text();
  expect(response.status, body).toBe(expected);
  return JSON.parse(body) as T;
}

async function fixture(label: string) {
  const s = await stack();
  const structures = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!, bucket: Bun.env.MAIN_S3_BUCKET!,
    region: Bun.env.MAIN_S3_REGION!, accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
    prefix: 'semantic/structure/' });
  await structures.initialize();
  (s.env as typeof s.env & { structureObjects: ImmutableObjects }).structureObjects = structures;
  const moderator = await s.member(label);
  await moderator.grant('space:create:root', 'space.create');
  const space = await json<{ space: string; realm: string }>(await moderator.send('POST', '/v1/spaces', {
    profile: 'space-realm-v1', name: `Campaign ${label}`, capabilities: ['realm'], actingSubject: moderator.actor,
  }), 201);
  const zone = ref();
  await moderator.grant(`zone:edit:${zone}`, 'zone.edit');
  const navigation = await json<{ revision: string }>(await moderator.send('POST', '/v1/zones', {
    zone, space: space.space, disclosure: 'public', actingSubject: moderator.actor,
  }), 201);
  const path = `/v1/zones/${zone.slice(-36)}`;
  const write = async (presentation: unknown, key?: string, expectedHead?: string) => moderator.send('PUT', `${path}/configuration`, {
    expectedHead: expectedHead ?? (await readZoneConfiguration(s.env, zone)).revision,
    defaultRealm: space.realm, presentation, actingSubject: moderator.actor,
  }, key);
  const read = () => s.call('GET', `${path}/presentation`);
  const campaign = async (target = space.realm) => {
    const colour = randomUUID().replaceAll('-', '');
    const bytes = await sharp({ create: { width: 80, height: 60, channels: 4,
      background: { r: parseInt(colour.slice(0, 2), 16), g: parseInt(colour.slice(2, 4), 16),
        b: parseInt(colour.slice(4, 6), 16), alpha: 0.5 } } }).png().toBuffer();
    const image = await moderator.upload(bytes);
    const basis = await s.store.publicationBasis([image.asset], moderator.actor);
    const use = randomUUID();
    await s.store.createPublicationUses(randomUUID(), moderator.actor, target, [{ ...basis[0]!, use }]);
    return { ...image, use: `https://rezics.com/id/${use}` };
  };
  return { ...s, moderator, ...space, zone, path, navigationRevision: navigation.revision, write, read, campaign };
}

test('campaign bytes follow the exact published local Showcase instead of config or newer drafts', async () => {
  const f = await fixture('published-campaign');
  // Realm Zones use the existing administrator Content bridge, with a live
  // controller and the same resource proof used by the metadata integration.
  await f.moderator.grant(`agent:${f.moderator.actor}`, 'agent.control');
  await grantRecordedPlatformUse(f.accessPool, f.moderator.principalId, ['platform-admin'], f.moderator.actor);
  const resourceGrant = randomUUID();
  await f.accessPool.query(`INSERT INTO access.principal_permission_grant
    (id, issuer_subject, principal_id, scope_id, action, valid_until)
    VALUES ($1,$2,$3,$4,'platform:resource:zone.edit','infinity'::timestamptz)`,
  [resourceGrant, f.moderator.actor, f.moderator.principalId, `zone:edit:${f.zone}`]);
  await f.accessPool.query(`INSERT INTO access.platform_grant_episode
    (id, principal_grant_id, issuer_subject, permission, scope_id, assigned_by_principal, receipt)
    VALUES ($1,$1,$2,'platform:resource:zone.edit',$3,$4,$5)`,
  [resourceGrant, f.moderator.actor, `zone:edit:${f.zone}`, f.moderator.principalId,
    `urn:rezics:access-receipt:${createHash('sha256').update(resourceGrant).digest('hex')}`]);

  const campaign = async (red: number) => {
    const source = await f.moderator.upload(await sharp({ create: { width: 32, height: 32, channels: 4,
      background: { r: red, g: 40, b: 60, alpha: 0.5 } } }).png().toBuffer());
    const created = await json<{ id: string }>(await f.moderator.send('POST', `${f.path}/campaign-art`, {
      profile: 'zone-campaign-art-v1', realm: f.realm, asset: source.asset, role: 'cutout',
      actingSubject: f.moderator.actor,
    }), 201);
    expect(await f.store.itemDelivery(created.id)).toMatchObject({ role: 'campaign-cutout', campaignZone: f.zone });
    const worker = new MediaRenditionWorker(f.store.renditions, new LocalImageTransformer(), f.objects);
    for (let i = 0; i < 32; i++) {
      const candidates = (await f.store.renditions.candidatesBatch([created.id])).get(created.id) ?? [];
      if (candidates.length === 2) return { ...source, use: created.id, candidates,
        art: { cutout: { use: `https://rezics.com/id/${created.id}` } } };
      await worker.tick();
    }
    throw new Error('Campaign cutout renditions did not finish');
  };
  const configArt = await campaign(10);
  const firstArt = await campaign(20);
  const nextArt = await campaign(30);
  const configSlide: ZonePresentation['slides'][number] = { id: 'config', href: '/config', art: configArt.art };
  const firstSlide: ZonePresentation['slides'][number] = { id: 'first', href: '/first', art: firstArt.art };
  const nextSlide: ZonePresentation['slides'][number] = { id: 'next', href: '/next', art: nextArt.art };
  const publicRead = (path: string, headers: Record<string, string> = {}) =>
    f.main.handle(new Request(`http://main.local${path}`, { headers }));
  const delivery = async (art: Awaited<ReturnType<typeof campaign>>, expected: number,
    headers: Record<string, string> = {}) => {
    for (const path of [`/v1/media/uses/${art.use}`,
      `/v1/media/representations/${art.representation}/bytes?use=${art.use}`,
      ...art.candidates.map(candidate => candidate.url)]) {
      const response = await publicRead(path, headers);
      expect(response.status, path).toBe(expected);
      if (response.ok) expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
    }
  };
  const rendered = async (slides: ZonePresentation['slides'], headers: Record<string, string> = {}) => {
    const body = await json<{ presentation: ZonePresentation; slideMedia: Array<{ id: string; art: {
      cutout: { url: string; srcset: Array<{ url: string }> } | null } }> }>(await publicRead(`${f.path}/presentation`, headers));
    expect(body.presentation.slides).toEqual(slides);
    expect(body.slideMedia.map(slide => slide.id)).toEqual(slides.map(slide => slide.id));
    for (const slide of body.slideMedia) {
      expect(slide.art.cutout).not.toBeNull();
      for (const path of [slide.art.cutout!.url, ...slide.art.cutout!.srcset.map(candidate => candidate.url)]) {
        const response = await publicRead(path, headers);
        expect(response.status, path).toBe(200);
        expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
      }
    }
  };
  const document = (slides: ZonePresentation['slides']) => {
    const body = structuredClone(fromPlainText('Published campaign', 'blocks'));
    body.doc.content!.push({ type: 'extensionBlock', attrs: { id: 'campaign', dir: null, lang: null,
      definition: 'https://rezics.com/definition/showcase-block-v1', version: '2',
      payload: { 'rv:module': [{ id: 'hero', type: 'hero-carousel', title: 'Published campaign',
        source: { kind: 'query-block', block: 'new-adoptions' }, options: { limit: 4, shuffle: false } }],
      'rv:slides': slides, 'rv:titleEffect': ['plain'] }, fallback: 'Campaign' } });
    return body;
  };
  const variantId = `urn:rezics:variant:${randomUUID()}`;
  const save = async (body: DocumentSnapshot, expectedHead: string | null,
    targetVariantId = variantId, language = 'en') => {
    const saved = await json<{ revisionId: string; byteDigest: string; sourcePosition: { dataEpoch: string } }>(
      await f.moderator.send('POST', '/v1/content-drafts', { profile: 'content-text-v1', resourceId: f.zone,
        variantId: targetVariantId, expectedHead, document: body, language: { kind: 'tag', tag: language, originalTag: language },
        direction: 'ltr', actingSubject: f.moderator.actor }), 201);
    return { page: f.zone, variantId: targetVariantId, revisionId: saved.revisionId,
      byteDigest: saved.byteDigest, contentEpoch: saved.sourcePosition.dataEpoch };
  };
  const publish = async (page: Awaited<ReturnType<typeof save>> | Array<Awaited<ReturnType<typeof save>>>) => json(await f.moderator.send('POST',
    `${f.path}/site-publications`, { expectedHead: (await readZoneConfiguration(f.env, f.zone)).revision,
      routesRevision: f.navigationRevision, navigationRevision: f.navigationRevision, pages: Array.isArray(page) ? page : [page],
      actingSubject: f.moderator.actor }), 201);

  await json(await f.write({ ...DEFAULT_ZONE_PRESENTATION, slides: [configSlide] }));
  await rendered([configSlide]);
  await delivery(configArt, 200);
  await delivery(firstArt, 404);
  let selected = await save(document([firstSlide]), null);
  await rendered([configSlide]);
  await delivery(firstArt, 404);
  await publish(selected);
  await rendered([firstSlide]);
  await delivery(firstArt, 200);
  await delivery(configArt, 404);

  selected = await save(document([nextSlide]), selected.revisionId);
  await rendered([firstSlide]);
  await delivery(firstArt, 200);
  await delivery(nextArt, 404);
  await publish(selected);
  await rendered([nextSlide]);
  await delivery(firstArt, 404);
  await delivery(nextArt, 200);
  await delivery(configArt, 404);

  selected = await save(document([{ ...nextSlide, endsAt: new Date(Date.now() - 60_000).toISOString() }]), selected.revisionId);
  await delivery(nextArt, 200);
  await publish(selected);
  await rendered([]);
  await delivery(nextArt, 404);
  await delivery(configArt, 404);
  selected = await save(document([]), selected.revisionId);
  await publish(selected);
  await rendered([]);
  await delivery(configArt, 404);

  selected = await save(fromPlainText('Unconverted home', 'blocks'), selected.revisionId);
  await publish(selected);
  await rendered([configSlide]);
  await delivery(configArt, 200);
  await delivery(nextArt, 404);

  const french = await save(document([nextSlide]), null, `urn:rezics:variant:${randomUUID()}`, 'fr');
  await publish([selected, french]);
  const languageHeaders: Record<string, string>[] = [{ 'accept-language': 'en' }, { 'accept-language': 'fr' },
    { 'accept-language': 'en', 'x-rezics-display-languages': 'fr' }];
  for (const headers of languageHeaders) {
    const local = headers['accept-language'] === 'fr' || headers['x-rezics-display-languages'] === 'fr';
    await rendered(local ? [nextSlide] : [configSlide], headers);
    await delivery(configArt, local ? 404 : 200, headers);
    await delivery(nextArt, local ? 200 : 404, headers);
    await delivery(firstArt, 404, headers);
  }
}, 120_000);

test('v2 campaign writes request only new art, replay once, and read srcset for every art role in bounded batches', async () => {
  const f = await fixture('layered');
  const landscape = await f.campaign();
  const logo = await f.campaign();
  const work = await f.publicWork(f.moderator.actor, ['en'], 'Featured Work');
  const presentation: ZonePresentation = { ...DEFAULT_ZONE_PRESENTATION, tokens: ZONE_PRESETS.vibrant,
    slides: [{ id: 'featured', work: work.work, title: 'Featured', titles: { ja: '注目' },
      kicker: 'New', kickers: { fr: 'Nouveau' }, startsAt: new Date(Date.now() - 60_000).toISOString(),
      art: { landscape: { use: landscape.use, focalArea: 'xywh=percent:10,10,80,80' },
        portrait: { use: landscape.use }, cutout: { use: logo.use },
        logos: [{ use: logo.use, language: 'zxx', tone: 'light', anchor: 'center-middle' }] } }] };
  const head = (await readZoneConfiguration(f.env, f.zone)).revision;
  const key = randomUUID();
  const changed = await json<{ revision: string }>(await f.write(presentation, key, head));
  const jobs = await f.contentPool.query<{ id: string }>(
    'SELECT id FROM media.transform_job WHERE source_id = ANY($1::uuid[])', [[landscape.representation, logo.representation]]);
  expect(jobs.rows).toHaveLength(4);
  expect(await json(await f.write(presentation, key, head))).toMatchObject({ revision: changed.revision, replayed: true });
  await json(await f.write({ ...presentation, slides: [{ ...presentation.slides[0]!, title: 'Changed copy' }] }));
  expect((await f.contentPool.query('SELECT id FROM media.transform_job WHERE source_id = ANY($1::uuid[])',
    [[landscape.representation, logo.representation]])).rowCount).toBe(4);
  const pending = await f.read();
  const pendingEtag = pending.headers.get('etag');
  expect(await json(pending)).toMatchObject({ profile: 'zone-presentation-response-v2',
    slideMedia: [{ art: { landscape: { srcset: [] } } }] });
  const worker = new MediaRenditionWorker(f.store.renditions, new LocalImageTransformer(), f.objects);
  for (let i = 0; i < 4; i++) await worker.tick();
  let itemReads = 0;
  let candidateReads = 0;
  const itemBatch = f.store.itemDeliveryBatch.bind(f.store);
  const candidateBatch = f.store.renditions.candidatesBatch.bind(f.store.renditions);
  f.store.itemDeliveryBatch = async uses => { itemReads++; expect(uses).toHaveLength(2); return itemBatch(uses); };
  f.store.renditions.candidatesBatch = async uses => { candidateReads++; expect(uses).toHaveLength(2); return candidateBatch(uses); };
  try {
    const response = await f.read();
    expect(response.headers.get('etag')).not.toBe(pendingEtag);
    const body = await json<{ presentation: ZonePresentation; slideMedia: { art: {
      landscape: { srcset: { url: string; width: number; type: string }[] }; portrait: unknown;
      cutout: unknown; logos: unknown[] } }[] }>(response);
    expect(body.presentation.slides[0]).toMatchObject({ work: work.work, title: 'Changed copy', titles: { ja: '注目' } });
    expect(body.slideMedia[0]!.art.landscape.srcset.map(candidate => candidate.type)).toEqual(['image/avif', 'image/webp']);
    expect(body.slideMedia[0]!.art.logos).toMatchObject([{ language: 'zxx', tone: 'light', anchor: 'center-middle' }]);
    expect(itemReads).toBe(1);
    expect(candidateReads).toBe(1);
    for (const candidate of body.slideMedia[0]!.art.landscape.srcset) {
      const delivered = await f.call('GET', candidate.url);
      expect(delivered.status).toBe(200);
      await delivered.arrayBuffer();
    }
  } finally { f.store.itemDeliveryBatch = itemBatch; f.store.renditions.candidatesBatch = candidateBatch; }
}, 120_000);

test('an immutable v1 configuration reads as v2 and an unrelated write persists the normalized profile', async () => {
  const f = await fixture('legacy');
  const art = await f.campaign();
  await json(await f.write(DEFAULT_ZONE_PRESENTATION));
  const before = await readZoneConfiguration(f.env, f.zone);
  const { titleEffect: _effect, ...tokens } = DEFAULT_ZONE_PRESENTATION.tokens;
  const schedule = { startsAt: new Date(Date.now() - 60_000).toISOString(),
    endsAt: new Date(Date.now() + 3_600_000).toISOString() };
  const legacy = { ...DEFAULT_ZONE_PRESENTATION, profile: 'zone-presentation-v1', slides: undefined,
    tokens, banners: [{ id: 'launch', title: 'Launch', alt: 'Landscape art', image: art.use, href: '/campaign',
      ...schedule }] };
  const manifest = prepareComponent(f.env.objectDirectory, f.zone, {
    configuration: { ...before.configuration, presentation: legacy },
    ...(before.name !== null ? { name: before.name, language: before.language } : {}),
  }, ZONE_PROFILE);
  await f.fuseki.update(`PREFIX rv: <https://rezics.com/vocab/>
    DELETE { GRAPH ${iri(GRAPHS.current)} { ${iri(f.zone)} rv:presentation ?old }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(before.revision)} rv:manifest ?manifest } }
    INSERT { GRAPH ${iri(GRAPHS.current)} { ${iri(f.zone)} rv:presentation <https://rezics.com/definition/zone-presentation-v1> }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(before.revision)} rv:manifest ${iri(`urn:rezics:sha256:${manifest}`)} } }
    WHERE { GRAPH ${iri(GRAPHS.current)} { ${iri(f.zone)} rv:presentation ?old }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(before.revision)} rv:manifest ?manifest } }`);
  expect(await json(await f.read())).toMatchObject({ presentation: { profile: 'zone-presentation-v2',
    slides: [{ id: 'launch', title: 'Launch', href: '/campaign',
      ...schedule,
      art: { landscape: { use: art.use, alt: 'Landscape art' } } }] },
    slideMedia: [{ id: 'launch', art: { landscape: { width: 80, height: 60 } } }] });
  const normalized = await readZoneConfiguration(f.env, f.zone);
  await json(await f.moderator.send('PUT', `${f.path}/configuration`, {
    expectedHead: normalized.revision, actingSubject: f.moderator.actor, budget: { timeMs: 1000, rows: 100 },
  }));
  expect((await readZoneConfiguration(f.env, f.zone)).presentation).toBe('https://rezics.com/definition/zone-presentation-v2');
  expect(legacy.profile).toBe('zone-presentation-v1');
}, 120_000);

test('refused v1, ambiguous targets, duplicate IDs, schedules and art roles do not advance the Zone head', async () => {
  const f = await fixture('refusals');
  const head = (await readZoneConfiguration(f.env, f.zone)).revision;
  const slide = { id: 'launch', href: '/campaign' };
  for (const presentation of [
    { ...DEFAULT_ZONE_PRESENTATION, profile: 'zone-presentation-v1', banners: [] },
    { ...DEFAULT_ZONE_PRESENTATION, slides: [{ ...slide, work: ref() }] },
    { ...DEFAULT_ZONE_PRESENTATION, slides: [slide, slide] },
    { ...DEFAULT_ZONE_PRESENTATION, slides: [{ ...slide, startsAt: '2026-10-06T00:00:00.000Z', endsAt: '2026-10-05T00:00:00.000Z' }] },
    { ...DEFAULT_ZONE_PRESENTATION, slides: [{ ...slide, art: { unknown: { use: ref() } } }] },
  ]) {
    expect((await f.write(presentation)).status).toBe(400);
    expect((await readZoneConfiguration(f.env, f.zone)).revision).toBe(head);
  }
  const outsider = await f.member('outsider');
  expect((await outsider.send('PUT', `${f.path}/configuration`, {
    expectedHead: head, actingSubject: outsider.actor, presentation: DEFAULT_ZONE_PRESENTATION,
  })).status).toBe(403);
  await json(await f.write({ ...DEFAULT_ZONE_PRESENTATION, slides: [slide] }));
  expect((await f.write(DEFAULT_ZONE_PRESENTATION, randomUUID(), head)).status).toBe(409);
}, 120_000);

test('missing, wrong-Realm and newly private campaign art leave slide text and targets intact', async () => {
  const f = await fixture('fallback');
  const image = await f.campaign();
  const otherRealm = await f.campaign(ref());
  const work = await f.publicWork(f.moderator.actor, ['en'], 'Work retaining its text without campaign art');
  const presentation: ZonePresentation = { ...DEFAULT_ZONE_PRESENTATION, slides: [
    { id: 'missing', href: '/missing', title: 'Missing art', art: { landscape: { use: ref() } } },
    { id: 'other', href: '/other', title: 'Other Realm', art: { portrait: { use: otherRealm.use } } },
    { id: 'private', work: work.work, title: 'Retained text', art: { cutout: { use: image.use } } },
  ] };
  await json(await f.write(presentation));
  const state = (await f.store.readAsset(image.asset))!;
  await json(await f.moderator.send('POST', `/v1/media/assets/${image.asset}/state`, {
    profile: 'media-asset-state-v1', expectedState: state.state, disclosure: 'private', lifecycle: 'active',
    actingSubject: f.moderator.actor,
  }), 201);
  expect(await json(await f.read())).toMatchObject({ presentation,
    slideMedia: presentation.slides.map(slide => ({ id: slide.id,
      art: { landscape: null, portrait: null, cutout: null, logos: [] } })) });
}, 120_000);
