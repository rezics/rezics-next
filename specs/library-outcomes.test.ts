import { afterEach, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  CollectionView,
  CopyView,
  EntryState,
  EntryView,
  FollowView,
  LibraryDriver,
  MemberView,
  Persona,
  ProgressChange,
  ProgressMode,
  ProgressUnit,
  PublicCollectionView,
  PublishedLogView,
  SessionView,
  Visibility,
} from './library-driver';

setDefaultTimeout(120_000);
let driver: LibraryDriver;
beforeEach(async () => {
  const location = process.env.LIBRARY_DRIVER;
  if (!location) throw new Error('Library outcome driver is required');
  if (!isAbsolute(location) && !location.startsWith('file:'))
    throw new Error('LIBRARY_DRIVER must be absolute or a file URL');
  const url = isAbsolute(location) ? pathToFileURL(location) : new URL(location);
  if (url.protocol !== 'file:') throw new Error('LIBRARY_DRIVER must use a file URL');
  const binding = await import(url.href);
  if (typeof binding.createLibraryDriver !== 'function') throw new Error('Expected createLibraryDriver factory');
  driver = await binding.createLibraryDriver();
  await driver.setTime('2030-01-02T00:00:00.000Z');
});
afterEach(async () => {
  const current = driver;
  driver = undefined!;
  await current?.close();
});
let serial = 0;
const key = () => `"library-${++serial}"`;
const get = (path: string, as: Persona = 'owner') => driver.request(as, { method: 'GET', path });
function write(
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  as: Persona = 'owner',
  idempotencyKey = key(),
) {
  return driver.request(as, { method, path, headers: { 'Idempotency-Key': idempotencyKey }, body });
}
async function body<T>(response: Response, status = 200): Promise<T> {
  expect(response.status).toBe(status);
  return (await response.json()) as T;
}
async function ok(response: Response) {
  expect([200, 204]).toContain(response.status);
}
async function problem(response: Response, status: number, code?: string) {
  expect(response.headers.get('content-type')).toMatch(/^application\/problem\+json\b/);
  const result = await body<Record<string, unknown>>(response, status);
  expect(result).toMatchObject({ type: expect.any(String), title: expect.any(String), status });
  if (code) expect(result.code).toBe(code);
  const { request_id: _request, ...stable } = result;
  return stable;
}
async function hidden(path: string, unknown: string, as: Persona) {
  expect(await problem(await get(path, as), 404, 'not_found')).toEqual(
    await problem(await get(unknown, as), 404, 'not_found'),
  );
}
function pagePath(path: string, limit: number, cursor?: string) {
  return `${path}${path.includes('?') ? '&' : '?'}limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
}
type SubjectCollectionCount = { value: number; exact: true };
type LibraryPage<T> = { items: T[]; next: string | null; count?: SubjectCollectionCount };
async function page<T>(
  path: string,
  plural: string,
  as: Persona = 'owner',
  extraKeys: readonly string[] = [],
): Promise<LibraryPage<T>> {
  const result = await body<Record<string, unknown>>(await get(path, as));
  expect(Object.keys(result).sort()).toEqual([plural, 'next', ...extraKeys].sort());
  expect(Array.isArray(result[plural])).toBe(true);
  expect(result.next === null || typeof result.next === 'string').toBe(true);
  let count: Record<string, unknown> | undefined;
  if (extraKeys.includes('count')) {
    expect(result.count).not.toBeNull();
    expect(result.count).toBeDefined();
    count = result.count as Record<string, unknown>;
    expect(count.exact).toBe(true);
    expect(Number.isInteger(count.value) && (count.value as number) >= 0).toBe(true);
  }
  return {
    items: result[plural] as T[],
    next: result.next as string | null,
    ...(count ? { count: count as SubjectCollectionCount } : {}),
  };
}
async function all<T>(
  path: string,
  plural: string,
  as: Persona = 'owner',
  limit = 2,
  options: { extraKeys?: readonly string[]; countMatchesItems?: boolean } = {},
) {
  const result: T[] = [];
  const seen = new Set<string>();
  let currentCount: SubjectCollectionCount | undefined;
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < 3000; pageNumber++) {
    const current: LibraryPage<T> = await page<T>(pagePath(path, limit, cursor), plural, as, options.extraKeys);
    if (current.count) {
      if (currentCount) expect(current.count).toEqual(currentCount);
      currentCount = current.count;
    }
    expect(current.items.length).toBeLessThanOrEqual(limit);
    result.push(...current.items);
    if (current.next === null) {
      if (options.countMatchesItems) expect(currentCount?.value).toBe(result.length);
      return result;
    }
    expect(current.items.length).toBeGreaterThan(0);
    expect(seen.has(current.next)).toBe(false);
    seen.add(current.next);
    cursor = current.next;
  }
  throw new Error('Pagination did not terminate');
}
async function collection(visibility: Visibility = 'private', title = 'Reading shelf') {
  const value = (
    await body<{ collection: CollectionView }>(
      await write('POST', '/v1/collections', {
        title,
        description: 'A curated shelf',
        visibility,
      }),
      201,
    )
  ).collection;
  expect(value).toEqual({
    id: expect.any(String),
    curatorAccountId: driver.accounts.owner.id,
    title,
    description: 'A curated shelf',
    visibility,
    revision: expect.any(Number),
    memberCount: 0,
    createdAt: expect.any(String),
    updatedAt: expect.any(String),
  });
  expect(Number.isFinite(Date.parse(value.createdAt))).toBe(true);
  return value;
}
async function collectionView(id: string) {
  return (await body<{ collection: CollectionView }>(await get(`/v1/collections/${id}`))).collection;
}
async function member(collectionId: string, subjectId: string, options: { after?: string | null; note?: string } = {}) {
  const value = (
    await body<{ member: MemberView }>(
      await write('POST', `/v1/collections/${collectionId}/members`, {
        subjectId,
        ...options,
      }),
      201,
    )
  ).member;
  expect(value).toEqual({ id: expect.any(String), subjectId, note: options.note ?? null, addedAt: expect.any(String) });
  expect(Number.isFinite(Date.parse(value.addedAt))).toBe(true);
  return value;
}
const membersPath = (id: string) => `/v1/collections/${id}/members`;
const members = (id: string) => all<MemberView>(membersPath(id), 'members');
async function entry(subjectId: string, state: EntryState, current?: EntryView) {
  const value = (
    await body<{ libraryEntry: EntryView }>(
      await write('PUT', `/v1/libraryEntries/${subjectId}`, {
        state,
        ...(current === undefined ? {} : { revision: current.revision, incarnationId: current.incarnationId }),
      }),
      current === undefined ? 201 : 200,
    )
  ).libraryEntry;
  expect(value).toMatchObject({
    subjectId,
    incarnationId: expect.any(String),
    state,
    revision: expect.any(Number),
    createdAt: expect.any(String),
    updatedAt: expect.any(String),
  });
  return value;
}
async function entryView(subjectId: string) {
  return (await body<{ libraryEntry: EntryView }>(await get(`/v1/libraryEntries/${subjectId}`))).libraryEntry;
}
async function session(
  subjectId: string,
  mode: ProgressMode = 'scalar_amount',
  unit: ProgressUnit = 'minute',
  extras: { total?: string; versionSubjectId?: string } = {},
) {
  const value = (
    await body<{ progressSession: SessionView }>(
      await write('POST', '/v1/progressSessions', {
        subjectId,
        mode,
        unit,
        ...extras,
      }),
      201,
    )
  ).progressSession;
  expect(value).toMatchObject({
    id: expect.any(String),
    subjectId,
    mode,
    unit,
    versionSubjectId: extras.versionSubjectId ?? null,
    total: extras.total ?? null,
    state: 'active',
    revision: expect.any(Number),
    completedUnitCount: 0,
    startedAt: expect.any(String),
    completedAt: null,
  });
  return value;
}
async function sessionView(id: string) {
  return (await body<{ progressSession: SessionView }>(await get(`/v1/progressSessions/${id}`))).progressSession;
}
async function record(current: SessionView, intent: unknown) {
  await ok(
    await write('POST', `/v1/progressSessions/${current.id}:record`, {
      revision: current.revision,
      ...(intent as object),
    }),
  );
  return sessionView(current.id);
}
async function copy(subjectId: string) {
  const value = (
    await body<{ copy: CopyView }>(
      await write('POST', '/v1/copies', {
        subjectId,
        kind: 'physical',
        status: 'owned',
        location: 'Study',
        source: 'Bookshop',
        acquiredOn: '2030-01-01',
        note: 'First copy',
      }),
      201,
    )
  ).copy;
  expect(value).toMatchObject({
    id: expect.any(String),
    subjectId,
    status: 'owned',
    location: 'Study',
    source: 'Bookshop',
    acquiredOn: '2030-01-01',
    note: 'First copy',
    disposedOn: null,
    revision: expect.any(Number),
  });
  return value;
}
async function follow(targetId: string) {
  return (await body<{ follow: FollowView }>(await get(`/v1/follows/${targetId}`))).follow;
}
async function publicCollections(subjectId: string) {
  return all<PublicCollectionView>(`/v1/subjects/${subjectId}/collections`, 'collections', 'anonymous', 2, {
    extraKeys: ['count'],
    countMatchesItems: true,
  });
}
async function publish(sessionId: string) {
  return (
    await body<{ publishedLog: PublishedLogView }>(
      await write('POST', '/v1/publishedLogs', {
        sessionId,
        note: 'A public reading milestone',
      }),
      201,
    )
  ).publishedLog;
}

test('public private and unlisted Collections enforce owner other and anonymous visibility', async () => {
  const visible = await collection('public');
  const privateShelf = await collection('private');
  const unlisted = await collection('unlisted');
  for (const as of ['owner', 'other', 'anonymous'] as const) {
    for (const item of [visible, unlisted]) {
      expect(await body(await get(`/v1/collections/${item.id}`, as))).toEqual({ collection: item });
    }
    if (as !== 'owner')
      await hidden(`/v1/collections/${privateShelf.id}`, `/v1/collections/${driver.unknown.collectionId}`, as);
  }
  expect(await collectionView(privateShelf.id)).toEqual(privateShelf);
  const path = `/v1/collections?curatorAccountId=${driver.accounts.owner.id}`;
  expect((await all<CollectionView>(path, 'collections')).map((item) => item.id).sort()).toEqual(
    [visible.id, privateShelf.id, unlisted.id].sort(),
  );
  for (const as of ['other', 'anonymous'] as const) {
    expect(await all(path, 'collections', as)).toEqual([visible]);
    await hidden(membersPath(privateShelf.id), membersPath(driver.unknown.collectionId), as);
    expect(await all(membersPath(unlisted.id), 'members', as)).toEqual([]);
  }
});

test('Collection revision guards update and deletion without changing stale snapshots', async () => {
  const shelf = await collection();
  await driver.setTime('2030-01-03T00:00:00.000Z');
  const changed = (
    await body<{ collection: CollectionView }>(
      await write('PATCH', `/v1/collections/${shelf.id}`, {
        revision: shelf.revision,
        title: 'Revised shelf',
        description: 'Revised description',
        visibility: 'public',
      }),
    )
  ).collection;
  expect(changed).toMatchObject({
    id: shelf.id,
    title: 'Revised shelf',
    description: 'Revised description',
    visibility: 'public',
    revision: shelf.revision + 1,
    createdAt: shelf.createdAt,
  });
  expect(Date.parse(changed.updatedAt)).toBeGreaterThan(Date.parse(shelf.updatedAt));
  await driver.settle();
  const before = await driver.inspect();
  await problem(
    await write('PATCH', `/v1/collections/${shelf.id}`, { revision: shelf.revision, title: 'Lost' }),
    409,
    'conflict',
  );
  await problem(await write('DELETE', `/v1/collections/${shelf.id}?revision=${shelf.revision}`), 409, 'conflict');
  expect(await collectionView(shelf.id)).toEqual(changed);
  expect(await driver.inspect()).toEqual(before);
  expect((await write('DELETE', `/v1/collections/${shelf.id}?revision=${changed.revision}`)).status).toBe(204);
  await hidden(`/v1/collections/${shelf.id}`, `/v1/collections/${driver.unknown.collectionId}`, 'owner');
});

test('members preserve first after last moves notes deletes and duplicate subjects across pages', async () => {
  const shelf = await collection('public');
  const subject = await driver.provisionSubject();
  const another = await driver.provisionSubject();
  const a = await member(shelf.id, subject.id, { note: 'Original' });
  const b = await member(shelf.id, another.id);
  const first = await member(shelf.id, subject.id, { after: null });
  const middle = await member(shelf.id, another.id, { after: a.id });
  const last = await member(shelf.id, subject.id);
  expect(await members(shelf.id)).toEqual([first, a, middle, b, last]);
  expect(new Set((await members(shelf.id)).map((item) => item.id)).size).toBe(5);
  await ok(await write('POST', `${membersPath(shelf.id)}/${last.id}:move`, { after: first.id }));
  expect((await members(shelf.id)).map((item) => item.id)).toEqual([first.id, last.id, a.id, middle.id, b.id]);
  await ok(await write('POST', `${membersPath(shelf.id)}/${b.id}:move`, { after: null }));
  await ok(await write('PATCH', `${membersPath(shelf.id)}/${a.id}`, { note: 'Revised note' }));
  expect((await members(shelf.id)).map((item) => item.id)).toEqual([b.id, first.id, last.id, a.id, middle.id]);
  expect((await members(shelf.id)).find((item) => item.id === a.id)).toEqual({ ...a, note: 'Revised note' });
  await ok(await write('DELETE', `${membersPath(shelf.id)}/${middle.id}`));
  expect((await members(shelf.id)).map((item) => item.id)).toEqual([b.id, first.id, last.id, a.id]);
  expect((await collectionView(shelf.id)).memberCount).toBe(4);
  for (const as of ['other', 'anonymous'] as const) {
    expect(await all(membersPath(shelf.id), 'members', as)).toEqual(await members(shelf.id));
  }
});

test('two hundred inserts after one member respace bounded keys and reject the pre-respacing cursor', async () => {
  const shelf = await collection();
  const subject = await driver.provisionSubject();
  const anchor = await member(shelf.id, subject.id);
  const tail = await member(shelf.id, subject.id);
  const oldPage = await page<MemberView>(pagePath(membersPath(shelf.id), 1), 'members');
  expect(oldPage.items).toEqual([anchor]);
  expect(oldPage.next).toBeTruthy();
  const oldKeys = new Map((await driver.inspect()).members.map((item) => [item.id, item.orderKey]));
  const inserted: MemberView[] = [];
  let respaced = false;
  for (let count = 0; count < 200; count++) {
    inserted.unshift(await member(shelf.id, subject.id, { after: anchor.id }));
    const rows = (await driver.inspect()).members.filter((item) => item.collectionId === shelf.id);
    expect(rows).toHaveLength(count + 3);
    for (const row of rows) {
      expect(row.orderKey.length).toBeGreaterThan(0);
      expect(row.orderKey.length).toBeLessThanOrEqual(48);
      if (oldKeys.has(row.id) && oldKeys.get(row.id) !== row.orderKey) respaced = true;
      oldKeys.set(row.id, row.orderKey);
    }
  }
  expect(respaced).toBe(true);
  await problem(await get(pagePath(membersPath(shelf.id), 1, oldPage.next!)), 409, 'stale_cursor');
  expect(await all(membersPath(shelf.id), 'members', 'owner', 17)).toEqual([anchor, ...inserted, tail]);
});

test('five thousand members succeed and the next member fails collection_full without any change', async () => {
  const shelf = await collection();
  const subject = await driver.provisionSubject();
  await driver.seedMembers({ collectionId: shelf.id, subjectId: subject.id, count: 5000 });
  await driver.settle();
  expect((await collectionView(shelf.id)).memberCount).toBe(5000);
  const rows = await all<MemberView>(membersPath(shelf.id), 'members', 'owner', 100);
  expect(rows).toHaveLength(5000);
  expect(new Set(rows.map((item) => item.id)).size).toBe(5000);
  const before = await driver.inspect();
  await problem(await write('POST', membersPath(shelf.id), { subjectId: subject.id }), 409, 'collection_full');
  expect(await driver.inspect()).toEqual(before);
  expect((await collectionView(shelf.id)).memberCount).toBe(5000);
});

test('another account cannot mutate private or public Collections or their members', async () => {
  const subject = await driver.provisionSubject();
  for (const visibility of ['private', 'public'] as const) {
    const shelf = await collection(visibility);
    const item = await member(shelf.id, subject.id);
    await driver.settle();
    const before = await driver.inspect();
    const attempts = [
      () => write('PATCH', `/v1/collections/${shelf.id}`, { revision: shelf.revision, title: 'Stolen' }, 'other'),
      () => write('DELETE', `/v1/collections/${shelf.id}?revision=${shelf.revision}`, undefined, 'other'),
      () => write('POST', membersPath(shelf.id), { subjectId: subject.id }, 'other'),
      () => write('PATCH', `${membersPath(shelf.id)}/${item.id}`, { note: 'Stolen' }, 'other'),
      () => write('POST', `${membersPath(shelf.id)}/${item.id}:move`, { after: null }, 'other'),
      () => write('DELETE', `${membersPath(shelf.id)}/${item.id}`, undefined, 'other'),
    ];
    for (const attempt of attempts) {
      const response = await attempt();
      expect(visibility === 'private' ? [404] : [403, 404]).toContain(response.status);
      const denied = await problem(response, response.status);
      if (visibility === 'private') {
        expect(denied.effect_status).toBe('not_applied');
        const concealed = Object.fromEntries(Object.entries(denied).filter(([field]) => field !== 'effect_status'));
        const unknown = await problem(await get(`/v1/collections/${driver.unknown.collectionId}`, 'other'), 404);
        const unknownConcealed = Object.fromEntries(
          Object.entries(unknown).filter(([field]) => field !== 'effect_status'),
        );
        expect(concealed).toEqual(unknownConcealed);
      }
      await driver.settle();
      expect(await driver.inspect()).toEqual(before);
    }
    if (visibility === 'private') {
      const hiddenPatch = await problem(
        await write('PATCH', `/v1/collections/${shelf.id}`, { revision: shelf.revision, title: 'Stolen' }, 'other'),
        404,
      );
      const unknownPatch = await problem(
        await write(
          'PATCH',
          `/v1/collections/${driver.unknown.collectionId}`,
          { revision: shelf.revision, title: 'Stolen' },
          'other',
        ),
        404,
      );
      expect(hiddenPatch).toEqual(unknownPatch);
      expect(hiddenPatch.effect_status).toBe('not_applied');
      await driver.settle();
      expect(await driver.inspect()).toEqual(before);
    }
    expect(await members(shelf.id)).toEqual([item]);
    expect((await collectionView(shelf.id)).title).toBe(shelf.title);
  }
});

test('deleted Collection becomes unknown and leaves public subject and curator listings after settle', async () => {
  const subject = await driver.provisionSubject();
  const shelf = await collection('public');
  await member(shelf.id, subject.id);
  await driver.settle();
  expect(await publicCollections(subject.id)).toEqual([
    { id: shelf.id, curatorAccountId: driver.accounts.owner.id, title: shelf.title, multiplicity: 1 },
  ]);
  const current = await collectionView(shelf.id);
  expect((await write('DELETE', `/v1/collections/${shelf.id}?revision=${current.revision}`)).status).toBe(204);
  await driver.settle();
  await hidden(`/v1/collections/${shelf.id}`, `/v1/collections/${driver.unknown.collectionId}`, 'anonymous');
  await hidden(membersPath(shelf.id), membersPath(driver.unknown.collectionId), 'owner');
  expect(await publicCollections(subject.id)).toEqual([]);
  expect(await all(`/v1/collections?curatorAccountId=${driver.accounts.owner.id}`, 'collections', 'anonymous')).toEqual(
    [],
  );
});

test('library entry states are exclusive and missing stale or unknown revisions change nothing', async () => {
  const subject = await driver.provisionSubject();
  const states: EntryState[] = ['planned', 'in_progress', 'completed', 'paused', 'dropped'];
  let current = await entry(subject.id, 'planned');
  for (const state of states) {
    await driver.setTime(`2030-01-0${states.indexOf(state) + 3}T00:00:00.000Z`);
    const previous = current;
    current = await entry(subject.id, state, current);
    expect(current.revision).toBe(previous.revision + 1);
    expect(current.createdAt).toBe(previous.createdAt);
    for (const filter of states) {
      expect(await all(`/v1/libraryEntries?state=${filter}`, 'libraryEntries')).toEqual(
        filter === state ? [current] : [],
      );
    }
  }
  await driver.settle();
  const before = await driver.inspect();
  for (const payload of [
    { state: 'planned' },
    { state: 'planned', revision: current.revision - 1, incarnationId: current.incarnationId },
  ]) {
    await problem(await write('PUT', `/v1/libraryEntries/${subject.id}`, payload), 409, 'conflict');
  }
  await problem(
    await write(
      'DELETE',
      `/v1/libraryEntries/${subject.id}?revision=${current.revision - 1}&incarnationId=${encodeURIComponent(current.incarnationId)}`,
    ),
    409,
    'conflict',
  );
  await problem(
    await write('PUT', `/v1/libraryEntries/${driver.unknown.subjectId}`, { state: 'planned' }),
    404,
    'not_found',
  );
  expect(await driver.inspect()).toEqual(before);
  expect(await entryView(subject.id)).toEqual(current);
  await ok(
    await write(
      'DELETE',
      `/v1/libraryEntries/${subject.id}?revision=${current.revision}&incarnationId=${encodeURIComponent(current.incarnationId)}`,
    ),
  );
  await hidden(`/v1/libraryEntries/${subject.id}`, `/v1/libraryEntries/${driver.unknown.subjectId}`, 'owner');
  expect(await all('/v1/libraryEntries', 'libraryEntries')).toEqual([]);
});

test('entries list newest updates first once each through cursor pages', async () => {
  const first = await driver.provisionSubject();
  const second = await driver.provisionSubject();
  const a = await entry(first.id, 'planned');
  await driver.setTime('2030-01-03T00:00:00.000Z');
  const b = await entry(second.id, 'completed');
  expect(await all('/v1/libraryEntries', 'libraryEntries', 'owner', 1)).toEqual([b, a]);
  await driver.setTime('2030-01-04T00:00:00.000Z');
  const newer = await entry(first.id, 'paused', a);
  expect(await all('/v1/libraryEntries', 'libraryEntries', 'owner', 1)).toEqual([newer, b]);
});

test('entry incarnation guards reject missing foreign and ABA writes while exact receipts retain their captured guards', async () => {
  const subject = await driver.provisionSubject();
  const foreignSubject = await driver.provisionSubject();
  const first = await entry(subject.id, 'planned');
  const foreign = await entry(foreignSubject.id, 'planned');
  const path = `/v1/libraryEntries/${subject.id}`;
  const deletePath = (captured: EntryView) =>
    `${path}?revision=${captured.revision}&incarnationId=${encodeURIComponent(captured.incarnationId)}`;
  expect(first.incarnationId).not.toBe(foreign.incarnationId);
  await driver.settle();
  const before = await driver.inspect();
  for (const payload of [
    { state: 'paused', revision: first.revision },
    { state: 'paused', revision: first.revision, incarnationId: foreign.incarnationId },
  ])
    await problem(await write('PUT', path, payload), 409, 'conflict');
  await problem(await write('DELETE', `${path}?revision=${first.revision}`), 409, 'conflict');
  await problem(
    await write(
      'DELETE',
      `${path}?revision=${first.revision}&incarnationId=${encodeURIComponent(foreign.incarnationId)}`,
    ),
    409,
    'conflict',
  );
  expect(await driver.inspect()).toEqual(before);

  const requestKey = key();
  const originalInput = { state: 'paused', revision: first.revision, incarnationId: first.incarnationId };
  const changed = (
    await body<{ libraryEntry: EntryView }>(await write('PUT', path, originalInput, 'owner', requestKey))
  ).libraryEntry;
  const current = await entry(subject.id, 'completed', changed);
  expect(await body(await write('PUT', path, originalInput, 'owner', requestKey))).toEqual({ libraryEntry: changed });
  expect(await entryView(subject.id)).toEqual(current);

  const racing = await Promise.all([
    write('PUT', path, { state: 'paused', revision: current.revision, incarnationId: current.incarnationId }),
    write('PUT', path, { state: 'dropped', revision: current.revision, incarnationId: current.incarnationId }),
  ]);
  expect(racing.map((response) => response.status).sort()).toEqual([200, 409]);
  const winner = (await body<{ libraryEntry: EntryView }>(racing.find((response) => response.status === 200)!))
    .libraryEntry;
  await problem(
    racing.find((response) => response.status === 409)!,
    409,
    'conflict',
  );
  expect(winner.revision).toBe(current.revision + 1);
  expect(await entryView(subject.id)).toEqual(winner);

  const deleteKey = key();
  const deleted = await write('DELETE', deletePath(winner), undefined, 'owner', deleteKey);
  expect(deleted.status).toBe(204);
  expect(await deleted.text()).toBe('');
  const recreated = await entry(subject.id, 'planned');
  expect(recreated.revision).toBe(first.revision);
  expect(recreated.incarnationId).not.toBe(first.incarnationId);
  await driver.settle();
  const afterRecreate = await driver.inspect();
  await problem(
    await write('PUT', path, { state: 'paused', revision: first.revision, incarnationId: first.incarnationId }),
    409,
    'conflict',
  );
  await problem(await write('DELETE', deletePath(first)), 409, 'conflict');
  const deleteReplay = await write('DELETE', deletePath(winner), undefined, 'owner', deleteKey);
  expect(deleteReplay.status).toBe(204);
  expect(await deleteReplay.text()).toBe('');
  expect(await driver.inspect()).toEqual(afterRecreate);
  expect(await entryView(subject.id)).toEqual(recreated);
});

test('in_progress follows by library and explicit unfollow survives later entry transitions', async () => {
  const subject = await driver.provisionSubject();
  let current = await entry(subject.id, 'in_progress');
  await driver.settle();
  expect(await follow(subject.id)).toMatchObject({
    targetId: subject.id,
    targetType: 'subject',
    state: 'following',
    reason: 'library',
  });
  current = await entry(subject.id, 'completed', current);
  await driver.settle();
  expect((await follow(subject.id)).state).toBe('following');
  await ok(await write('DELETE', `/v1/follows/${subject.id}`));
  expect(await follow(subject.id)).toMatchObject({ state: 'unfollowed', reason: 'explicit' });
  await entry(subject.id, 'in_progress', current);
  await driver.settle();
  expect(await follow(subject.id)).toMatchObject({ state: 'unfollowed', reason: 'explicit' });
  expect(await all('/v1/follows', 'follows')).toEqual([]);
});
test('progress creation requires exactly one mode and records must match that mode with one intent', async () => {
  const subject = await driver.provisionSubject();
  const modes = [
    await session(subject.id, 'scalar_amount'),
    await session(subject.id, 'cursor_position', 'page'),
    await session(subject.id, 'completed_units', 'chapter'),
  ];
  await driver.settle();
  const before = await driver.inspect();
  for (const mode of [undefined, ['scalar_amount', 'cursor_position']]) {
    await problem(await write('POST', '/v1/progressSessions', { subjectId: subject.id, unit: 'page', mode }), 400);
  }
  for (const [index, intents] of [
    [0, [{ locator: 'page', position: '1' }, { add: ['1'] }, {}, { amount: '1', locator: 'page', position: '1' }]],
    [1, [{ amount: '1' }, { add: ['1'] }, { position: '1' }, { locator: 'page' }]],
    [2, [{ amount: '1' }, { locator: 'page', position: '1' }, { add: ['1'], amount: '1' }]],
  ] as const) {
    const current = modes[index]!;
    for (const intent of intents) {
      await problem(
        await write('POST', `/v1/progressSessions/${current.id}:record`, { revision: current.revision, ...intent }),
        400,
      );
    }
  }
  expect(await driver.inspect()).toEqual(before);
  expect((await record(modes[0]!, { amount: '1.5' })).amount).toBe('1.5');
  expect(await record(modes[1]!, { locator: 'page', position: '1.5' })).toMatchObject({
    locator: 'page',
    position: '1.5',
  });
  expect((await record(modes[2]!, { add: ['opaque:one'] })).completedUnitCount).toBe(1);
});

test('completed units preserve the sparse set removals and both exact change intents', async () => {
  const subject = await driver.provisionSubject();
  let current = await session(subject.id, 'completed_units', 'chapter');
  current = await record(current, { add: ['1', '3', '7'] });
  expect(current.completedUnitCount).toBe(3);
  const path = `/v1/progressSessions/${current.id}`;
  expect((await all<string>(`${path}/completedUnits`, 'completedUnits')).sort()).toEqual(['1', '3', '7']);
  current = await record(current, { remove: ['3'] });
  expect(current.completedUnitCount).toBe(2);
  expect((await all<string>(`${path}/completedUnits`, 'completedUnits')).sort()).toEqual(['1', '7']);
  const changes = await all<ProgressChange>(`${path}/changes`, 'changes');
  expect(changes).toHaveLength(2);
  expect(changes.map((change) => change.intent)).toEqual([{ add: ['1', '3', '7'] }, { remove: ['3'] }]);
  expect(new Set(changes.map((change) => change.id)).size).toBe(2);
  expect(changes[1]!.revision).toBe(current.revision);
  const rows = (await driver.inspect()).completedUnits.filter((row) => row.sessionId === current.id);
  expect(rows.map((row) => row.unitId).sort()).toEqual(['1', '7']);
});

test('completed unit requests accept one hundred opaque ids but reject larger batches without changes', async () => {
  const subject = await driver.provisionSubject();
  let current = await session(subject.id, 'completed_units', 'episode');
  const ids = Array.from({ length: 100 }, (_, index) => `opaque-unit:${index}`);
  current = await record(current, { add: ids });
  expect(current.completedUnitCount).toBe(100);
  expect(
    (await all<string>(`/v1/progressSessions/${current.id}/completedUnits`, 'completedUnits', 'owner', 100)).sort(),
  ).toEqual([...ids].sort());
  await driver.settle();
  const before = await driver.inspect();
  for (const intent of [{ add: [...ids, 'extra'] }, { remove: [...ids, 'extra'] }, { add: ['extra'], remove: ids }]) {
    // Fail closed: the 100-id bound applies to the whole request, including add plus remove.
    await problem(
      await write('POST', `/v1/progressSessions/${current.id}:record`, { revision: current.revision, ...intent }),
      400,
    );
  }
  expect(await driver.inspect()).toEqual(before);
});

test('percent is bounded while elapsed minutes never implicitly complete a session', async () => {
  const subject = await driver.provisionSubject();
  let percent = await session(subject.id, 'scalar_amount', 'percent', { total: '100' });
  percent = await record(percent, { amount: '0' });
  percent = await record(percent, { amount: '100' });
  await driver.settle();
  const before = await driver.inspect();
  for (const amount of ['101', '-0.1']) {
    await problem(
      await write('POST', `/v1/progressSessions/${percent.id}:record`, { revision: percent.revision, amount }),
      400,
    );
  }
  expect(await driver.inspect()).toEqual(before);
  const minutes = await session(subject.id, 'scalar_amount', 'minute', { total: '120' });
  expect(await record(minutes, { amount: '120' })).toMatchObject({ amount: '120', state: 'active', completedAt: null });
});

test('cursor positions can move backward and session revisions reject stale records and transitions', async () => {
  const subject = await driver.provisionSubject();
  const edition = await driver.provisionSubject({ versionOf: subject.id });
  const initial = await session(subject.id, 'cursor_position', 'page', { versionSubjectId: edition.id });
  let current = await record(initial, { locator: 'chapter:three', position: '90.5' });
  current = await record(current, { locator: 'chapter:one', position: '12.25' });
  expect(current).toMatchObject({
    locator: 'chapter:one',
    position: '12.25',
    state: 'active',
    versionSubjectId: edition.id,
  });
  await driver.settle();
  const before = await driver.inspect();
  for (const [action, payload] of [
    ['record', { revision: initial.revision, locator: 'chapter:two', position: '45' }],
    ['complete', { revision: initial.revision }],
    ['abandon', { revision: initial.revision }],
  ] as const)
    await problem(await write('POST', `/v1/progressSessions/${current.id}:${action}`, payload), 409, 'conflict');
  expect(await driver.inspect()).toEqual(before);
  expect(await sessionView(current.id)).toEqual(current);
  await ok(await write('POST', `/v1/progressSessions/${current.id}:abandon`, { revision: current.revision }));
  expect(await sessionView(current.id)).toMatchObject({ state: 'abandoned', revision: current.revision + 1 });
});

test('completing then restarting a subject retains the first session completion timestamp', async () => {
  const subject = await driver.provisionSubject();
  const first = await session(subject.id);
  await driver.setTime('2030-01-03T00:00:00.000Z');
  await ok(await write('POST', `/v1/progressSessions/${first.id}:complete`, { revision: first.revision }));
  const completed = await sessionView(first.id);
  expect(completed).toMatchObject({ state: 'completed', completedAt: driver.now(), revision: first.revision + 1 });
  await driver.setTime('2030-01-04T00:00:00.000Z');
  const second = await session(subject.id);
  expect(second.id).not.toBe(first.id);
  expect(second.completedAt).toBeNull();
  expect(await sessionView(first.id)).toEqual(completed);
  const sessions = await all<SessionView>(
    `/v1/progressSessions?subjectId=${subject.id}`,
    'progressSessions',
    'owner',
    1,
  );
  expect(sessions.map((item) => item.id).sort()).toEqual([first.id, second.id].sort());
  expect(sessions.find((item) => item.id === first.id)).toEqual(completed);
});

test('two copies of one edition remain independent through revision updates and deletion', async () => {
  const subject = await driver.provisionSubject();
  const edition = await driver.provisionSubject({ versionOf: subject.id });
  const first = await copy(edition.id);
  const second = await copy(edition.id);
  expect(second.id).not.toBe(first.id);
  await ok(
    await write('PATCH', `/v1/copies/${first.id}`, {
      revision: first.revision,
      status: 'lent',
      location: 'Friend',
      note: 'Loan',
    }),
  );
  const changed = (await body<{ copy: CopyView }>(await get(`/v1/copies/${first.id}`))).copy;
  expect(changed).toMatchObject({ status: 'lent', location: 'Friend', note: 'Loan', revision: first.revision + 1 });
  await driver.settle();
  const before = await driver.inspect();
  await problem(
    await write('PATCH', `/v1/copies/${first.id}`, { revision: first.revision, status: 'disposed' }),
    409,
    'conflict',
  );
  expect(await driver.inspect()).toEqual(before);
  expect((await all<CopyView>('/v1/copies', 'copies', 'owner', 1)).map((item) => item.id).sort()).toEqual(
    [first.id, second.id].sort(),
  );
  await ok(await write('DELETE', `/v1/copies/${first.id}?revision=${changed.revision}`));
  await hidden(`/v1/copies/${first.id}`, `/v1/copies/${driver.unknown.copyId}`, 'owner');
  expect(await body(await get(`/v1/copies/${second.id}`))).toEqual({ copy: second });
  expect(await all('/v1/copies', 'copies')).toEqual([second]);
});

test('explicit follow and unfollow of a public Collection remain private and list only following', async () => {
  const shelf = await collection('public');
  const result = (await body<{ follow: FollowView }>(await write('PUT', `/v1/follows/${shelf.id}`))).follow;
  expect(result).toEqual({
    targetId: shelf.id,
    targetType: 'collection',
    state: 'following',
    reason: 'explicit',
    updatedAt: expect.any(String),
  });
  expect(await follow(shelf.id)).toEqual(result);
  expect(await all('/v1/follows', 'follows')).toEqual([result]);
  await ok(await write('DELETE', `/v1/follows/${shelf.id}`));
  expect(await follow(shelf.id)).toMatchObject({
    targetId: shelf.id,
    targetType: 'collection',
    state: 'unfollowed',
    reason: 'explicit',
  });
  expect(await all('/v1/follows', 'follows')).toEqual([]);
  for (const as of ['other', 'anonymous'] as const) {
    await hidden(`/v1/follows/${shelf.id}`, `/v1/follows/${driver.unknown.collectionId}`, as);
    const view = (await body<{ collection: CollectionView }>(await get(`/v1/collections/${shelf.id}`, as))).collection;
    expect(view).toEqual(shelf);
    expect(Object.keys(view).some((name) => /follower/i.test(name))).toBe(false);
  }
});

test('entries sessions completed units changes copies and follows conceal all owner data from other and anonymous', async () => {
  const subject = await driver.provisionSubject();
  const ownedEntry = await entry(subject.id, 'in_progress');
  const ownedSession = await record(await session(subject.id, 'completed_units', 'volume'), { add: ['volume:A'] });
  const ownedCopy = await copy(subject.id);
  await driver.settle();
  const pairs = [
    [`/v1/libraryEntries/${subject.id}`, `/v1/libraryEntries/${driver.unknown.subjectId}`],
    [`/v1/progressSessions/${ownedSession.id}`, `/v1/progressSessions/${driver.unknown.sessionId}`],
    [
      `/v1/progressSessions/${ownedSession.id}/completedUnits`,
      `/v1/progressSessions/${driver.unknown.sessionId}/completedUnits`,
    ],
    [`/v1/progressSessions/${ownedSession.id}/changes`, `/v1/progressSessions/${driver.unknown.sessionId}/changes`],
    [`/v1/copies/${ownedCopy.id}`, `/v1/copies/${driver.unknown.copyId}`],
    [`/v1/follows/${subject.id}`, `/v1/follows/${driver.unknown.subjectId}`],
  ];
  for (const as of ['other', 'anonymous'] as const) {
    for (const [path, unknown] of pairs) await hidden(path!, unknown!, as);
  }
  for (const [path, plural] of [
    ['/v1/libraryEntries', 'libraryEntries'],
    ['/v1/libraryEntries?state=in_progress', 'libraryEntries'],
    [`/v1/progressSessions?subjectId=${subject.id}`, 'progressSessions'],
    ['/v1/copies', 'copies'],
    ['/v1/follows', 'follows'],
  ]) {
    expect(await all(path!, plural!, 'other')).toEqual([]);
    await problem(await get(path!, 'anonymous'), 401);
  }
  expect(await entryView(subject.id)).toEqual(ownedEntry);
  expect(await sessionView(ownedSession.id)).toEqual(ownedSession);
  expect(await all(`/v1/progressSessions/${ownedSession.id}/completedUnits`, 'completedUnits')).toEqual(['volume:A']);
  expect(await all(`/v1/progressSessions/${ownedSession.id}/changes`, 'changes')).toHaveLength(1);
  expect(await all('/v1/copies', 'copies')).toEqual([ownedCopy]);
  expect(await all('/v1/follows', 'follows')).toHaveLength(1);
});
test('public subject listings count each public Collection once with multiplicity and exclude private derived rows', async () => {
  const subject = await driver.provisionSubject();
  const publicShelf = await collection('public');
  const privateShelf = await collection('private');
  const unlistedShelf = await collection('unlisted');
  await member(publicShelf.id, subject.id);
  await member(publicShelf.id, subject.id);
  await member(privateShelf.id, subject.id);
  await member(unlistedShelf.id, subject.id);
  await entry(subject.id, 'in_progress');
  await record(await session(subject.id, 'completed_units', 'chapter'), { add: ['chapter:private'] });
  await copy(subject.id);
  await driver.settle();
  const expected = [
    { id: publicShelf.id, curatorAccountId: driver.accounts.owner.id, title: publicShelf.title, multiplicity: 2 },
  ];
  expect(await publicCollections(subject.id)).toEqual(expected);
  const rows = (await driver.inspect()).subjectPartitionRows.filter((row) => row.subjectId === subject.id);
  expect(rows.filter((row) => row.source === 'collection')).toEqual([
    expect.objectContaining({
      collectionId: publicShelf.id,
      visibility: 'public',
      multiplicity: 2,
      route: subject.route,
      partition: subject.partition,
    }),
  ]);
  expect(rows.filter((row) => ['entry', 'session', 'copy', 'follow'].includes(row.source))).toEqual([]);
  expect(rows.filter((row) => row.source === 'collection' && row.visibility !== 'public')).toEqual([]);
  const current = await collectionView(publicShelf.id);
  await ok(
    await write('PATCH', `/v1/collections/${publicShelf.id}`, { revision: current.revision, visibility: 'private' }),
  );
  await driver.settle();
  expect(await publicCollections(subject.id)).toEqual([]);
  expect(
    (await driver.inspect()).subjectPartitionRows.filter(
      (row) => row.subjectId === subject.id && row.source === 'collection',
    ),
  ).toEqual([]);
  const hiddenShelf = await collectionView(publicShelf.id);
  await ok(
    await write('PATCH', `/v1/collections/${publicShelf.id}`, { revision: hiddenShelf.revision, visibility: 'public' }),
  );
  await driver.settle();
  expect(await publicCollections(subject.id)).toEqual(expected);
  const restored = await collectionView(publicShelf.id);
  expect((await write('DELETE', `/v1/collections/${publicShelf.id}?revision=${restored.revision}`)).status).toBe(204);
  await driver.settle();
  expect(await publicCollections(subject.id)).toEqual([]);
  expect((await driver.inspect()).subjectPartitionRows.filter((row) => row.subjectId === subject.id)).toEqual([]);
});

test('published logs are anonymous immutable snapshots and only their owner can publish or delete them', async () => {
  const subject = await driver.provisionSubject();
  const current = await session(subject.id);
  const ownedEntry = await entry(subject.id, 'in_progress');
  const log = await publish(current.id);
  expect(log).toEqual({
    id: expect.any(String),
    accountId: driver.accounts.owner.id,
    subjectId: subject.id,
    sessionState: 'active',
    startedAt: current.startedAt,
    completedAt: null,
    note: 'A public reading milestone',
    publishedAt: driver.now(),
  });
  await driver.settle();
  const before = await driver.inspect();
  const deniedPublish = await write('POST', '/v1/publishedLogs', { sessionId: current.id }, 'other');
  // Fail closed: another account's session is undiscoverable even when named for publication.
  await problem(deniedPublish, 404, 'not_found');
  const deniedDelete = await write('DELETE', `/v1/publishedLogs/${log.id}`, undefined, 'other');
  expect([403, 404]).toContain(deniedDelete.status);
  await problem(deniedDelete, deniedDelete.status);
  expect(await driver.inspect()).toEqual(before);
  await driver.setTime('2030-01-03T00:00:00.000Z');
  await ok(await write('POST', `/v1/progressSessions/${current.id}:complete`, { revision: current.revision }));
  await entry(subject.id, 'completed', ownedEntry);
  await driver.settle();
  expect((await sessionView(current.id)).completedAt).toBe(driver.now());
  for (const as of ['owner', 'other', 'anonymous'] as const) {
    expect(await body(await get(`/v1/publishedLogs/${log.id}`, as))).toEqual({ publishedLog: log });
    expect(await all(`/v1/publishedLogs?accountId=${driver.accounts.owner.id}`, 'publishedLogs', as)).toEqual([log]);
  }
  expect((await driver.inspect()).publishedLogs).toEqual([log]);
  await ok(await write('DELETE', `/v1/publishedLogs/${log.id}`));
  await driver.settle();
  await hidden(`/v1/publishedLogs/${log.id}`, `/v1/publishedLogs/${driver.unknown.logId}`, 'anonymous');
  expect(await all(`/v1/publishedLogs?accountId=${driver.accounts.owner.id}`, 'publishedLogs', 'anonymous')).toEqual(
    [],
  );
});

test('suspended credentials refuse every library write and private read without changing authoritative state', async () => {
  const subject = await driver.provisionSubject();
  const shelf = await collection('public');
  const privateShelf = await collection('private');
  const item = await member(shelf.id, subject.id);
  const ownedEntry = await entry(subject.id, 'in_progress');
  const ownedSession = await session(subject.id, 'completed_units', 'chapter');
  const ownedCopy = await copy(subject.id);
  const log = await publish(ownedSession.id);
  await driver.settle();
  const before = await driver.inspect();
  const attempts: { method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'; path: string; body?: unknown }[] = [
    { method: 'POST', path: '/v1/collections', body: { title: 'Denied', visibility: 'public' } },
    { method: 'PATCH', path: `/v1/collections/${shelf.id}`, body: { revision: shelf.revision, title: 'Denied' } },
    { method: 'DELETE', path: `/v1/collections/${shelf.id}?revision=${shelf.revision}` },
    { method: 'POST', path: membersPath(shelf.id), body: { subjectId: subject.id } },
    { method: 'PATCH', path: `${membersPath(shelf.id)}/${item.id}`, body: { note: 'Denied' } },
    { method: 'POST', path: `${membersPath(shelf.id)}/${item.id}:move`, body: { after: null } },
    { method: 'DELETE', path: `${membersPath(shelf.id)}/${item.id}` },
    {
      method: 'PUT',
      path: `/v1/libraryEntries/${subject.id}`,
      body: { state: 'planned', revision: ownedEntry.revision, incarnationId: ownedEntry.incarnationId },
    },
    {
      method: 'DELETE',
      path: `/v1/libraryEntries/${subject.id}?revision=${ownedEntry.revision}&incarnationId=${encodeURIComponent(ownedEntry.incarnationId)}`,
    },
    {
      method: 'POST',
      path: '/v1/progressSessions',
      body: { subjectId: subject.id, mode: 'scalar_amount', unit: 'minute' },
    },
    {
      method: 'POST',
      path: `/v1/progressSessions/${ownedSession.id}:record`,
      body: { revision: ownedSession.revision, add: ['1'] },
    },
    {
      method: 'POST',
      path: `/v1/progressSessions/${ownedSession.id}:complete`,
      body: { revision: ownedSession.revision },
    },
    {
      method: 'POST',
      path: `/v1/progressSessions/${ownedSession.id}:abandon`,
      body: { revision: ownedSession.revision },
    },
    { method: 'POST', path: '/v1/copies', body: { subjectId: subject.id, kind: 'physical', status: 'owned' } },
    { method: 'PATCH', path: `/v1/copies/${ownedCopy.id}`, body: { revision: ownedCopy.revision, status: 'disposed' } },
    { method: 'DELETE', path: `/v1/copies/${ownedCopy.id}?revision=${ownedCopy.revision}` },
    { method: 'PUT', path: `/v1/follows/${shelf.id}` },
    { method: 'DELETE', path: `/v1/follows/${shelf.id}` },
    { method: 'POST', path: '/v1/publishedLogs', body: { sessionId: ownedSession.id } },
    { method: 'DELETE', path: `/v1/publishedLogs/${log.id}` },
  ];
  for (const attempt of attempts) {
    const response = await write(attempt.method, attempt.path, attempt.body, 'suspended');
    expect([401, 403]).toContain(response.status);
    await problem(response, response.status);
    await driver.settle();
    expect(await driver.inspect()).toEqual(before);
  }
  for (const path of [
    '/v1/libraryEntries',
    `/v1/progressSessions?subjectId=${subject.id}`,
    '/v1/copies',
    '/v1/follows',
  ]) {
    const response = await get(path, 'suspended');
    expect([401, 403]).toContain(response.status);
    await problem(response, response.status);
  }
  for (const path of [
    `/v1/collections/${privateShelf.id}`,
    membersPath(privateShelf.id),
    `/v1/libraryEntries/${subject.id}`,
    `/v1/progressSessions/${ownedSession.id}`,
    `/v1/progressSessions/${ownedSession.id}/completedUnits`,
    `/v1/progressSessions/${ownedSession.id}/changes`,
    `/v1/copies/${ownedCopy.id}`,
    `/v1/follows/${subject.id}`,
  ]) {
    const response = await get(path, 'suspended');
    expect([401, 403, 404]).toContain(response.status);
    await problem(response, response.status);
  }
  expect(await driver.inspect()).toEqual(before);
  expect(await collectionView(privateShelf.id)).toEqual(privateShelf);
  expect(await entryView(subject.id)).toEqual(ownedEntry);
});

test('list limits are one through one hundred with a default twenty and stable cursor traversal', async () => {
  const subject = await driver.provisionSubject();
  const shelf = await collection('public');
  await driver.seedMembers({ collectionId: shelf.id, subjectId: subject.id, count: 23 });
  const defaultPage = await page<MemberView>(membersPath(shelf.id), 'members');
  expect(defaultPage.items).toHaveLength(20);
  expect(defaultPage.next).toBeTruthy();
  const lastPage = await page<MemberView>(pagePath(membersPath(shelf.id), 20, defaultPage.next!), 'members');
  expect(lastPage.items).toHaveLength(3);
  expect(lastPage.next).toBeNull();
  expect(new Set([...defaultPage.items, ...lastPage.items].map((item) => item.id)).size).toBe(23);
  expect((await page<MemberView>(pagePath(membersPath(shelf.id), 1), 'members')).items).toHaveLength(1);
  expect((await page<MemberView>(pagePath(membersPath(shelf.id), 100), 'members')).items).toHaveLength(23);
  const current = await session(subject.id, 'completed_units', 'chapter');
  const paths = [
    `/v1/collections?curatorAccountId=${driver.accounts.owner.id}`,
    membersPath(shelf.id),
    '/v1/libraryEntries',
    `/v1/progressSessions?subjectId=${subject.id}`,
    `/v1/progressSessions/${current.id}/completedUnits`,
    `/v1/progressSessions/${current.id}/changes`,
    '/v1/copies',
    '/v1/follows',
    `/v1/publishedLogs?accountId=${driver.accounts.owner.id}`,
    `/v1/subjects/${subject.id}/collections`,
  ];
  for (const path of paths)
    for (const limit of [0, 101]) {
      await problem(await get(pagePath(path, limit)), 400);
    }
});

test('member insert members page entry write entries page and unit record use equal statements at three seeded scales', async () => {
  const subject = await driver.provisionSubject();
  const shelf = await collection();
  const anchor = await member(shelf.id, subject.id);
  let ownedEntry = await entry(subject.id, 'planned');
  let current = await session(subject.id, 'completed_units', 'chapter');
  const counts: number[][] = [];
  for (const scale of [0, 100, 1000]) {
    await driver.seed(scale);
    await driver.settle();
    const inserted = await driver.measure(() => write('POST', membersPath(shelf.id), { subjectId: subject.id }));
    const insertedView = (await body<{ member: MemberView }>(inserted.value, 201)).member;
    expect(insertedView.subjectId).toBe(subject.id);
    const memberPage = await driver.measure(() => get(pagePath(membersPath(shelf.id), 1)));
    const listedMembers = await body<{ members: MemberView[]; next: string | null }>(memberPage.value);
    expect(listedMembers.members).toEqual([anchor]);
    expect(listedMembers.next).toBeTruthy();
    const nextState = ownedEntry.state === 'planned' ? 'paused' : 'planned';
    const updated = await driver.measure(() =>
      write('PUT', `/v1/libraryEntries/${subject.id}`, {
        revision: ownedEntry.revision,
        incarnationId: ownedEntry.incarnationId,
        state: nextState,
      }),
    );
    const previousRevision = ownedEntry.revision;
    ownedEntry = (await body<{ libraryEntry: EntryView }>(updated.value)).libraryEntry;
    expect(ownedEntry).toMatchObject({ subjectId: subject.id, state: nextState, revision: previousRevision + 1 });
    const entriesPage = await driver.measure(() => get(pagePath('/v1/libraryEntries', 1)));
    expect(await body(entriesPage.value)).toEqual({ libraryEntries: [ownedEntry], next: null });
    const unitId = `unit:${counts.length}`;
    const recorded = await driver.measure(() =>
      write('POST', `/v1/progressSessions/${current.id}:record`, {
        revision: current.revision,
        add: [unitId],
      }),
    );
    await ok(recorded.value);
    current = await sessionView(current.id);
    expect(current.completedUnitCount).toBe(counts.length + 1);
    const measurements = [inserted, memberPage, updated, entriesPage, recorded];
    for (const measured of measurements) {
      expect(Number.isInteger(measured.statements)).toBe(true);
      expect(measured.statements).toBeGreaterThan(0);
      expect(Number.isFinite(measured.buffers)).toBe(true);
      expect(measured.buffers).toBeGreaterThanOrEqual(0);
    }
    counts.push(measurements.map((measured) => measured.statements));
  }
  expect(counts[1]).toEqual(counts[0]);
  expect(counts[2]).toEqual(counts[0]);
  expect(await members(shelf.id)).toHaveLength(4);
  expect((await all<string>(`/v1/progressSessions/${current.id}/completedUnits`, 'completedUnits')).sort()).toEqual([
    'unit:0',
    'unit:1',
    'unit:2',
  ]);
});
