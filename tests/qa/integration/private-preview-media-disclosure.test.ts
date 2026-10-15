import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { fromPlainText } from '@rezics/document';
import sharp from 'sharp';
import { originalRecipe, fixtureAnswer as answer, short }
  from '../../../scripts/qa/cases/outcomes/recipes/read-a-recipe.ts';
import { personaNames, personaSessions, type PersonaSession, type PersonaSessions } from '../support/personas.ts';
import { comparableBody } from '../support/hidden-id-equality.ts';

setDefaultTimeout(180_000);
let sessions: PersonaSessions;
type Page = { revisionId: string; byteDigest: string; sourcePosition: { dataEpoch: string } };
let site: { path: string; page: string; published: Page; draft: Page; etag: string;
  navigation: string; navigationRevision: string; cursor: string };
let media: { asset: string; representation: string; selection: string; etag: string; bytes: Uint8Array };
const secret = `privatepreview${randomUUID().replaceAll('-', '')}`;
const query = (person: PersonaSession) => person.actingSubject
  ? `?actingSubject=${encodeURIComponent(person.actingSubject)}` : '';

beforeAll(async () => {
  sessions = await personaSessions('public');
  const owner = sessions.owner, actingSubject = owner.actingSubject;
  const created = await answer<{ zone: string; zoneRevision: string; navigationRevision: string }>(owner.main('POST', '/v1/spaces', {
    profile: 'space-zone-v1', name: 'Published preview audit site', language: 'en', visibility: 'public',
    capabilities: ['zone'], actingSubject,
  }), 201);
  const path = `/v1/zones/${short(created.zone)}`;
  const prepared = await answer<{ revision: string }>(owner.main('PUT', `${path}/configuration`, {
    expectedHead: created.zoneRevision, prepareHomeDocument: true, actingSubject,
  }));
  const config = await answer<{ configuration: { homeDocument: string; navigation: string } }>(owner.main('GET', `${path}/configuration${query(owner)}`));
  const page = config.configuration.homeDocument, variantId = `urn:rezics:variant:${randomUUID()}`;
  const save = (body: string, expectedHead: string | null) => answer<Page>(owner.main('POST', '/v1/content-drafts', {
    profile: 'content-text-v1', resourceId: page, variantId, expectedHead,
    document: fromPlainText(body, 'blocks'), language: { kind: 'tag', tag: 'en', originalTag: 'en' },
    direction: 'ltr', actingSubject,
  }), 201);
  const published = await save('Published site document.', null);
  await answer(owner.main('POST', `${path}/site-publications`, {
    expectedHead: prepared.revision, actingSubject, routesRevision: created.navigationRevision,
    navigationRevision: created.navigationRevision,
    pages: [{ page, variantId, revisionId: published.revisionId, byteDigest: published.byteDigest,
      contentEpoch: published.sourcePosition.dataEpoch }],
  }), 201);
  const publicResponse = await sessions.visitor.main('GET', `${path}/presentation`);
  expect(publicResponse.status).toBe(200);
  const etag = publicResponse.headers.get('etag'); expect(etag).toBeString();
  const draft = await save(secret, published.revisionId);
  const target = await originalRecipe(owner, 'Public navigation target');
  let navigationRevision = created.navigationRevision;
  for (let index = 0; index < 2; index++) {
    navigationRevision = (await answer<{ revision: string }>(owner.main('POST', `${path}/mounts`, {
      expectedHead: navigationRevision, target: target.work, routeSegment: `${secret}-${index}`,
      disclosure: 'public', actingSubject,
    }))).revision;
  }
  const savedNavigation = await answer<{ next: string | null }>(owner.main('GET', `${path}${query(owner)}&limit=1`));
  expect(savedNavigation.next).toBeString();
  site = { path, page, published, draft, etag: etag!, navigation: config.configuration.navigation,
    navigationRevision, cursor: savedNavigation.next! };

  const work = await originalRecipe(owner, 'Private media attachment', { published: false });
  const bytes = new Uint8Array(await sharp({ create: { width: 1280, height: 720, channels: 4,
    background: { r: 20, g: 50, b: 80, alpha: 1 } } }).png().toBuffer());
  const reserved = await answer<{ asset: string; upload: string }>(owner.main('POST', '/v1/media/uploads', {
    profile: 'media-image-upload-v1', asset: null, mediaType: 'image/png', byteLength: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'), disclosure: 'private', actingSubject,
  }), 201);
  const uploaded = await answer<{ representation: string }>(owner.main('PUT', `/v1/media/uploads/${reserved.upload}/bytes`,
    undefined, undefined, { bytes, headers: { 'content-type': 'image/png', 'content-length': String(bytes.byteLength) } }), 201);
  const selection = await answer<{ selection: string }>(owner.main('PUT', `/v1/resources/${short(work.work)}/showcase/art`, {
    profile: 'work-showcase-selection-v1', expectedSelection: null, asset: reserved.asset,
    role: 'background-landscape', crop: 'xywh=percent:0,0,100,100', actingSubject,
  }), 201);
  const allowed = await owner.main('GET', `/v1/media/representations/${uploaded.representation}/bytes${query(owner)}`);
  expect(allowed.status).toBe(200);
  expect(allowed.headers.get('cache-control')).toBe('private, no-store');
  const mediaEtag = allowed.headers.get('etag'); expect(mediaEtag).toBeString();
  media = { asset: reserved.asset, representation: uploaded.representation,
    selection: selection.selection, etag: mediaEtag!, bytes };
}, 240_000);
afterAll(async () => { await sessions?.close(); });

