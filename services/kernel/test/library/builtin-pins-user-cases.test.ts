import { expect, test } from 'bun:test';
import type { HttpResponse } from '../../../../specs/semantic-driver.ts';
import { routeOf } from '../../src/route/route.ts';
import {
  createReleasedDiscoveryFixture,
  discoveryKey,
  type ReleasedDiscoveryFixture,
} from '../support/released-discovery.ts';

type World = ReleasedDiscoveryFixture;
type Kind = 'everything' | 'state' | 'liked';
type Header = {
  id: string;
  curatorAccountId: string;
  membershipKind: string;
  builtinKind: Kind;
  revision: number;
  visibility: string;
  builtin?: { kind: Kind; profileId?: string; stateSetId?: string; stateId?: string };
} & Record<string, unknown>;

function status(r: HttpResponse, expected: number) {
  expect(r.status, `Native HTTP ${r.status}: ${JSON.stringify(r.body)}`).toBe(expected);
  return r;
}
async function world(run: (f: World) => Promise<void>) {
  const f = await createReleasedDiscoveryFixture({ version: 1 });
  try {
    await f.setup.openFeatures(['personal_library']);
    await run(f);
  } finally {
    await f.close();
  }
}
async function discover(f: World) {
  const r = status(
    await f.request('alice', 'GET', `/v1/collections?curatorAccountId=${f.personas.alice.accountId}&limit=100`),
    200,
  );
  expect(Array.isArray(r.body.collections), JSON.stringify(r.body)).toBe(true);
  // This controlled owner has one released state set at most, below the native maximum page size.
  expect(r.body.next).toBeNull();
  return r.body.collections as Header[];
}
async function noMaterialization(f: World, id: string) {
  const key = [routeOf(id), id];
  expect(
    (await f.inspect('SELECT collection_id FROM library.collection WHERE route = $1 AND collection_id = $2', key)).rows,
  ).toEqual([]);
  for (const table of ['resource_grant', 'resource_role_grant', 'resource_initialization'] as const) {
    expect(
      (await f.inspect(`SELECT resource_id FROM access.${table} WHERE route = $1 AND resource_id = $2`, key)).rows,
    ).toEqual([]);
  }
}
async function stateSupport(f: World) {
  const type = f.release.definition.types['schema:Book']!;
  const profile = f.release.definition.libraryProfiles![type.library!.profileId]!;
  const set = profile.entryStateSet!;
  const choice = set.states.find((s) => s.role === 'active')!;
  expect(choice, `Actual released Book state in ${f.release.digest}`).toBeDefined();
  const subject = await f.createSubject('schema:Book', 'Native pin state support');
  const created = status(
    await f.request('alice', 'PUT', `/v1/libraryEntries/${subject.id}`, { state: choice.id }, discoveryKey()),
    201,
  );
  expect(created.body.libraryEntry).toMatchObject({ subjectId: subject.id, state: choice.id });
  return { profileId: profile.id, stateSetId: set.id, stateId: choice.id, siblings: set.states.map((s) => s.id) };
}
function dynamic(c: Header, f: World, kind: Kind) {
  expect(c.membershipKind).toBe('dynamic');
  expect(c.builtinKind).toBe(kind);
  expect(c.curatorAccountId).toBe(f.personas.alice.accountId);
  expect(c.visibility).toBe('private');
  expect(c.revision).toBe(0);
  for (const field of ['memberCount', 'createdAt', 'updatedAt', 'orderEpoch', 'members', 'occurrences']) {
    expect(c[field]).toBeUndefined();
  }
}
async function pinDiscovered(f: World, kind: Kind) {
  const state = kind === 'state' ? await stateSupport(f) : undefined;
  const all = await discover(f);
  const found = all.filter(
    (c) =>
      c.membershipKind === 'dynamic' &&
      c.builtinKind === kind &&
      (state === undefined ||
        (c.builtin?.profileId === state.profileId &&
          c.builtin.stateSetId === state.stateSetId &&
          c.builtin.stateId === state.stateId)),
  );
  expect(found, `Actual native ${kind} discovery: ${JSON.stringify(all)}`).toHaveLength(1);
  const target = found[0]!;
  dynamic(target, f, kind);
  if (state) {
    const siblings = all.filter(
      (c) =>
        c.builtinKind === 'state' &&
        c.builtin?.profileId === state.profileId &&
        c.builtin.stateSetId === state.stateSetId,
    );
    expect(siblings.map((c) => c.builtin!.stateId).sort()).toEqual([...state.siblings].sort());
  }
  await noMaterialization(f, target.id);
  const ordinary = status(await f.request('alice', 'GET', `/v1/collections/${target.id}`), 200).body.collection;
  expect(ordinary).toEqual(target);
  await noMaterialization(f, target.id);
  const key = discoveryKey();
  const pinned = status(await f.request('alice', 'PUT', `/v1/libraryPins/${target.id}`, { revision: 0 }, key), 200);
  expect(pinned.body).toEqual({ revision: 1 });
  expect(pinned.headers.get('cache-control')).toBe('private, no-store');
  const readonly = await f.scoped('alice', ['library_pin:list', 'collection:read']);
  expect(readonly.accountId).toBe(f.personas.alice.accountId);
  const list = status(await readonly.request('GET', '/v1/libraryPins'), 200);
  expect(list.headers.get('cache-control')).toBe('private, no-store');
  expect(list.body).toEqual({ pins: [{ collectionId: target.id, target: ordinary }], revision: 1, next: null });
  await noMaterialization(f, target.id);
  expect(
    status(
      await f.request('alice', 'DELETE', `/v1/libraryPins/${target.id}?revision=1`, undefined, discoveryKey()),
      200,
    ).body,
  ).toEqual({ revision: 2 });
  expect(status(await readonly.request('GET', '/v1/libraryPins'), 200).body).toEqual({
    pins: [],
    revision: 2,
    next: null,
  });
  const later = (await discover(f)).find((c) => c.id === target.id);
  expect(later).toEqual(target);
  expect(status(await f.request('alice', 'GET', `/v1/collections/${target.id}`), 200).body.collection).toEqual(
    ordinary,
  );
  await noMaterialization(f, target.id);
}

test(
  'Pins discovered empty Everything uses the common header resolver without materialization and keeps identity after unpin',
  () => world((f) => pinDiscovered(f, 'everything')),
  180_000,
);

test(
  'Pins discovered empty Liked uses the common header resolver without reactions or materialization and keeps identity after unpin',
  () => world((f) => pinDiscovered(f, 'liked')),
  180_000,
);

test(
  'Pins discovered real released state and empty siblings use the common header resolver without materialization and keep identity after unpin',
  () => world((f) => pinDiscovered(f, 'state')),
  180_000,
);
