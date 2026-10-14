import { OutcomeRecorder, outcomeTest } from '../../../support/outcome-test.ts';
import { BFF_PREFIX } from '../../../../../apps/web/features/api/browser.ts';
import { resolveMediaMetadata } from '../../../../../apps/web/features/api/media-metadata.ts';
import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import media from '../../../../../scripts/qa/cases/outcomes/realm/closure-media.ts';
import { personaSessions, type PersonaName, type PersonaSession, type PersonaSessions } from '../../../support/personas.ts';
import { closureCommand, closureCredit, closureOriginal, closureCell, closureSetup,
  effectClosure, publishClosureRule } from './closure-fixture.ts';

setDefaultTimeout(60_000);
let sessions: PersonaSessions;
let setupFailure: string | null = null;
let original: Awaited<ReturnType<typeof closureOriginal>>;
type Image = { asset: string; representation: string; use: string; etag: string };
let closedOnly: Image;
let shared: Image;
let independentUse: string;
let otherIndependentUse: string;
const recording = new OutcomeRecorder(media);
const storyId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
// Original green pixel authored by this fixture, including valid PNG checksums.
function chunk(kind: string, data: Uint8Array) {
  const encoded = Buffer.concat([Buffer.from(kind), data]);
  let crc = 0xffffffff;
  for (const byte of encoded) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, encoded, checksum]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6;
const bytes = new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr), chunk('IDAT', deflateSync(new Uint8Array([0, 33, 150, 83, 255]))),
  chunk('IEND', new Uint8Array())]));

async function image(): Promise<Image> {
  const author = sessions.member;
  const reservation = await closureCommand<{ asset: string; uploadUrl: string; upload: string }>(author,
    'POST', '/v1/media/uploads', { profile: 'media-image-upload-v1', asset: null, mediaType: 'image/png',
      byteLength: bytes.length, sha256: sha(bytes), disclosure: 'public', actingSubject: author.actingSubject }, 201);
  const upload = await author.main('PUT', reservation.uploadUrl, undefined, undefined,
    { bytes, headers: { 'content-type': 'application/octet-stream' } });
  const raw = await upload.text();
  expect(upload.status, raw).toBe(201);
  const activated = JSON.parse(raw) as { status: string; representation: string };
  expect(activated.status).toBe('activated');
  const deadline = performance.now() + 30_000;
  for (;;) {
    const current = await closureCommand<{ clearance: string }>(author, 'GET', `/v1/media/uploads/${reservation.upload}`);
    if (current.clearance === 'cleared') break;
    expect(current.clearance, 'A benign original image must clear screening').toBe('screening');
    expect(performance.now(), 'Public image screening must finish').toBeLessThan(deadline);
    await Bun.sleep(100);
  }
  const use = await createUse(author, activated.representation, sessions.realm);
  return { asset: reservation.asset, representation: activated.representation, use, etag: `"${sha(bytes)}"` };
}
async function createUse(author: PersonaSession, representation: string, context: string) {
  const created = await closureCommand<{ use: string }>(author, 'POST', '/v1/media/uses', {
    actingSubject: author.actingSubject, target: original.work, representation,
    occurrence: randomUUID(), context, conceal: false,
  }, 201);
  expect(created.use).toMatch(/^[0-9a-f-]{36}$/);
  return created.use;
}
const actor = (person: PersonaSession) => person.actingSubject
  ? `actingSubject=${encodeURIComponent(person.actingSubject)}` : '';
async function available(person: PersonaSession, path: string, etag: string) {
  const response = await person.main('GET', path);
  expect(response.status, path).toBe(200);
  expect(sha(new Uint8Array(await response.arrayBuffer())), path).toBe(sha(bytes));
  expect(response.headers.get('etag'), path).toBe(etag);
  const conditional = await person.main('GET', path, undefined, undefined, { headers: { 'if-none-match': etag } });
  expect(conditional.status, path).toBe(304);
  expect((await conditional.arrayBuffer()).byteLength).toBe(0);
}
async function absent(person: PersonaSession, path: string, control: string, etag: string) {
  for (const headers of [{}, { 'if-none-match': etag }]) {
    const closed = await person.main('GET', path, undefined, undefined, { headers });
    const missing = await person.main('GET', control, undefined, undefined, { headers });
    expect(closed.status, path).toBe(missing.status);
    expect(closed.status, path).toBe(404);
    expect(await closed.json(), path).toEqual(await missing.json());
    expect(closed.headers.get('etag'), path).toBeNull();
    expect(closed.headers.get('last-modified'), path).toBeNull();
  }
}
beforeAll(async () => {
  sessions = await personaSessions('public');
  await recording.prepare();
  setupFailure = await closureSetup(sessions, async () => {
    const rule = await publishClosureRule(sessions);
    // Asset author/uploader is a joined member, distinct from the Realm owner.
    original = await closureOriginal(sessions.member, 'Original closure image and independent story');
    closedOnly = await image();
    shared = await image();
    independentUse = await createUse(sessions.member, shared.representation, 'urn:rezics:context:global');
    otherIndependentUse = await createUse(sessions.member, shared.representation, 'urn:rezics:context:global');
    for (const image of [closedOnly, shared]) {
      await available(sessions.visitor, `/v1/media/uses/${image.use}`, image.etag);
      await available(sessions.visitor, `/v1/media/representations/${image.representation}/bytes?use=${image.use}`, image.etag);
    }
    await available(sessions.visitor, `/v1/media/representations/${closedOnly.representation}/bytes`, closedOnly.etag);
    await closureCommand(sessions.visitor, 'GET', `/v1/media/representations/${closedOnly.representation}`);
    const metadata = await closureCommand<{ items: { status: string }[] }>(sessions.visitor,
      'POST', '/v1/media/metadata', { items: [
        { representation: closedOnly.representation, use: closedOnly.use },
        { representation: closedOnly.representation },
        { representation: shared.representation, use: shared.use },
        { representation: shared.representation, use: independentUse },
      ] });
    expect(metadata.items.map(item => item.status)).toEqual(['available', 'available', 'available', 'available']);
    await closureCredit(sessions.visitor, original.work, sessions.member);
    await effectClosure(sessions, rule);
  });
}, 180_000);
afterAll(async () => {
  try { await recording.publish(); } finally { await sessions?.close(); }
});

