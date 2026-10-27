import { afterEach, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  CollectionMembersPage,
  DynamicCollectionView,
  DynamicCollectionsDriver,
  Persona,
  ProfileName,
  SubjectFixture,
  Visibility,
} from './dynamic-collections-driver';

setDefaultTimeout(120_000);
let driver: DynamicCollectionsDriver;
beforeEach(async () => {
  const location = process.env.DYNAMIC_COLLECTIONS_DRIVER;
  if (!location) throw new Error('Dynamic Collection outcome driver is required');
  if (!isAbsolute(location) && !location.startsWith('file:'))
    throw new Error('DYNAMIC_COLLECTIONS_DRIVER must be absolute or a file URL');
  const url = isAbsolute(location) ? pathToFileURL(location) : new URL(location);
  if (url.protocol !== 'file:') throw new Error('DYNAMIC_COLLECTIONS_DRIVER must use a file URL');
  const binding = await import(url.href);
  if (typeof binding.createDynamicCollectionsDriver !== 'function')
    throw new Error('Expected createDynamicCollectionsDriver factory');
  driver = await binding.createDynamicCollectionsDriver();
  await driver.setTime('2030-01-02T00:00:00.000Z');
});
afterEach(async () => {
  const current = driver;
  driver = undefined!;
  await current?.close();
});

let serial = 0;
const key = () => `"dynamic-collections-${++serial}"`;
const get = (as: Persona, path: string) => driver.request(as, { method: 'GET', path });
const write = (as: Persona, method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown) =>
  driver.request(as, { method, path, headers: { 'Idempotency-Key': key() }, ...(body === undefined ? {} : { body }) });

async function json<T>(response: Response, status = 200): Promise<T> {
  expect(response.status).toBe(status);
  return (await response.json()) as T;
}
async function okay(response: Response) {
  expect([200, 201, 202, 204]).toContain(response.status);
  if (response.status !== 204) await response.arrayBuffer();
}
async function problem(response: Response, status: number, code: string) {
  expect(response.headers.get('content-type')).toMatch(/^application\/problem\+json\b/);
  const value = await json<Record<string, unknown>>(response, status);
  expect(value.code).toBe(code);
  return value;
}
function queryPath(collectionId: string, input: {
  limit?: number;
  cursor?: string;
  sort?: string;
  filter?: unknown;
} = {}) {
  const query = new URLSearchParams();
  if (input.limit !== undefined) query.set('limit', String(input.limit));
  if (input.cursor) query.set('cursor', input.cursor);
  if (input.sort) query.set('sort', input.sort);
  if (input.filter !== undefined) query.set('filter', JSON.stringify(input.filter));
  const suffix = query.size ? `?${query}` : '';
  return `/v1/collections/${collectionId}/members${suffix}`;
}
async function members(collectionId: string, as: Persona = 'owner', input: Parameters<typeof queryPath>[1] = {}) {
  return json<CollectionMembersPage>(await get(as, queryPath(collectionId, input)));
}
async function allMembers(collectionId: string, as: Persona = 'owner', limit = 2, filter?: unknown) {
  const result: CollectionMembersPage['members'][number][] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let pageNo = 0; pageNo < 1000; pageNo++) {
    const page = await members(collectionId, as, { limit, ...(cursor ? { cursor } : {}), ...(filter ? { filter } : {}) });
    expect(page.members.length).toBeLessThanOrEqual(limit);
    result.push(...page.members);
    if (page.next === null) return result;
    expect(cursors.has(page.next)).toBe(false);
    cursors.add(page.next);
    cursor = page.next;
  }
  throw new Error('Collection pagination did not terminate');
}
async function ownerCollections() {
  const result = await json<{ collections: (DynamicCollectionView | Record<string, unknown>)[]; next: string | null }>(
    await get('owner', `/v1/accounts/${driver.accounts.owner.id}/collections?limit=100`),
  );
  return result.collections;
}
async function builtin(input: { kind: 'everything' } | {
  kind: 'state'; profileId: string; stateSetId: string; stateId: string; meaningRevision: string;
}) {
  const found = (await ownerCollections()).find((value) => {
    const descriptor = (value as Partial<DynamicCollectionView>).builtin;
    return descriptor?.kind === input.kind &&
      (input.kind === 'everything' || (
        descriptor.kind === 'state' && descriptor.profileId === input.profileId &&
        descriptor.stateSetId === input.stateSetId && descriptor.stateId === input.stateId &&
        descriptor.meaningRevision === input.meaningRevision
      ));
  });
  expect(found).toBeDefined();
  return found as DynamicCollectionView;
}
async function stateCollection(profile: ProfileName, stateIndex = 0) {
  const descriptor = driver.profiles[profile];
  const state = descriptor.states[stateIndex]!;
  return builtin({
    kind: 'state',
    profileId: descriptor.profileId,
    stateSetId: descriptor.stateSetId,
    stateId: state.id,
    meaningRevision: state.meaningRevision,
  });
}
async function subjectIn(profile: ProfileName, stateIndex = 0) {
  const subject = await driver.provisionSubject(profile);
  const state = driver.profiles[profile].states[stateIndex]!;
  await okay(await driver.setEntryState(subject.id, state.id));
  return subject;
}
async function createCurated(visibility: Visibility = 'private') {
  const result = await json<{ collection: Record<string, unknown> }>(await write('owner', 'POST', '/v1/collections', {
    title: 'Curated selection', description: 'An ordered Collection', visibility,
  }), 201);
  return result.collection;
}
async function setVisibility(collection: DynamicCollectionView | Record<string, unknown>, visibility: Visibility) {
  return json<{ collection: Record<string, unknown> }>(await write(
    'owner', 'PATCH', `/v1/collections/${String(collection.id)}`,
    {
      revision: collection.revision,
      title: collection.title,
      description: collection.description,
      visibility,
    },
  ));
}
function subjectIds(page: CollectionMembersPage) {
  return page.members.map((member) => member.subjectId);
}

