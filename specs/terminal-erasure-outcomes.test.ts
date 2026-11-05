import { afterEach, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  BobFollow,
  BobReply,
  Fixture,
  HttpRequest,
  Json,
  Kind,
  Persona,
  PublishedCollection,
  PublishedPost,
  Reply,
  Role,
  Store,
  TerminalErasureDriver,
} from './terminal-erasure-driver.ts';

setDefaultTimeout(60_000);
let driver: TerminalErasureDriver | undefined;
const d = () => {
  if (!driver) throw new Error('Terminal erasure driver was not initialized');
  return driver;
};
beforeEach(async () => {
  const location = process.env.TERMINAL_ERASURE_DRIVER;
  if (!location) throw new Error('Terminal erasure outcome driver is required');
  if (!isAbsolute(location) && !location.startsWith('file:'))
    throw new Error('TERMINAL_ERASURE_DRIVER must be an absolute path or file URL');
  const url = isAbsolute(location) ? pathToFileURL(location) : new URL(location);
  if (url.protocol !== 'file:') throw new Error('Terminal erasure driver must use a file URL');
  const binding = await import(url.href);
  if (typeof binding.createTerminalErasureDriver !== 'function')
    throw new Error('Driver must export createTerminalErasureDriver');
  driver = await binding.createTerminalErasureDriver();
});
afterEach(async () => {
  const current = driver;
  driver = undefined;
  await current?.close();
});
const personas: Persona[] = ['anonymous', 'bob', 'alice'];
const kinds: Kind[] = [
  'profile',
  'entry',
  'label',
  'readingSession',
  'log',
  'follow',
  'followCount',
  'privateCollection',
  'unlistedCollection',
  'offer',
  'order',
  'entitlement',
  'preparedExport',
  'zoneSource',
];
const roles: Role[] = [
  'author',
  'editor',
  'uploader',
  'reporter',
  'buyer',
  'seller',
  'delegate',
  'operator',
  'member',
  'actingHuman',
];
const stores: Store[] = ['receipts', 'outbox', 'provenance', 'search', 'imports'];
async function ok<T>(reply: Reply<T>): Promise<T> {
  expect(reply.response.status).toBe(200);
  expect(reply.value).toBeDefined();
  return reply.value!;
}
async function clean(reply: Reply<unknown>, secrets: string[]) {
  const wire = await reply.response.clone().text();
  for (const secret of secrets) {
    expect(secret.length).toBeGreaterThan(0);
    expect(wire).not.toContain(secret);
  }
  const mapped = JSON.stringify(reply.value ?? null);
  for (const secret of secrets) expect(mapped).not.toContain(secret);
}
async function denied(reply: Reply<unknown>, secrets: string[] = [], write = false) {
  expect(write ? [400, 401, 403, 404, 409, 410] : [401, 403, 404, 410]).toContain(reply.response.status);
  expect(reply.value).toBeUndefined();
  expect(reply.response.headers.get('content-type')).toContain('application/problem+json');
  const problem = await reply.response.clone().json();
  expect(problem.effect_status).toBe(write ? 'not_applied' : 'not_applicable');
  await clean(reply, secrets);
}
async function minimized(actor: Persona, request: HttpRequest, secrets: string[]) {
  const reply = await d().request(actor, request);
  if (reply.response.status === 200) await clean(reply, secrets);
  else await denied(reply, secrets);
}
function privateMarkers(f: Fixture) {
  return [
    ...kinds.map((kind) => f.records[kind].marker),
    ...roles.map((role) => f.roles[role].marker),
    ...Object.values(f.history).map((row) => row.marker),
    f.publishedLog.marker,
    f.publicPost.archivedMarker,
    f.publicCollection.privateSourceMarker,
    f.pending.marker,
  ];
}
function noCopies(rows: unknown, secrets: string[]) {
  const wire = JSON.stringify(rows);
  for (const secret of secrets) expect(wire).not.toContain(secret);
}
async function seed() {
  const f = await d().seed();
  expect(Object.keys(f.records).sort()).toEqual([...kinds].sort());
  expect(Object.keys(f.roles).sort()).toEqual([...roles].sort());
  expect(Object.keys(f.history).sort()).toEqual(['deleted', 'private', 'unlisted']);
  expect(new Set(privateMarkers(f)).size).toBe(privateMarkers(f).length);
  for (const marker of privateMarkers(f)) expect(marker.length).toBeGreaterThan(0);
  expect(f.alice.accountId).not.toBe(f.bob.accountId);
  for (const kind of kinds) await ok(await d().request('alice', f.records[kind].point));
  return f;
}
async function confirm(f: Fixture) {
  const { proof } = await ok(await d().freshAuthentication('alice'));
  expect(proof.length).toBeGreaterThan(0);
  const reply = await d().erase('alice', { freshProof: proof, confirmation: f.alice.handle }, randomUUID());
  expect([200, 202, 204]).toContain(reply.response.status);
}
async function erased(f: Fixture) {
  await d().barrier('hold');
  await confirm(f);
  await d().finish();
}
async function absent(f: Fixture) {
  for (const actor of personas) {
    for (const kind of kinds) {
      const target = f.records[kind];
      await denied(await d().request(actor, target.point), [target.marker]);
      expect(target.surfaces.length).toBeGreaterThan(0);
      for (const surface of target.surfaces) await minimized(actor, surface, [target.id, target.marker]);
    }
    await denied(await d().request(actor, f.publishedLog.point), [f.publishedLog.marker]);
    expect(f.publishedLog.surfaces.length).toBeGreaterThan(0);
    for (const read of f.publishedLog.surfaces)
      await minimized(actor, read, [f.publishedLog.id, f.publishedLog.marker]);
    for (const row of Object.values(f.history)) await denied(await d().request(actor, row.read), [row.marker]);
    for (const role of roles) await minimized(actor, f.roles[role].read, [f.roles[role].marker]);
  }
}