async function productionVisit(name: PersonaName) {
  const person = sessions[name];
  const sample = recording.session(name, person);
  const read = async (label: string, representation: string, uses: string[], statuses: string[]) => {
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(url.pathname).toBe(`${BFF_PREFIX}/v1/media/metadata`);
      expect(init?.credentials).toBe(person.actingSubject ? 'same-origin' : 'omit');
      const body = JSON.parse(String(init?.body)) as unknown;
      expect(body).toEqual({ items: uses.map(use => ({ representation, use })),
        ...(person.actingSubject ? { actingSubject: person.actingSubject } : {}) });
      const response = await sample(label, init?.method ?? 'GET',
        url.pathname.slice(BFF_PREFIX.length) + url.search, body);
      expect(response.status).toBe(200);
      const metadata = await response.clone().json() as { items: { status: string }[] };
      expect(metadata.items.map(item => item.status)).toEqual(statuses);
      return response;
    };
    await resolveMediaMetadata(uses.map(use => ({ representationId: representation, mediaUseId: use })),
      person.actingSubject, fetcher);
  };
  // Public commands assign representation and Use IDs. The story's literal
  // IDs can produce only empty metadata; live states use the API-created IDs.
  await read('media-delivery-empty', storyId(1), [storyId(2), storyId(3)], ['unavailable', 'unavailable']);
  await read('media-delivery-closed', shared.representation, [shared.use, independentUse], ['unavailable', 'available']);
  await read('media-delivery-open', shared.representation, [independentUse, otherIndependentUse], ['available', 'available']);
}

async function proveAndVisit(name: PersonaName) {
  await closureCell(media, name, () => sessions, () => delivery(name));
  await productionVisit(name);
}

async function delivery(name: PersonaName) {
  expect(setupFailure, setupFailure ?? '').toBeNull();
  const person = sessions[name];
  for (const query of new Set(['', actor(person)])) await scopedDelivery(person, query);
  if (person.actingSubject) {
    const path = `/v1/media/assets/${shared.asset}/bytes?target=${encodeURIComponent(original.work)}&${actor(person)}`;
    if (name === 'member') {
      // The uploader's independent Asset-owner access is distinct from a
      // closed Realm occurrence. Other roles receive no source-owner bypass.
      const source = await person.main('GET', path);
      expect(source.status, path).toBe(200);
      expect(sha(new Uint8Array(await source.arrayBuffer()))).toBe(sha(bytes));
    } else await absent(person, path,
      `/v1/media/assets/${randomUUID()}/bytes?target=${encodeURIComponent(original.work)}&${actor(person)}`, shared.etag);
  }
  await closureCredit(person, original.work, sessions.member);
}
async function scopedDelivery(person: PersonaSession, query: string) {
  for (const image of [closedOnly, shared]) {
    await absent(person, `/v1/media/uses/${image.use}?${query}`, `/v1/media/uses/${randomUUID()}?${query}`, image.etag);
    await absent(person, `/v1/media/representations/${image.representation}/bytes?use=${image.use}&${query}`,
      `/v1/media/representations/${randomUUID()}/bytes?use=${randomUUID()}&${query}`, image.etag);
    const metadata = await closureCommand<{ items: { status: string }[] }>(person, 'POST', '/v1/media/metadata', {
      ...(person.actingSubject ? { actingSubject: person.actingSubject } : {}),
      items: [{ representation: image.representation, use: image.use }],
    });
    expect(metadata.items).toEqual([{ status: 'unavailable', reference: { representation: image.representation, use: image.use } }]);
  }
  await absent(person, `/v1/media/representations/${closedOnly.representation}/bytes?${query}`,
    `/v1/media/representations/${randomUUID()}/bytes?${query}`, closedOnly.etag);
  await absent(person, `/v1/media/representations/${closedOnly.representation}?${query}`,
    `/v1/media/representations/${randomUUID()}?${query}`, closedOnly.etag);
  const bare = await closureCommand<{ items: { status: string }[] }>(person, 'POST', '/v1/media/metadata', {
    ...(person.actingSubject ? { actingSubject: person.actingSubject } : {}), items: [{ representation: closedOnly.representation }],
  });
  expect(bare.items).toEqual([{ status: 'unavailable', reference: { representation: closedOnly.representation } }]);
  await available(person, `/v1/media/uses/${independentUse}?${query}`, shared.etag);
  await available(person, `/v1/media/representations/${shared.representation}/bytes?use=${independentUse}&${query}`, shared.etag);
  await available(person, `/v1/media/representations/${shared.representation}/bytes?${query}`, shared.etag);
}
outcomeTest(media, 'visitor', () => proveAndVisit('visitor'), recording);
outcomeTest(media, 'stranger', () => proveAndVisit('stranger'), recording);
outcomeTest(media, 'member', () => proveAndVisit('member'), recording);
outcomeTest(media, 'owner', () => proveAndVisit('owner'), recording);
outcomeTest(media, 'moderator', () => proveAndVisit('moderator'), recording);
outcomeTest(media, 'operator', () => proveAndVisit('operator'), recording);
