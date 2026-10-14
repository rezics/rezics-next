import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { png, sha, startMediaStack, type MediaStack } from './media-support.ts';
import { DEFAULT_MEDIA_CONTEXT } from '../../../services/main/src/modules/media/contract.ts';
import { boundedPool } from '../../../services/main/src/infrastructure/pg-pool.ts';
import { personaSessions, type PersonaSession, type PersonaSessions } from '../support/personas.ts';
import { closureCommand, closureCredit, closureOriginal, effectClosure, publishClosureRule } from './outcomes/realm/closure-fixture.ts';

let started: Promise<MediaStack> | undefined;
const stack = () => started ??= startMediaStack('media-context');
const deliverySessions: PersonaSessions[] = [];
afterAll(async () => {
  for (const sessions of deliverySessions) await sessions.close();
  if (started) await (await started).stop();
});

test('media accepts the platform global context for an independent document image use', async () => {
  const s = await stack();
  const owner = await s.member('media-context-author');
  const work = await s.publicWork(owner.actor);
  await owner.grant(`content:publish:${work.work}`, 'media.use');
  const image = await owner.upload(png(48, 48));
  const response = await owner.send('POST', '/v1/media/uses', {
    actingSubject: owner.actor, target: work.work, representation: image.representation,
    occurrence: randomUUID(), context: 'urn:rezics:context:global', conceal: false,
  });
  const answer = await response.text();
  console.info('Media global context owner answer', JSON.stringify({ status: response.status, answer }));
  expect(response.status, answer).toBe(201);
}, 180_000);

test('media context inputs share default selection, retry identity and storage without renaming answers', async () => {
  const s = await stack();
  const owner = await s.member('media-context-selection-author');
  const work = await s.publicWork(owner.actor);
  await owner.grant(`content:publish:${work.work}`, 'media.use');
  await owner.grant(`media:avatar:${work.work}`, 'media.avatar');
  await owner.grant(`work:read:${work.work}`, 'work.read');
  const bytes = new Uint8Array(await sharp({ create: { width: 1280, height: 720, channels: 4,
    background: { r: 20, g: 40, b: 60, alpha: 1 } } }).png().toBuffer());
  const image = await owner.upload(bytes);
  const resource = `/v1/resources/${work.work.split('/').at(-1)}`;
  const native = `https://rezics.com/id/${randomUUID()}`;
  const global = 'urn:rezics:context:global';
  const writes = [
    { name: 'document use', method: 'POST', path: '/v1/media/uses', body: {
      actingSubject: owner.actor, target: work.work, representation: image.representation,
      occurrence: randomUUID(), conceal: false,
    } },
    { name: 'avatar', method: 'PUT', path: `${resource}/avatar`, body: {
      profile: 'resource-avatar-selection-v1', actingSubject: owner.actor,
      expectedSelection: null, asset: image.asset, crop: null,
    } },
    { name: 'showcase art', method: 'PUT', path: `${resource}/showcase/art`, body: {
      profile: 'work-showcase-selection-v1', actingSubject: owner.actor,
      expectedSelection: null, asset: image.asset, role: 'background-landscape',
      crop: 'xywh=percent:0,0,100,100',
    } },
    { name: 'showcase trailer', method: 'PUT', path: `${resource}/showcase/trailer`, body: {
      profile: 'work-showcase-trailer-v1', actingSubject: owner.actor,
      expectedSelection: null, url: 'https://example.test/trailer',
    } },
  ];
  for (const write of writes) {
    const key = randomUUID();
    const created = await owner.send(write.method, write.path, { ...write.body, context: global }, key);
    const answer = await created.json();
    expect(created.status, `${write.name}: ${JSON.stringify(answer)}`).toBe(201);
    const retried = await owner.send(write.method, write.path, { ...write.body, context: DEFAULT_MEDIA_CONTEXT }, key);
    expect(retried.status, write.name).toBe(200);
    const replay = await retried.json();
    expect(replay).toEqual({ ...answer, replayed: true });
    const stored = write.name === 'document use'
      ? await s.contentPool.query('SELECT context FROM media.use WHERE id = $1', [answer.use])
      : await s.contentPool.query('SELECT context FROM media.selection_revision WHERE id = $1', [answer.selection]);
    expect(stored.rows).toEqual([{ context: DEFAULT_MEDIA_CONTEXT }]);
    const nativeBody = { ...write.body, context: native,
      ...(write.name === 'document use' ? { occurrence: randomUUID() } : {}) };
    const nativeResponse = await owner.send(write.method, write.path, nativeBody);
    const nativeAnswer = await nativeResponse.json();
    expect(nativeResponse.status, `${write.name}: ${JSON.stringify(nativeAnswer)}`).toBe(201);
    const nativeStored = write.name === 'document use'
      ? await s.contentPool.query('SELECT context FROM media.use WHERE id = $1', [nativeAnswer.use])
      : await s.contentPool.query('SELECT context FROM media.selection_revision WHERE id = $1', [nativeAnswer.selection]);
    expect(nativeStored.rows).toEqual([{ context: native }]);
    const refused = await owner.send(write.method, write.path, { ...write.body, context: 'urn:invalid:context' });
    expect(refused.status, write.name).toBe(400);
    console.info('Media context input covered', JSON.stringify({ surface: write.name,
      global: created.status, legacyReplay: retried.status, native: nativeResponse.status, invalid: refused.status }));
  }

  const reads = [
    { name: 'resource', read: (context: string) => owner.read(`${resource}?${new URLSearchParams({ context })}`) },
    { name: 'resource summaries', read: (context: string) => owner.send('POST', '/v1/resources/summaries', {
      profile: 'resource-summary-batch-v1', resources: [work.work], context,
    }) },
    { name: 'showcase batch', read: (context: string) => owner.send('POST', '/v1/resources/showcase', {
      profile: 'work-showcase-batch-v1', targets: [work.work], context,
    }) },
  ];
  for (const read of reads) {
    const globalResponse = await read.read(global);
    const legacyResponse = await read.read(DEFAULT_MEDIA_CONTEXT);
    const globalAnswer = await globalResponse.json();
    const legacyAnswer = await legacyResponse.json();
    expect(globalResponse.status, `${read.name}: ${JSON.stringify(globalAnswer)}`).toBe(200);
    expect(legacyResponse.status).toBe(200);
    expect(globalAnswer).toEqual(legacyAnswer);
    expect(JSON.stringify(globalAnswer)).not.toContain(global);
    if (read.name === 'showcase batch') {
      expect(globalAnswer.items[0].images[0].context).toBe(DEFAULT_MEDIA_CONTEXT);
      expect(globalAnswer.items[0].trailer.context).toBe(DEFAULT_MEDIA_CONTEXT);
    }
    const nativeResponse = await read.read(native);
    // A syntactically native ID is accepted even when no readable Context exists.
    expect([200, 404], read.name).toContain(nativeResponse.status);
    expect((await read.read('urn:invalid:context')).status, read.name).toBe(400);
    console.info('Media context input covered', JSON.stringify({ surface: read.name,
      global: globalResponse.status, legacy: legacyResponse.status, native: nativeResponse.status, invalid: 400 }));
  }

  const download = (context: string) => owner.read(`/v1/media/assets/${image.asset}/bytes?${new URLSearchParams({
    target: work.work, context,
  })}`);
  for (const context of [global, DEFAULT_MEDIA_CONTEXT, native]) {
    const response = await download(context);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get('etag')).toBe(`"${sha(bytes)}"`);
    expect(sha(new Uint8Array(await response.arrayBuffer()))).toBe(sha(bytes));
  }
  expect((await download('urn:invalid:context')).status).toBe(400);
  console.info('Media context input covered', JSON.stringify({ surface: 'asset download',
    global: 200, legacy: 200, native: 200, invalid: 400 }));
}, 240_000);