test('curated and builtin dynamic Collections share one members page cursor and visibility boundary', async () => {
  const first = await subjectIn('game');
  const second = await subjectIn('game');
  const everything = await builtin({ kind: 'everything' });
  const curated = await createCurated();
  await okay(await write('owner', 'POST', `/v1/collections/${String(curated.id)}/members`, {
    subjectId: first.id, note: 'first occurrence',
  }));
  await okay(await write('owner', 'POST', `/v1/collections/${String(curated.id)}/members`, {
    subjectId: second.id, note: 'second occurrence',
  }));

  for (const collectionId of [String(curated.id), everything.id]) {
    const firstPage = await members(collectionId, 'owner', { limit: 1 });
    expect(firstPage.members).toHaveLength(1);
    expect(firstPage.next).toEqual(expect.any(String));
    const secondPage = await members(collectionId, 'owner', { limit: 1, cursor: firstPage.next! });
    expect(secondPage.members).toHaveLength(1);
    expect(secondPage.next).toBeNull();
  }

  for (const id of [String(curated.id), everything.id]) {
    const otherUnknown = await problem(await get('other', `/v1/collections/${driver.unknown.collectionId}/members`), 404, 'not_found');
    expect(await problem(await get('other', `/v1/collections/${id}/members`), 404, 'not_found')).toEqual(otherUnknown);
    const anonUnknown = await problem(await get('anonymous', `/v1/collections/${driver.unknown.collectionId}/members`), 404, 'not_found');
    expect(await problem(await get('anonymous', `/v1/collections/${id}/members`), 404, 'not_found')).toEqual(anonUnknown);
  }
});

test('curated duplicate occurrences keep order and notes while builtins return each subject once', async () => {
  const subject = await subjectIn('recipe');
  const curated = await createCurated();
  const first = await json<{ member: { id: string; subjectId: string; note: string | null } }>(await write(
    'owner', 'POST', `/v1/collections/${String(curated.id)}/members`, { subjectId: subject.id, note: 'first' },
  ), 201);
  const second = await json<{ member: { id: string; subjectId: string; note: string | null } }>(await write(
    'owner', 'POST', `/v1/collections/${String(curated.id)}/members`, { subjectId: subject.id, note: 'second' },
  ), 201);
  expect(first.member.id).not.toBe(second.member.id);
  expect((await allMembers(String(curated.id))).map((item) => item.subjectId)).toEqual([subject.id, subject.id]);
  expect((await allMembers((await builtin({ kind: 'everything' })).id)).map((item) => item.subjectId)).toEqual([subject.id]);
  expect(first.member.note).toBe('first');
  expect(second.member.note).toBe('second');
});