test("the barrier is immediate: at confirmation every private, unlisted and export read rejects the deleted account's old bearer and the owner's data is no longer served to anyone", async () => {
  const f = await seed();
  await d().barrier('hold');
  for (const read of Object.values(f.barrierReads)) await ok(await d().request('alice', read));
  await ok(await d().request('anonymous', f.barrierReads.unlisted));
  for (const role of roles) {
    const row = f.roles[role];
    const reply = await d().request(row.reader, row.read);
    await ok(reply);
    expect(await reply.response.clone().text()).toContain(row.marker);
  }
  const queued = await d().request('alice', f.pending.start);
  expect(queued.response.status).toBe(202);
  const before = await d().inspect(f, 'effects');
  await denied(await d().erase('alice', { confirmation: f.alice.handle }, randomUUID()), [], true);
  const { proof } = await ok(await d().freshAuthentication('alice'));
  await denied(
    await d().erase('alice', { freshProof: proof, confirmation: 'incorrect confirmation' }, randomUUID()),
    [],
    true,
  );
  await ok(await d().request('alice', f.barrierReads.private));
  await confirm(f);
  // The barriers remain held: these outcomes cannot be supplied by cleanup.
  for (const actor of personas)
    for (const read of Object.values(f.barrierReads)) await denied(await d().request(actor, read), privateMarkers(f));
  for (const write of Object.values(f.writes)) await denied(await d().request('alice', write), privateMarkers(f), true);
  await absent(f);
  for (const actor of personas) await minimized(actor, f.pending.read, [f.pending.marker]);
  expect(await d().inspect(f, 'effects')).toEqual(before);
  await d().finish();
  for (const actor of personas) await minimized(actor, f.pending.read, [f.pending.marker]);
  expect(await d().inspect(f, 'effects')).toEqual(before);
});

test('after the erasure workers finish, anonymous, bob and the old bearer find no profile, entry, label, reading session or log, follow or follow count, private or unlisted Collection, offer, order, entitlement, prepared export or Zone source of the account', async () => {
  const f = await seed();
  await erased(f);
  await absent(f);
  noCopies((await d().inspect(f, 'sources')).rows, privateMarkers(f));
  noCopies((await d().inspect(f, 'revisions')).rows, privateMarkers(f));
});

test('an eligible public post and a public Collection generation survive with Deleted account attribution and no link back to the account', async () => {
  const f = await seed();
  const original = await ok(await d().request<PublishedPost>('anonymous', f.publicPost.read));
  expect(original.id).toBe(f.publicPost.id);
  expect(original.body).toBe(f.publicPost.body);
  const generation = await ok(await d().request<PublishedCollection>('anonymous', f.publicCollection.read));
  expect(generation.id).toBe(f.publicCollection.id);
  expect(generation.generation).toBe(f.publicCollection.generation);
  expect(generation.subjectIds).toEqual(f.publicCollection.subjectIds);
  await erased(f);
  for (const actor of ['anonymous', 'bob'] as const) {
    const post = await d().request<PublishedPost>(actor, f.publicPost.read);
    const retainedPost = await ok(post);
    expect(retainedPost.id).toBe(original.id);
    expect(retainedPost.body).toBe(original.body);
    expect(retainedPost.attribution).toEqual({ displayName: 'Deleted account' });
    const collection = await d().request<PublishedCollection>(actor, f.publicCollection.read);
    const retainedCollection = await ok(collection);
    expect(retainedCollection.id).toBe(generation.id);
    expect(retainedCollection.generation).toBe(generation.generation);
    expect(retainedCollection.subjectIds).toEqual(generation.subjectIds);
    expect(retainedCollection.attribution).toEqual({ displayName: 'Deleted account' });
    const secrets = [...privateMarkers(f), f.alice.accountId, f.alice.handle, f.publicCollection.pendingOnlyId];
    await clean(post, secrets);
    await clean(collection, secrets);
  }
  await denied(await d().request('alice', f.publicPost.read));
  noCopies((await d().inspect(f, 'revisions')).rows, privateMarkers(f));
});