const deliveryBytes = new Uint8Array(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNQnBb8HwAD8AIKCU5mOAAAAABJRU5ErkJggg==', 'base64'));

let documentFixture: ReturnType<typeof createDocumentUses> | undefined;
const documentUses = () => documentFixture ??= createDocumentUses();

async function createDocumentUses() {
  const visibility = 'public';
  const sessions = await personaSessions(visibility);
  deliverySessions.push(sessions);
  const author = sessions.member;
  const original = await closureOriginal(author, `Media ${visibility} context original`);
  const reservation = await closureCommand<{ asset: string; upload: string; uploadUrl: string }>(author,
    'POST', '/v1/media/uploads', { profile: 'media-image-upload-v1', asset: null,
      mediaType: 'image/png', byteLength: deliveryBytes.length, sha256: sha(deliveryBytes),
      disclosure: 'public', actingSubject: author.actingSubject }, 201);
  const activated = await author.main('PUT', reservation.uploadUrl, undefined, undefined,
    { bytes: deliveryBytes, headers: { 'content-type': 'application/octet-stream' } });
  expect(activated.status, await activated.clone().text()).toBe(201);
  const image = await activated.json() as { representation: string };
  const deadline = performance.now() + 30_000;
  while ((await closureCommand<{ clearance: string }>(author, 'GET',
    `/v1/media/uploads/${reservation.upload}`)).clearance !== 'cleared') {
    expect(performance.now()).toBeLessThan(deadline);
    await Bun.sleep(100);
  }
  const create = (context: string) => closureCommand<{ use: string }>(author, 'POST', '/v1/media/uses', {
    actingSubject: author.actingSubject, target: original.work, representation: image.representation,
    occurrence: randomUUID(), context, conceal: false,
  }, 201);
  const scoped = await create(sessions.realm);
  const global = await create('urn:rezics:context:global');
  const pool = boundedPool({ connectionString: process.env.CONTENT_DATABASE_URL, max: 1 });
  try {
    const persisted = await pool.query<{ id: string; context: string; role: string; target: string }>(
      'SELECT id,context,role,target FROM media.use WHERE id = ANY($1::uuid[]) ORDER BY id',
      [[scoped.use, global.use]]);
    expect(persisted.rows).toHaveLength(2);
    expect(persisted.rows.find(row => row.id === scoped.use)).toMatchObject({
      context: sessions.realm, role: 'document-image', target: original.work,
    });
    expect(persisted.rows.find(row => row.id === global.use)?.context).toBe(DEFAULT_MEDIA_CONTEXT);
    const realm = await sessions.visitor.main('GET', `/v1/realms/${sessions.realm.slice(-36)}`);
    const target = await sessions.visitor.main('GET', `/v1/resources/${original.work.slice(-36)}?${
      new URLSearchParams({ context: sessions.realm })}`);
    console.info('Media Use context confirmation', JSON.stringify({ visibility, persisted: persisted.rows,
      visitorRealm: { status: realm.status, answer: await realm.text() },
      visitorTarget: { status: target.status, answer: await target.text() } }));
    expect(realm.status, 'Public Realm disclosure must be established before a delivery repair')
      .toBe(200);
    expect(target.status, 'The document must be publicly readable').toBe(200);
  } finally { await pool.end(); }
  return { sessions, original, image, scoped: scoped.use, global: global.use };
}

async function useAvailable(person: PersonaSession, use: string) {
  const query = person.actingSubject ? `?${new URLSearchParams({ actingSubject: person.actingSubject })}` : '';
  const path = `/v1/media/uses/${use}${query}`;
  const response = await person.main('GET', path);
  expect(response.status, await response.clone().text()).toBe(200);
  expect(sha(new Uint8Array(await response.arrayBuffer()))).toBe(sha(deliveryBytes));
  expect(response.headers.get('etag')).toBe(`"${sha(deliveryBytes)}"`);
  const conditional = await person.main('GET', path, undefined, undefined,
    { headers: { 'if-none-match': `"${sha(deliveryBytes)}"` } });
  expect(conditional.status).toBe(304);
  expect((await conditional.arrayBuffer()).byteLength).toBe(0);
}

async function useAbsent(person: PersonaSession, use: string) {
  const query = person.actingSubject ? `?${new URLSearchParams({ actingSubject: person.actingSubject })}` : '';
  for (const headers of [{}, { 'if-none-match': `"${sha(deliveryBytes)}"` }]) {
    const response = await person.main('GET', `/v1/media/uses/${use}${query}`, undefined, undefined, { headers });
    const absent = await person.main('GET', `/v1/media/uses/${randomUUID()}${query}`, undefined, undefined, { headers });
    expect(response.status).toBe(404);
    expect(response.status).toBe(absent.status);
    expect(await response.json()).toEqual(await absent.json());
    expect(response.headers.get('etag')).toBeNull();
    expect(response.headers.get('last-modified')).toBeNull();
  }
}

async function setRealmVisibility(sessions: PersonaSessions, visibility: 'public' | 'private') {
  const path = `/v1/spaces/${sessions.space.slice(-36)}/settings`;
  const current = await closureCommand<{ generation: string }>(sessions.owner, 'GET',
    `${path}?${new URLSearchParams({ actingSubject: sessions.owner.actingSubject! })}`);
  await closureCommand(sessions.owner, 'PUT', path, { actingSubject: sessions.owner.actingSubject,
    expectedGeneration: current.generation, settings: { visibility, listing: 'listed',
      admission: visibility === 'public' ? 'open' : 'request', history: 'everything' },
    reason: 'Exercise the current Use context disclosure' }, 201);
}

test('unreadable Realm document image Use is absent to visitor and stranger but available to its member', async () => {
  const f = await documentUses();
  await setRealmVisibility(f.sessions, 'private');
  try {
    const memberRealm = await f.sessions.member.main('GET', `/v1/realms/${f.sessions.realm.slice(-36)}?${
      new URLSearchParams({ actingSubject: f.sessions.member.actingSubject! })}`);
    expect(memberRealm.status, await memberRealm.clone().text()).toBe(200);
    await useAbsent(f.sessions.visitor, f.scoped);
    await useAbsent(f.sessions.stranger, f.scoped);
    await useAvailable(f.sessions.member, f.scoped);
    await useAvailable(f.sessions.visitor, f.global);
    await closureCredit(f.sessions.visitor, f.original.work, f.sessions.member);
  } finally { await setRealmVisibility(f.sessions, 'public'); }
}, 240_000);

test('document image Use follows public Realm disclosure and closure while its independent global Use survives', async () => {
  const f = await documentUses();
  await useAvailable(f.sessions.visitor, f.scoped);
  await useAvailable(f.sessions.visitor, f.global);
  await closureCredit(f.sessions.visitor, f.original.work, f.sessions.member);
  await effectClosure(f.sessions, await publishClosureRule(f.sessions));
  await useAbsent(f.sessions.visitor, f.scoped);
  await useAbsent(f.sessions.member, f.scoped);
  await useAvailable(f.sessions.visitor, f.global);
  await closureCredit(f.sessions.visitor, f.original.work, f.sessions.member);
}, 240_000);