test('game recipe and record profiles share Everything and use scoped profile state identities', async () => {
  const subjects = await Promise.all((['game', 'recipe', 'record'] as const).map((profile) => subjectIn(profile)));
  const everything = await builtin({ kind: 'everything' });
  const everythingIds = new Set((await allMembers(everything.id)).map((item) => item.subjectId));
  expect(everythingIds).toEqual(new Set(subjects.map((subject) => subject.id)));

  for (const [index, profile] of (['game', 'recipe', 'record'] as const).entries()) {
    const selected = await stateCollection(profile);
    expect(selected.builtin).toMatchObject({
      kind: 'state',
      profileId: driver.profiles[profile].profileId,
      stateSetId: driver.profiles[profile].stateSetId,
      stateId: driver.profiles[profile].states[0]!.id,
    });
    expect(subjectIds(await members(selected.id))).toEqual([subjects[index]!.id]);
  }
});

test('an empty owner has one private Everything identity and no state-set fanout', async () => {
  const before = await ownerCollections();
  expect(before.filter((item) => (item as Partial<DynamicCollectionView>).builtin?.kind === 'everything')).toHaveLength(1);
  expect(before.filter((item) => (item as Partial<DynamicCollectionView>).builtin?.kind === 'state')).toHaveLength(0);
  const everything = await builtin({ kind: 'everything' });
  expect(everything.visibility).toBe('private');
  expect(await allMembers(everything.id)).toEqual([]);
  const subject = await driver.provisionSubject('game');
  await okay(await driver.addLabel(subject.id, 'empty-account-profile-use'));
  const after = await ownerCollections();
  expect(after.filter((item) => (item as Partial<DynamicCollectionView>).builtin?.kind === 'state')).toHaveLength(
    driver.profiles.game.states.length,
  );
  expect((await builtin({ kind: 'everything' })).id).toBe(everything.id);
});

test('profile activation and retirement preserve old pins and do not relabel state identity', async () => {
  const original = await subjectIn('game');
  const state = driver.profiles.game.states[0]!;
  const oldView = await stateCollection('game');
  const nextRelease = await driver.activateProfileRelease('game', {
    releaseDigest: `sha256:${'8'.repeat(64)}`,
    states: [{ ...state, label: `${state.label} revised` }, ...driver.profiles.game.states.slice(1)],
  });
  expect(nextRelease.profileId).toBe(driver.profiles.game.profileId);
  const stillSame = await stateCollection('game');
  expect(stillSame.id).toBe(oldView.id);
  expect(subjectIds(await members(stillSame.id))).toContain(original.id);
  await driver.retireProfile('game');
  expect((await builtin({
    kind: 'state', profileId: driver.profiles.game.profileId, stateSetId: driver.profiles.game.stateSetId,
    stateId: state.id, meaningRevision: state.meaningRevision,
  })).id).toBe(oldView.id);
  expect(subjectIds(await members(oldView.id))).toEqual([original.id]);
});

test('labels overlap optional state and retained sessions or holdings preserve Everything membership', async () => {
  const subject = await subjectIn('recipe');
  const everything = await builtin({ kind: 'everything' });
  const stateView = await stateCollection('recipe');
  await okay(await driver.addLabel(subject.id, 'private-marker-7d41'));
  expect(subjectIds(await members(stateView.id))).toEqual([subject.id]);
  await okay(await driver.clearEntryState(subject.id));
  expect(await members(stateView.id)).toMatchObject({ members: [] });
  expect(subjectIds(await members(everything.id))).toContain(subject.id);
  await okay(await driver.startProgressSession(subject.id));
  await okay(await driver.createHolding(subject.id));
  await okay(await driver.removeLabel(subject.id, 'private-marker-7d41'));
  expect(subjectIds(await members(everything.id))).toContain(subject.id);
  await okay(await driver.removeAllPrivateFacts(subject.id));
  expect(subjectIds(await members(everything.id))).not.toContain(subject.id);

  const search = await write('anonymous', 'POST', '/v1/subjects:search', { text: 'private-marker-7d41' });
  const result = await json<{ subjects: { id: string }[] }>(search);
  expect(result.subjects.map((item) => item.id)).not.toContain(subject.id);
  const inspection = await driver.inspect();
  expect(inspection.searchDocuments.filter((item) => item.source === 'personal')).toEqual([]);
  expect(inspection.publicMembership.some((item) => item.collectionId === stateView.id)).toBe(false);
  const publicCollections = await json<{ collections: { id: string }[]; count: { value: number; exact: true } }>(
    await get('owner', `/v1/subjects/${subject.id}/collections`),
  );
  expect(publicCollections.collections.map((item) => item.id)).not.toContain(stateView.id);
  expect(publicCollections.count).toMatchObject({ value: 0, exact: true });
});