for (const name of personaNames) {
  test(`${name}: Zone page revisions, editor previews and site validators preserve the publication pin`, async () => {
    const person = sessions[name], permitted = name === 'owner';
    for (const suffix of ['configuration', 'showcase-editor']) {
      const acting = query(person) || `?actingSubject=${encodeURIComponent(sessions.owner.actingSubject!)}`;
      const response = await person.main('GET', `${site.path}/${suffix}${acting}`);
      expect(response.status, await response.clone().text()).toBe(permitted ? 200 : name === 'visitor' ? 401 : 404);
      if (!permitted) expect(await response.text()).not.toContain(secret);
    }
    const draft = await person.main('GET', `/v1/content-revisions/${site.draft.revisionId}${query(person)}`);
    expect(draft.status, await draft.clone().text()).toBe(permitted ? 200 : 404);
    if (!permitted) {
      const absent = await person.main('GET', `/v1/content-revisions/${randomUUID()}${query(person)}`);
      expect(comparableBody(await draft.text())).toBe(comparableBody(await absent.text()));
    }
    const route = await answer<{ page: { reference: { revisionId: string } } }>(person.main('GET', `${site.path}/routes?path=%2F`));
    expect(route.page.reference.revisionId).toBe(site.published.revisionId);
    expect(JSON.stringify(route)).not.toContain(secret);
    const presentation = await person.main('GET', `${site.path}/presentation`);
    expect(presentation.status).toBe(200);
    expect(presentation.headers.get('etag')).toBe(site.etag);
    expect(await presentation.text()).not.toContain(secret);
    const cached = await person.main('GET', `${site.path}/presentation`, undefined, undefined,
      { headers: { 'if-none-match': site.etag } });
    expect(cached.status).toBe(304);
    expect(await cached.text()).toBe('');
  });

  test(`${name}: saved Zone navigation, historical revisions and transferred continuations require edit authority`, async () => {
    const person = sessions[name], permitted = name === 'owner';
    const acting = query(person) || `?actingSubject=${encodeURIComponent(sessions.owner.actingSubject!)}`;
    for (const path of [
      `${site.path}${acting}`,
      `${site.path}/revisions/${short(site.navigationRevision)}${acting}`,
      `${site.path}/revisions/${short(site.navigationRevision)}${acting}&limit=1&after=${encodeURIComponent(site.cursor)}`,
      `/v1/compositions/${short(site.navigation)}${query(person)}`,
      `/v1/compositions/${short(site.navigation)}/revisions/${short(site.navigationRevision)}${query(person)}`,
    ]) {
      const response = await person.main('GET', path);
      const expected = permitted ? 200 : name === 'visitor' && path.startsWith('/v1/zones/') ? 401 : 404;
      expect(response.status, `${path}: ${await response.clone().text()}`).toBe(expected);
      if (!permitted) expect(await response.text()).not.toContain(secret);
    }
  });

  test(`${name}: private attached Media bytes, metadata, selection handles and ETags grant no new audience`, async () => {
    const person = sessions[name], permitted = name === 'owner';
    for (const suffix of ['', '/bytes']) {
      const path = `/v1/media/representations/${media.representation}${suffix}${query(person)}`;
      const response = await person.main('GET', path, undefined, undefined,
        { headers: { 'if-none-match': media.etag } });
      expect(response.status, await response.clone().text()).toBe(permitted ? suffix ? 304 : 200 : 404);
      if (!permitted) {
        expect(response.headers.get('etag')).toBeNull();
        const absent = await person.main('GET', `/v1/media/representations/${randomUUID()}${suffix}${query(person)}`,
          undefined, undefined, { headers: { 'if-none-match': media.etag } });
        expect(absent.status).toBe(404);
        expect(comparableBody(await response.text())).toBe(comparableBody(await absent.text()));
      }
    }
    const metadata = await answer<{ items: { status: string }[] }>(person.main('POST', '/v1/media/metadata', {
      ...(person.actingSubject ? { actingSubject: person.actingSubject } : {}),
      items: [{ representation: media.representation }, { selection: short(media.selection) }],
    }));
    expect(metadata.items.map(item => item.status)).toEqual(permitted ? ['available', 'available'] : ['unavailable', 'unavailable']);
    const raw = await person.main('GET', `/v1/media/representations/${media.representation}/bytes${query(person)}`);
    expect(raw.status).toBe(permitted ? 200 : 404);
    if (permitted) expect(new Uint8Array(await raw.arrayBuffer())).toEqual(media.bytes);
  });
}