test("copies of the account's data in receipts, outbox events, provenance, search documents and import records are minimized", async () => {
  const f = await seed();
  const marker = f.records.entry.marker;
  const entry = await d().request('alice', f.records.entry.point);
  await ok(entry);
  expect(await entry.response.clone().text()).toContain(marker);
  for (const store of stores) expect(JSON.stringify((await d().inspect(f, store)).rows)).toContain(marker);
  await erased(f);
  await absent(f);
  // Structural audit identifiers may remain; private payload and credentials may not.
  const secrets = [...privateMarkers(f), f.alice.handle, f.alice.bearer];
  for (const store of stores) noCopies((await d().inspect(f, store)).rows, secrets);
});

test('a retained financial record keeps only its restricted subset and is not readable through any ordinary route', async () => {
  const f = await seed();
  expect(f.financial.ordinaryReads.length).toBeGreaterThan(0);
  expect(Object.keys(f.financial.requiredSubset).length).toBeGreaterThan(0);
  expect(Date.parse(f.financial.expiresAt)).toBeGreaterThan(Date.parse(f.financial.seededAt));
  await ok(await d().request('alice', f.records.order.point));
  await erased(f);
  for (const actor of personas)
    for (const read of f.financial.ordinaryReads) await denied(await d().request(actor, read));
  expect(await d().financial(f)).toEqual([
    {
      payload: f.financial.requiredSubset,
      expiresAt: f.financial.expiresAt,
      access: 'legal-only',
    },
  ]);
  await d().setTime(f.financial.expiresAt);
  await d().finish();
  for (const actor of personas)
    for (const read of f.financial.ordinaryReads) await denied(await d().request(actor, read));
  expect(await d().financial(f)).toEqual([]);
});

test("an ordinary restore, a replayed import and a late webhook do not bring back any of the account's data or benefits", async () => {
  const f = await seed();
  await erased(f);
  const before = await d().inspect(f, 'effects');
  for (const actor of personas) await denied(await d().request(actor, f.restore), [], true);
  // Ingress may acknowledge a harmless duplicate or refuse the deleted target.
  for (const [actor, request] of [
    ['bob', f.importReplay],
    ['anonymous', f.lateWebhook],
  ] as const) {
    const reply = await d().request(actor, request);
    expect([200, 202, 204, 400, 401, 403, 404, 409, 410]).toContain(reply.response.status);
  }
  await d().finish();
  await absent(f);
  expect(await d().inspect(f, 'effects')).toEqual(before);
  for (const store of stores) noCopies((await d().inspect(f, store)).rows, privateMarkers(f));
});

test('the deleted account id is not reused and its handle resolves to nothing', async () => {
  const f = await seed();
  await ok(await d().request('anonymous', f.handleLookup));
  await erased(f);
  for (const actor of personas) await denied(await d().request(actor, f.handleLookup), [f.alice.handle]);
  const registration = await d().request<{ id: string; handle: string }>('anonymous', f.register);
  expect([200, 201]).toContain(registration.response.status);
  expect(registration.value?.id).toBeDefined();
  expect(registration.value!.id.length).toBeGreaterThan(0);
  expect(registration.value!.id).not.toBe(f.alice.accountId);
  expect(registration.value!.handle).not.toBe(f.alice.handle);
  for (const actor of personas) await denied(await d().request(actor, f.handleLookup));
});

test("bob's own data that interacted with the account is unchanged except for de-identified attribution", async () => {
  const f = await seed();
  const reply = await ok(await d().request<BobReply>('bob', f.bobReply));
  const follow = await ok(await d().request<BobFollow>('bob', f.bobFollow));
  expect(reply.authorId).toBe(f.bob.accountId);
  expect(reply.parent.postId).toBe(f.publicPost.id);
  expect(JSON.stringify(reply.parent.attribution)).toContain(f.alice.accountId);
  expect(JSON.stringify(follow.target)).toContain(f.alice.accountId);
  expect(follow.ownerId).toBe(f.bob.accountId);
  expect(f.bobSentinels.length).toBeGreaterThanOrEqual(4);
  const sentinels: Json[] = [];
  for (const read of f.bobSentinels) sentinels.push(await ok(await d().request('bob', read)));
  await erased(f);
  const afterReply = await d().request<BobReply>('bob', f.bobReply);
  expect(await ok(afterReply)).toEqual({
    ...reply,
    parent: { ...reply.parent, attribution: { displayName: 'Deleted account' } },
  });
  const afterFollow = await d().request<BobFollow>('bob', f.bobFollow);
  expect(await ok(afterFollow)).toEqual({ ...follow, target: { displayName: 'Deleted account' } });
  for (let i = 0; i < f.bobSentinels.length; i++)
    expect(await ok(await d().request('bob', f.bobSentinels[i]!))).toEqual(sentinels[i]);
  await clean(afterReply, [f.alice.accountId, f.alice.handle, ...privateMarkers(f)]);
  await clean(afterFollow, [f.alice.accountId, f.alice.handle, ...privateMarkers(f)]);
});