test('source fact changes invalidate old cursors and expose current keyset membership', async () => {
  const first = await subjectIn('game');
  const second = await subjectIn('game');
  const firstState = driver.profiles.game.states[0]!;
  const secondState = driver.profiles.game.states[1]!;
  const firstView = await stateCollection('game', 0);
  const secondView = await stateCollection('game', 1);
  const page = await members(firstView.id, 'owner', { limit: 1 });
  expect(page.next).toEqual(expect.any(String));
  await okay(await driver.setEntryState(second.id, secondState.id));
  await problem(await get('owner', queryPath(firstView.id, { limit: 1, cursor: page.next! })), 409, 'stale_cursor');
  expect(subjectIds(await members(firstView.id))).toEqual([first.id]);
  expect(subjectIds(await members(secondView.id))).toContain(second.id);
});

test('curator authorization and viewer-native subject reads apply to dynamic members', async () => {
  const hidden = await driver.provisionSubject('record', { ownerOnlyReadable: true });
  await okay(await driver.setEntryState(hidden.id, driver.profiles.record.states[0]!.id));
  const view = await stateCollection('record');
  expect(subjectIds(await members(view.id, 'owner'))).toContain(hidden.id);
  const unknown = await problem(await get('other', `/v1/collections/${driver.unknown.collectionId}`), 404, 'not_found');
  expect(await problem(await get('other', `/v1/collections/${view.id}`), 404, 'not_found')).toEqual(unknown);
  expect(await problem(await get('suspended', `/v1/collections/${view.id}`), 401, 'invalid_credentials')).toBeDefined();

  const publicView = (await (await setVisibility(view, 'public')).json() as { collection: DynamicCollectionView }).collection;
  expect((await members(publicView.id, 'other')).members).toEqual([]);
  await driver.setSubjectReadability(hidden.id, 'other', true);
  expect(subjectIds(await members(publicView.id, 'other'))).toContain(hidden.id);
  await problem(await write('other', 'PATCH', `/v1/collections/${publicView.id}`, {
    revision: publicView.revision, title: 'stolen', description: null, visibility: 'private',
  }), 404, 'not_found');
});

test('private predicates stay owner-only and public dynamic output contains only readable subjects', async () => {
  const visible = await subjectIn('record');
  const hidden = await driver.provisionSubject('record', { ownerOnlyReadable: true });
  await okay(await driver.setEntryState(hidden.id, driver.profiles.record.states[0]!.id));
  const privateView = await stateCollection('record');
  const privateBody = await json<Record<string, unknown>>(await get('owner', `/v1/collections/${privateView.id}`));
  expect(privateBody).toHaveProperty('collection');
  const privateJson = JSON.stringify(privateBody).toLowerCase();
  expect(privateJson).not.toContain('predicate');
  expect(privateJson).not.toContain('progress');
  expect(privateJson).not.toContain('holding');
  expect(privateJson).not.toContain('querybody');

  const publicView = (await (await setVisibility(privateView, 'public')).json() as { collection: Record<string, unknown> }).collection;
  const publicBody = await json<Record<string, unknown>>(await get('other', `/v1/collections/${privateView.id}`));
  const page = await members(privateView.id, 'other');
  expect(subjectIds(page)).toEqual([visible.id]);
  const publicJson = JSON.stringify({ publicBody, page }).toLowerCase();
  for (const privateField of ['state', 'label', 'progress', 'holding', 'predicate', 'query', 'profilepin', 'membercount'])
    expect(publicJson).not.toContain(privateField);
  expect(publicBody).not.toHaveProperty('builtin');
  expect(publicBody).not.toHaveProperty('query');
  expect(publicBody).not.toHaveProperty('memberCount');
  expect(publicView).toHaveProperty('membershipKind', 'dynamic');
});

test('public dynamic revocation withholds stale membership and older projection events cannot restore it', async () => {
  const subject = await subjectIn('game');
  const view = await stateCollection('game');
  const publicView = (await (await setVisibility(view, 'public')).json() as { collection: DynamicCollectionView }).collection;
  await driver.resumeAndSettle();
  expect(subjectIds(await members(publicView.id, 'anonymous'))).toContain(subject.id);
  await driver.holdProjectionConsumer();
  await okay(await driver.setEntryState(subject.id, driver.profiles.game.states[1]!.id));
  expect(subjectIds(await members(publicView.id, 'anonymous'))).not.toContain(subject.id);
  await driver.resumeAndSettle();
  await driver.replayProjectionEvents('reverse');
  expect(subjectIds(await members(publicView.id, 'anonymous'))).not.toContain(subject.id);
  expect((await driver.inspect()).publicMembership.filter((item) => item.collectionId === publicView.id)).toEqual([]);
});

test('bounded Collection filters advance opaque prefixes through hidden and filtered candidates without joins', async () => {
  const subjects: SubjectFixture[] = [];
  for (let index = 0; index < 9; index++) subjects.push(await subjectIn(index % 2 ? 'recipe' : 'game'));
  const everything = await builtin({ kind: 'everything' });
  const sparse = { type: { in: [driver.profiles.record.typeId] } };
  const empty = await members(everything.id, 'owner', { limit: 1, filter: sparse });
  expect(empty.members).toEqual([]);
  expect(empty.next).toEqual(expect.any(String));
  const next = await members(everything.id, 'owner', { limit: 1, filter: sparse, cursor: empty.next! });
  expect(next.next).not.toBe(empty.next);

  const unsupported = await problem(await get('owner', queryPath(everything.id, {
    filter: { statement: { property: 'private:unindexed', in: ['secret'] } },
  })), 422, 'unsupported_query');
  expect(unsupported).toBeDefined();
  const measured = await driver.measure(() => get('owner', queryPath(everything.id, { limit: 10, filter: sparse })));
  expect(measured.candidateIds.length).toBeLessThanOrEqual(40);
  expect(measured.crossPartitionJoins).toBe(0);
  expect(measured.rowsExamined).toBeLessThanOrEqual(8 * 10 + 32);
  expect(measured.classifier).toBe('bounded-keyset');
});

test('shared cursors bind viewer Collection sort size profile generation and keyset and reject tamper or expiry', async () => {
  const first = await subjectIn('game');
  await subjectIn('game');
  const view = await builtin({ kind: 'everything' });
  const page = await members(view.id, 'owner', { limit: 1 });
  expect(page.next).toEqual(expect.any(String));
  const token = page.next!;
  expect(token).not.toContain(view.id);
  expect(token).not.toContain(driver.accounts.owner.id);
  expect(token).not.toContain(driver.profiles.game.profileId);
  expect(token).not.toContain(driver.profiles.game.states[0]!.id);
  expect(await members(view.id, 'owner', { limit: 1, cursor: token })).toMatchObject({ members: [expect.any(Object)] });
  await problem(await get('other', queryPath(view.id, { limit: 1, cursor: token })), 400, 'invalid_cursor');
  await problem(await get('owner', queryPath(view.id, { limit: 2, cursor: token })), 400, 'invalid_cursor');
  const tampered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
  await problem(await get('owner', queryPath(view.id, { limit: 1, cursor: tampered })), 400, 'invalid_cursor');
  await okay(await driver.setEntryState(first.id, driver.profiles.game.states[1]!.id));
  await problem(await get('owner', queryPath(view.id, { limit: 1, cursor: token })), 409, 'stale_cursor');

  const fresh = await members(view.id, 'owner', { limit: 1 });
  await driver.setTime('2030-02-02T00:00:00.000Z');
  await problem(await get('owner', queryPath(view.id, { limit: 1, cursor: fresh.next! })), 400, 'expired_cursor');
});

test('follow mount export and bulk selection use the Collection identity and unique dynamic subjects', async () => {
  const subject = await subjectIn('recipe');
  const view = await builtin({ kind: 'everything' });
  const publicView = (await (await setVisibility(view, 'public')).json() as { collection: DynamicCollectionView }).collection;
  await okay(await write('owner', 'PUT', `/v1/follows/${publicView.id}`));
  await okay(await driver.mountCollection(publicView.id));
  const exported = await driver.exportCollection(publicView.id, 'owner');
  const itemList = await json<{ '@type': string; itemListElement: { item: string }[] }>(exported);
  expect(itemList['@type']).toBe('ItemList');
  expect(itemList.itemListElement.map((item) => item.item)).toEqual([subject.id]);
  const bulk = await driver.runCollectionBulkAction(publicView.id, {
    action: 'set_status',
    stateId: driver.profiles.recipe.states[1]!.id,
    selection: { kind: 'collection', collectionId: publicView.id },
  });
  expect(bulk.status).toBe(202);
  await driver.resumeAndSettle();
  expect(subjectIds(await members((await stateCollection('recipe', 1)).id))).toContain(subject.id);
});

test('unpublish hides dynamic results immediately and a visibility-revocation stamp defeats stale events', async () => {
  const subject = await subjectIn('game');
  const view = await stateCollection('game');
  const publicView = (await (await setVisibility(view, 'public')).json() as { collection: DynamicCollectionView }).collection;
  await driver.resumeAndSettle();
  expect(subjectIds(await members(publicView.id, 'anonymous'))).toContain(subject.id);
  await driver.holdProjectionConsumer();
  const privateView = (await (await setVisibility(publicView, 'private')).json() as { collection: DynamicCollectionView }).collection;
  await problem(await get('anonymous', `/v1/collections/${publicView.id}/members`), 404, 'not_found');
  await driver.resumeAndSettle();
  await driver.replayProjectionEvents('reverse');
  expect((await members(privateView.id, 'owner')).members.map((item) => item.subjectId)).toContain(subject.id);
  expect((await driver.inspect()).publicMembership.filter((item) => item.collectionId === publicView.id)).toEqual([]);
});

test('account deletion freezes adopted public subjects without waiting for consumers and erases private predicates', async () => {
  const publicSubject = await subjectIn('game');
  const privateSubject = await subjectIn('recipe');
  const publicView = await stateCollection('game');
  const privateView = await stateCollection('recipe');
  const published = (await (await setVisibility(publicView, 'public')).json() as { collection: DynamicCollectionView }).collection;
  await driver.resumeAndSettle();
  const before = (await members(published.id, 'anonymous')).members.map((item) => item.subjectId);
  expect(before).toContain(publicSubject.id);

  await driver.holdProjectionConsumer();
  await okay(await driver.deleteAccount());
  const inspection = await driver.inspect();
  expect(inspection.collections.find((item) => item.id === published.id)?.frozen).toBe(true);
  expect(inspection.collections.some((item) => item.id === privateView.id)).toBe(false);
  expect(inspection.facts.filter((item) => item.accountId === driver.accounts.owner.id)).toEqual([]);
  expect(await members(published.id, 'anonymous')).toMatchObject({ members: before.map((subjectId) => ({ subjectId })) });
  await driver.resumeAndSettle();
  await driver.replayProjectionEvents('reverse');
  expect((await members(published.id, 'anonymous')).members.map((item) => item.subjectId)).toEqual(before);
  const publicDto = await json<Record<string, unknown>>(await get('anonymous', `/v1/collections/${published.id}`));
  expect(JSON.stringify(publicDto).toLowerCase()).not.toContain('predicate');
});

test('three-scale native page work stays within the candidate cap and shared growth classifier', async () => {
  const everything = await builtin({ kind: 'everything' });
  const sparse = { type: { in: [driver.profiles.record.typeId] } };
  const samples = [];
  for (const scale of [100, 1_000, 10_000]) {
    await driver.seedUnrelatedFacts(scale);
    samples.push(await driver.measure(() => get('owner', queryPath(everything.id, { limit: 10, filter: sparse }))));
  }
  for (const sample of samples) {
    expect(sample.candidateIds.length).toBeLessThanOrEqual(40);
    expect(sample.rowsExamined).toBeLessThanOrEqual(112);
    expect(sample.crossPartitionJoins).toBe(0);
    expect(sample.classifier).toBe('bounded-keyset');
  }
  expect(new Set(samples.map((sample) => sample.statements)).size).toBe(1);
  expect(new Set(samples.map((sample) => sample.rowsExamined)).size).toBe(1);
  expect(samples[2]!.buffers - samples[0]!.buffers).toBeLessThanOrEqual(64);
});
