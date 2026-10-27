import { afterEach, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  EntryState,
  Gate,
  LibraryShelvesDriver,
  Persona,
  ProgressMode,
  ProgressUnit,
  SessionView,
  ShelfDirection,
  ShelfItem,
  ShelfOrder,
  ShelfTab,
  ShelvesInspection,
} from './library-shelves-driver';

setDefaultTimeout(240_000);
let driver: LibraryShelvesDriver;
beforeEach(async () => {
  const location = process.env.LIBRARY_SHELVES_DRIVER;
  if (!location) throw new Error('Library shelves outcome driver is required');
  if (!isAbsolute(location) && !location.startsWith('file:'))
    throw new Error('LIBRARY_SHELVES_DRIVER must be absolute or a file URL');
  const url = isAbsolute(location) ? pathToFileURL(location) : new URL(location);
  if (url.protocol !== 'file:') throw new Error('LIBRARY_SHELVES_DRIVER must use a file URL');
  const binding = await import(url.href);
  if (typeof binding.createLibraryShelvesDriver !== 'function')
    throw new Error('Expected createLibraryShelvesDriver factory');
  driver = await binding.createLibraryShelvesDriver();
  await driver.setTime(T(0));
});
afterEach(async () => {
  const current = driver;
  driver = undefined!;
  await current?.close();
});

// --- Helpers -------------------------------------------------------------------------------------------------------

const BASE = Date.parse('2030-01-02T00:00:00.000Z');
/** The instant this many minutes after the scenario origin, as the RFC 3339 text the API returns. */
const T = (minutes: number) => new Date(BASE + minutes * 60_000).toISOString();
const atMinute = (minutes: number) => driver.setTime(T(minutes));
const STATES: readonly EntryState[] = ['planned', 'in_progress', 'completed', 'paused', 'dropped'];
const ORDERS: readonly ShelfOrder[] = ['lastActivity', 'finishedAt', 'createdAt'];
const DIRECTIONS: readonly ShelfDirection[] = ['desc', 'asc'];
const DEFAULT_ORDER: Record<EntryState, ShelfOrder> = {
  in_progress: 'lastActivity',
  planned: 'createdAt',
  completed: 'finishedAt',
  paused: 'lastActivity',
  dropped: 'lastActivity',
};
const TABS: readonly ShelfTab[] = ['all', 'in_progress', 'planned', 'completed', 'paused', 'dropped', 'collections'];
const ENTRY_KEYS = ['createdAt', 'revision', 'state', 'subjectId', 'updatedAt'];
const SHELF_KEYS = [...ENTRY_KEYS, 'activeProgressSession', 'finishedAt', 'lastActivityAt'].sort();
const SESSION_KEYS = [
  'amount',
  'completedAt',
  'completedUnitCount',
  'id',
  'locator',
  'mode',
  'position',
  'revision',
  'startedAt',
  'state',
  'subjectId',
  'total',
  'unit',
  'versionSubjectId',
];

let serial = 0;
const key = () => `"shelf-${++serial}"`;
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
async function body<R>(response: Response, status = 200): Promise<R> {
  expect(response.status).toBe(status);
  return (await response.json()) as R;
}
async function problem(response: Response, status: number, code?: string) {
  expect(response.headers.get('content-type')).toMatch(/^application\/problem\+json\b/);
  const result = await body<Record<string, unknown>>(response, status);
  expect(result).toMatchObject({ type: expect.any(String), title: expect.any(String), status });
  if (code) expect(result.code).toBe(code);
  return result;
}

type StoredView = { subjectId: string; state: EntryState; revision: number; createdAt: string; updatedAt: string };
async function putEntry(subjectId: string, state: EntryState, revision?: number, as: Persona = 'owner') {
  return write('PUT', `/v1/libraryEntries/${subjectId}`, revision === undefined ? { state } : { state, revision }, as);
}
async function entry(subjectId: string, state: EntryState = 'planned', as: Persona = 'owner') {
  const response = await putEntry(subjectId, state, undefined, as);
  expect(response.status).toBe(201);
  return (await body<{ libraryEntry: StoredView }>(response, 201)).libraryEntry;
}
async function setState(current: StoredView, state: EntryState, as: Persona = 'owner') {
  const response = await putEntry(current.subjectId, state, current.revision, as);
  return (await body<{ libraryEntry: StoredView }>(response, 200)).libraryEntry;
}
async function readEntry(subjectId: string, as: Persona = 'owner') {
  return (await body<{ libraryEntry: StoredView }>(await get(`/v1/libraryEntries/${subjectId}`, as))).libraryEntry;
}
async function removeEntry(current: StoredView, as: Persona = 'owner') {
  const response = await write(
    'DELETE',
    `/v1/libraryEntries/${current.subjectId}?revision=${current.revision}`,
    undefined,
    as,
  );
  expect(response.status).toBe(204);
}
async function start(
  subjectId: string,
  mode: ProgressMode = 'scalar_amount',
  unit: ProgressUnit = 'page',
  extras: { total?: string } = {},
  as: Persona = 'owner',
) {
  const response = await write('POST', '/v1/progressSessions', { subjectId, mode, unit, ...extras }, as);
  return (await body<{ progressSession: SessionView }>(response, 201)).progressSession;
}
async function readSession(id: string, as: Persona = 'owner') {
  return (await body<{ progressSession: SessionView }>(await get(`/v1/progressSessions/${id}`, as))).progressSession;
}
async function transition(current: SessionView, action: 'record' | 'complete' | 'abandon', intent: object = {}) {
  const response = await write('POST', `/v1/progressSessions/${current.id}:${action}`, {
    revision: current.revision,
    ...intent,
  });
  expect(response.status).toBe(200);
  return (await body<{ progressSession: SessionView }>(response)).progressSession;
}
const record = (current: SessionView, intent: object) => transition(current, 'record', intent);

type ShelfParameters = {
  orderBy?: ShelfOrder;
  direction?: ShelfDirection;
  state?: EntryState;
  type?: string;
  view?: 'BASIC' | 'FULL';
  limit?: number;
  cursor?: string;
};
function shelfPath(parameters: ShelfParameters) {
  const query = new URLSearchParams();
  query.set('orderBy', parameters.orderBy ?? 'lastActivity');
  for (const [name, value] of Object.entries(parameters))
    if (name !== 'orderBy' && value !== undefined) query.set(name, String(value));
  return `/v1/libraryEntries?${query}`;
}
async function shelfPage(parameters: ShelfParameters, as: Persona = 'owner') {
  const result = await body<{ libraryEntries: ShelfItem[]; next: string | null }>(await get(shelfPath(parameters), as));
  expect(Object.keys(result).sort()).toEqual(['libraryEntries', 'next']);
  for (const item of result.libraryEntries) {
    expect(Object.keys(item).sort()).toEqual(
      parameters.view === 'FULL' ? [...SHELF_KEYS, 'subject'].sort() : SHELF_KEYS,
    );
    expect(
      item.activeProgressSession === null ||
        Object.keys(item.activeProgressSession).sort().join() === SESSION_KEYS.join(),
    ).toBe(true);
  }
  return { items: result.libraryEntries, next: result.next };
}
async function shelf(parameters: ShelfParameters = {}, as: Persona = 'owner') {
  return (await shelfPage({ limit: 48, ...parameters }, as)).items;
}
/** Walks every page at one limit and proves each entry appears exactly once. */
async function walk(parameters: ShelfParameters, limit: number, as: Persona = 'owner') {
  const seen = new Set<string>();
  const tokens = new Set<string>();
  const items: ShelfItem[] = [];
  let cursor: string | undefined;
  for (let pages = 0; pages < 400; pages++) {
    const current = await shelfPage({ ...parameters, limit, ...(cursor ? { cursor } : {}) }, as);
    expect(current.items.length).toBeLessThanOrEqual(limit);
    for (const item of current.items) {
      expect(seen.has(item.subjectId)).toBe(false);
      seen.add(item.subjectId);
      items.push(item);
    }
    if (current.next === null) return items;
    expect(current.items.length).toBeGreaterThan(0);
    expect(tokens.has(current.next)).toBe(false);
    tokens.add(current.next);
    cursor = current.next;
  }
  throw new Error('Shelf pagination did not terminate');
}
const ids = (items: readonly { subjectId: string }[]) => items.map((item) => item.subjectId);
const mirror = (list: readonly string[]) => [...list].sort().reverse();

async function summary(type?: string, as: Persona = 'owner') {
  const query = type === undefined ? '' : `?type=${encodeURIComponent(type)}`;
  const result = await body<{ tabs: Record<ShelfTab, { total: number; shown: number }> }>(
    await get(`/v1/libraryShelfSummary${query}`, as),
  );
  expect(Object.keys(result)).toEqual(['tabs']);
  expect(Object.keys(result.tabs).sort()).toEqual([...TABS].sort());
  return result.tabs;
}
const totals = (tabs: Record<ShelfTab, { total: number }>) =>
  Object.fromEntries(TABS.map((tab) => [tab, tabs[tab].total]));
const zeroTotals = Object.fromEntries(TABS.map((tab) => [tab, 0]));
async function typeFacets(as: Persona = 'owner', limit = 100) {
  const found: { type: string; count: number }[] = [];
  let cursor: string | undefined;
  for (let pages = 0; pages < 100; pages++) {
    const path = `/v1/libraryShelfTypes?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const result = await body<{ types: { type: string; count: number }[]; next: string | null }>(await get(path, as));
    expect(Object.keys(result).sort()).toEqual(['next', 'types']);
    expect(result.types.length).toBeLessThanOrEqual(limit);
    found.push(...result.types);
    if (result.next === null) return found;
    cursor = result.next;
  }
  throw new Error('Type facet pagination did not terminate');
}

/** Counter rows must equal what the stored entries and Collections imply. Zero rows are ignored. */
function expectedCounts(inspection: ShelvesInspection) {
  const rows = new Map<string, number>();
  const bump = (accountId: string, bucket: string, type: string) => {
    const name = JSON.stringify([accountId, bucket, type]);
    rows.set(name, (rows.get(name) ?? 0) + 1);
  };
  for (const stored of inspection.entries) {
    for (const bucket of [stored.state, 'all']) {
      bump(stored.accountId, bucket, '');
      bump(stored.accountId, bucket, stored.subjectType);
    }
  }
  for (const collection of inspection.collections) bump(collection.accountId, 'collections', '');
  return [...rows].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name));
}
async function expectCountersMatch() {
  await driver.settle();
  const inspection = await driver.inspect();
  const stored = inspection.counts
    .filter((row) => row.count > 0)
    .map((row) => ({ name: JSON.stringify([row.accountId, row.bucket, row.type]), count: row.count }))
    .sort((a, b) => a.name.localeCompare(b.name));
  expect(stored).toEqual(expectedCounts(inspection));
}

// --- Smoke and positive control --------------------------------------------------------------------------------------

test('library shelf outcomes execute red without a driver', async () => {
  expect(driver.accounts.owner.id).not.toBe(driver.accounts.other.id);
  expect(new Set(Object.values(driver.types)).size).toBe(3);
  expect(await shelfPage({ orderBy: 'lastActivity' })).toEqual({ items: [], next: null });
  expect(totals(await summary())).toEqual(zeroTotals);
  expect(await typeFacets()).toEqual([]);
  expect(await body(await get('/v1/libraryEntries'))).toEqual({ libraryEntries: [], next: null });
});

test('an omitted orderBy keeps the existing list payload and updatedAt ordering', async () => {
  const [a, b, c] = await driver.provisionSubjects(3);
  await atMinute(1);
  const first = await entry(a!.id);
  const second = await entry(b!.id);
  await atMinute(2);
  const third = await entry(c!.id, 'in_progress');
  await atMinute(9);
  const session = await start(a!.id);
  await record(session, { amount: '3' });

  const listed = await body<{ libraryEntries: StoredView[]; next: string | null }>(await get('/v1/libraryEntries'));
  expect(Object.keys(listed).sort()).toEqual(['libraryEntries', 'next']);
  expect(listed.next).toBeNull();
  for (const item of listed.libraryEntries) expect(Object.keys(item).sort()).toEqual(ENTRY_KEYS);
  const tied = [first.subjectId, second.subjectId].sort();
  expect(ids(listed.libraryEntries)).toEqual([third.subjectId, ...tied]);
  expect(listed.libraryEntries.find((item) => item.subjectId === a!.id)).toEqual(await readEntry(a!.id));
  expect(
    ids((await body<{ libraryEntries: StoredView[] }>(await get('/v1/libraryEntries?state=planned'))).libraryEntries),
  ).toEqual(tied);
  for (const extra of ['direction=asc', 'type=anything'])
    await problem(await get(`/v1/libraryEntries?${extra}`), 400, 'invalid_request');
});

// --- Last activity ----------------------------------------------------------------------------------------------------

test('entry-only changes order the shelf by last activity newest first', async () => {
  const [a, b, c] = await driver.provisionSubjects(3);
  await atMinute(1);
  const ea = await entry(a!.id);
  await atMinute(2);
  await entry(b!.id);
  await atMinute(3);
  await entry(c!.id);
  let items = await shelf();
  expect(ids(items)).toEqual([c!.id, b!.id, a!.id]);
  for (const item of items) {
    expect(item.lastActivityAt).toBe(item.updatedAt);
    expect(item.activeProgressSession).toBeNull();
    expect(item.finishedAt).toBeNull();
  }
  await atMinute(4);
  const changed = await setState(ea, 'in_progress');
  items = await shelf();
  expect(ids(items)).toEqual([a!.id, c!.id, b!.id]);
  expect(items[0]).toMatchObject({
    lastActivityAt: T(4),
    updatedAt: T(4),
    createdAt: T(1),
    revision: changed.revision,
  });
});

test('every progress transition advances last activity without touching the entry', async () => {
  const [a, b] = await driver.provisionSubjects(2);
  await atMinute(1);
  await entry(a!.id);
  await atMinute(2);
  await entry(b!.id);
  const before = { a: await readEntry(a!.id), b: await readEntry(b!.id) };
  const activity = async () => Object.fromEntries((await shelf()).map((item) => [item.subjectId, item.lastActivityAt]));

  await atMinute(10);
  const sa = await start(a!.id);
  expect(ids(await shelf())).toEqual([a!.id, b!.id]);
  expect((await activity())[a!.id]).toBe(T(10));
  await atMinute(11);
  const sb = await start(b!.id, 'cursor_position', 'page');
  expect(ids(await shelf())).toEqual([b!.id, a!.id]);
  await atMinute(12);
  const recorded = await record(sa, { amount: '4' });
  expect(ids(await shelf())).toEqual([a!.id, b!.id]);
  expect((await activity())[a!.id]).toBe(T(12));
  await atMinute(13);
  await transition(recorded, 'complete');
  expect(await activity()).toEqual({ [a!.id]: T(13), [b!.id]: T(11) });
  const [afterComplete] = await shelf();
  expect(afterComplete).toMatchObject({ subjectId: a!.id, activeProgressSession: null });
  await atMinute(14);
  await transition(sb, 'abandon');
  expect(await activity()).toEqual({ [a!.id]: T(13), [b!.id]: T(14) });
  expect(ids(await shelf())).toEqual([b!.id, a!.id]);

  expect(await readEntry(a!.id)).toEqual(before.a);
  expect(await readEntry(b!.id)).toEqual(before.b);
  const stored = (await driver.inspect()).entries;
  expect(stored.find((row) => row.subjectId === a!.id)).toMatchObject({
    revision: before.a.revision,
    updatedAt: before.a.updatedAt,
  });
});

test('progress before an entry exists creates no entry and counts when the entry is created', async () => {
  const [s, fresh] = await driver.provisionSubjects(2);
  await atMinute(5);
  const session = await start(s!.id);
  expect(await shelf()).toEqual([]);
  await problem(await get(`/v1/libraryEntries/${s!.id}`), 404, 'not_found');
  let inspection = await driver.inspect();
  expect(inspection.entries).toEqual([]);
  expect(inspection.heads).toMatchObject([
    { accountId: driver.accounts.owner.id, subjectId: s!.id, lastChangedAt: T(5) },
  ]);
  expect(inspection.counts).toEqual([]);

  await atMinute(3);
  const created = await entry(s!.id);
  expect(created.createdAt).toBe(T(3));
  await atMinute(9);
  await entry(fresh!.id);
  const items = await shelf();
  expect(ids(items)).toEqual([fresh!.id, s!.id]);
  expect(items[1]).toMatchObject({ lastActivityAt: T(5), createdAt: T(3), updatedAt: T(3) });
  expect(items[1]!.activeProgressSession).toEqual(session);
  inspection = await driver.inspect();
  expect(inspection.entries.find((row) => row.subjectId === s!.id)).toMatchObject({ activityAt: T(5) });
  await expectCountersMatch();
});

test('deleting and recreating an entry keeps the persisted progress activity', async () => {
  const [s] = await driver.provisionSubjects(1);
  await atMinute(1);
  const created = await entry(s!.id);
  await atMinute(4);
  const session = await start(s!.id);
  await atMinute(6);
  await removeEntry(created);
  expect(await shelf()).toEqual([]);
  let inspection = await driver.inspect();
  expect(inspection.sessions).toHaveLength(1);
  expect(inspection.heads).toMatchObject([{ subjectId: s!.id, lastChangedAt: T(4) }]);

  await atMinute(7);
  await record(session, { amount: '2' });
  expect(await shelf()).toEqual([]);
  await problem(await get(`/v1/libraryEntries/${s!.id}`), 404, 'not_found');
  await atMinute(8);
  await entry(s!.id);
  let [item] = await shelf();
  expect(item).toMatchObject({ subjectId: s!.id, lastActivityAt: T(8), createdAt: T(8), revision: 1 });
  expect(item!.activeProgressSession).toMatchObject({ id: session.id, amount: '2' });

  const recreated = await readEntry(s!.id);
  await atMinute(9);
  await removeEntry(recreated);
  await atMinute(12);
  const later = await start(s!.id);
  await atMinute(10);
  await entry(s!.id);
  [item] = await shelf();
  expect(item).toMatchObject({ lastActivityAt: T(12), createdAt: T(10) });
  expect(item!.activeProgressSession!.id).toBe(later.id);
  inspection = await driver.inspect();
  expect(inspection.heads).toMatchObject([{ lastChangedAt: T(12) }]);
});

test('another subject and another account never advance a shelf', async () => {
  const [a, b, c] = await driver.provisionSubjects(3);
  await atMinute(1);
  await entry(a!.id);
  await atMinute(2);
  await entry(b!.id);
  await atMinute(3);
  await entry(a!.id, 'planned', 'other');
  await atMinute(20);
  await start(a!.id, 'scalar_amount', 'page', {}, 'other');
  await atMinute(21);
  await start(c!.id);
  const owner = await shelf();
  expect(ids(owner)).toEqual([b!.id, a!.id]);
  expect(Object.fromEntries(owner.map((item) => [item.subjectId, item.lastActivityAt]))).toEqual({
    [a!.id]: T(1),
    [b!.id]: T(2),
  });
  expect(owner.every((item) => item.activeProgressSession === null)).toBe(true);
  const other = await shelf({}, 'other');
  expect(other).toHaveLength(1);
  expect(other[0]).toMatchObject({ subjectId: a!.id, lastActivityAt: T(20) });
  expect(other[0]!.activeProgressSession).toMatchObject({ subjectId: a!.id });
  expect(JSON.stringify(other)).not.toContain(driver.accounts.owner.id);
});

test('any session of the subject advances activity and the displayed session is the most recently changed active one', async () => {
  const [s] = await driver.provisionSubjects(1);
  await atMinute(1);
  await entry(s!.id);
  const active = async () => (await shelf())[0]!;
  await atMinute(2);
  const first = await start(s!.id);
  await atMinute(3);
  const second = await start(s!.id);
  await atMinute(4);
  const third = await start(s!.id);
  expect((await active()).activeProgressSession!.id).toBe(third.id);
  await atMinute(5);
  const touched = await record(first, { amount: '8' });
  let item = await active();
  expect(item.activeProgressSession).toEqual(touched);
  expect(item.lastActivityAt).toBe(T(5));
  await atMinute(6);
  await transition(touched, 'complete');
  item = await active();
  expect(item.lastActivityAt).toBe(T(6));
  expect(item.activeProgressSession!.id).toBe(third.id);
  await atMinute(7);
  await transition(third, 'abandon');
  item = await active();
  expect(item.lastActivityAt).toBe(T(7));
  expect(item.activeProgressSession!.id).toBe(second.id);
  await atMinute(8);
  await transition(second, 'complete');
  item = await active();
  expect(item).toMatchObject({ lastActivityAt: T(8), activeProgressSession: null });
});

test('active sessions changed at the same instant resolve by session id', async () => {
  const [s] = await driver.provisionSubjects(1);
  await atMinute(1);
  await entry(s!.id);
  await atMinute(10);
  const one = await start(s!.id);
  const two = await start(s!.id);
  expect((await shelf())[0]!.activeProgressSession!.id).toBe([one.id, two.id].sort()[0]!);
  await atMinute(11);
  const newer = await start(s!.id);
  expect((await shelf())[0]!.activeProgressSession!.id).toBe(newer.id);
});

test('a reread is a new session and never borrows a completed session', async () => {
  const [s] = await driver.provisionSubjects(1);
  await atMinute(1);
  await entry(s!.id, 'completed');
  await atMinute(2);
  const old = await start(s!.id, 'scalar_amount', 'page', { total: '100' });
  const recorded = await record(old, { amount: '100' });
  await atMinute(3);
  await transition(recorded, 'complete');
  expect((await shelf())[0]!.activeProgressSession).toBeNull();
  await atMinute(5);
  const reread = await start(s!.id, 'scalar_amount', 'page', { total: '100' });
  const [item] = await shelf();
  expect(reread.id).not.toBe(old.id);
  expect(item!.activeProgressSession).toEqual(reread);
  expect(item!.activeProgressSession).toMatchObject({
    amount: null,
    completedUnitCount: 0,
    state: 'active',
    revision: 1,
  });
  expect(item!.lastActivityAt).toBe(T(5));
});

test('all three progress modes embed the exact session strings nulls and sparse completed unit counts', async () => {
  const [scalar, cursor, units] = await driver.provisionSubjects(3);
  for (const subject of [scalar!, cursor!, units!]) {
    await atMinute(1);
    await entry(subject.id, 'in_progress');
  }
  await atMinute(2);
  const s1 = await start(scalar!.id, 'scalar_amount', 'page', { total: '320.5' });
  const s2 = await start(cursor!.id, 'cursor_position', 'chapter');
  const s3 = await start(units!.id, 'completed_units', 'episode');
  let items = await shelf({ state: 'in_progress' });
  for (const item of items)
    expect(item.activeProgressSession).toEqual(await readSession(item.activeProgressSession!.id));
  expect(items.find((item) => item.subjectId === scalar!.id)!.activeProgressSession).toMatchObject({
    amount: null,
    total: '320.5',
  });
  expect(items.find((item) => item.subjectId === cursor!.id)!.activeProgressSession).toMatchObject({
    locator: null,
    position: null,
  });

  await atMinute(3);
  await record(s1, { amount: '12.25' });
  await atMinute(4);
  await record(s2, { locator: 'epubcfi(/6/14[ch7]!/4/2)', position: '0.375' });
  await atMinute(5);
  await record(s3, { add: ['1', '3', '7'] });
  items = await shelf({ state: 'in_progress' });
  expect(items).toHaveLength(3);
  for (const item of items)
    expect(item.activeProgressSession).toEqual(await readSession(item.activeProgressSession!.id));
  const byId = Object.fromEntries(items.map((item) => [item.subjectId, item.activeProgressSession!]));
  expect(byId[scalar!.id]).toMatchObject({
    mode: 'scalar_amount',
    amount: expect.any(String),
    locator: null,
    position: null,
  });
  expect(byId[cursor!.id]).toMatchObject({
    mode: 'cursor_position',
    locator: 'epubcfi(/6/14[ch7]!/4/2)',
    position: expect.any(String),
    amount: null,
  });
  expect(byId[units!.id]).toMatchObject({ mode: 'completed_units', completedUnitCount: 3, amount: null, total: null });
  expect(JSON.stringify(items)).not.toContain('completedUnits');
  expect(JSON.stringify(items)).not.toContain('transactionId');
  expect(JSON.stringify(items)).not.toContain(driver.accounts.owner.id);
});

test('accepted records without a net effect count as activity and idempotent replays do not', async () => {
  const [scalar, units] = await driver.provisionSubjects(2);
  await atMinute(1);
  await entry(scalar!.id);
  await entry(units!.id);
  await atMinute(2);
  const a = await start(scalar!.id);
  const u = await start(units!.id, 'completed_units', 'page');
  await atMinute(3);
  const first = await record(a, { amount: '5' });
  const unitFirst = await record(u, { add: ['2', '4'] });
  await atMinute(4);
  const again = await record(first, { amount: '5' });
  const unitAgain = await record(unitFirst, { add: ['2'] });
  expect(again.revision).toBe(first.revision + 1);
  expect(unitAgain.completedUnitCount).toBe(2);
  const activity = async () => Object.fromEntries((await shelf()).map((item) => [item.subjectId, item.lastActivityAt]));
  expect(await activity()).toEqual({ [scalar!.id]: T(4), [units!.id]: T(4) });

  await atMinute(5);
  const replayKey = key();
  const path = `/v1/progressSessions/${again.id}:record`;
  const sent = await write('POST', path, { revision: again.revision, amount: '6' }, 'owner', replayKey);
  expect(sent.status).toBe(200);
  const original = await sent.json();
  const before = await driver.inspect();
  await atMinute(9);
  const replay = await write('POST', path, { revision: again.revision, amount: '6' }, 'owner', replayKey);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(original);
  expect((await activity())[scalar!.id]).toBe(T(5));
  expect(await driver.inspect()).toEqual(before);
});

test('a failed compare-and-swap or unknown subject leaves activity entries and counters untouched', async () => {
  const [s, other] = await driver.provisionSubjects(2);
  await atMinute(1);
  const created = await entry(s!.id);
  await atMinute(2);
  const session = await start(s!.id);
  const recorded = await record(session, { amount: '1' });
  await expectCountersMatch();
  const before = await driver.inspect();
  const items = await shelf();

  await atMinute(30);
  await problem(
    await write('POST', `/v1/progressSessions/${session.id}:record`, { revision: session.revision, amount: '9' }),
    409,
    'conflict',
  );
  await problem(
    await write('POST', `/v1/progressSessions/${session.id}:complete`, { revision: session.revision }),
    409,
    'conflict',
  );
  await problem(await putEntry(s!.id, 'completed', created.revision + 5), 409, 'conflict');
  await problem(await write('DELETE', `/v1/libraryEntries/${s!.id}?revision=${created.revision + 5}`), 409, 'conflict');
  await problem(
    await write('POST', '/v1/progressSessions', {
      subjectId: driver.unknownSubjectId,
      mode: 'scalar_amount',
      unit: 'page',
    }),
    404,
    'not_found',
  );
  expect((await putEntry(other!.id, 'planned', undefined, 'other')).status).toBe(201);
  expect(await shelf()).toEqual(items);
  const after = await driver.inspect();
  const mine = <R extends { accountId: string }>(rows: R[]) =>
    rows.filter((row) => row.accountId === driver.accounts.owner.id);
  expect(mine(after.entries)).toEqual(mine(before.entries));
  expect(mine(after.sessions)).toEqual(mine(before.sessions));
  expect(mine(after.heads)).toEqual(mine(before.heads));
  expect(mine(after.counts)).toEqual(mine(before.counts));
  expect(after.completedUnits).toEqual(before.completedUnits);
  expect(after.changes).toEqual(before.changes);
  expect(await readSession(recorded.id)).toEqual(recorded);
  await expectCountersMatch();
});

// --- Completion dates -------------------------------------------------------------------------------------------------

test('finished dates follow manual completion session completion and rereads', async () => {
  const [a, b] = await driver.provisionSubjects(2);
  const finished = async (id: string) => (await shelf()).find((item) => item.subjectId === id)!.finishedAt;
  await atMinute(1);
  let ea = await entry(a!.id);
  expect(await finished(a!.id)).toBeNull();
  await atMinute(5);
  ea = await setState(ea, 'completed');
  expect(await finished(a!.id)).toBe(T(5));
  await atMinute(6);
  ea = await setState(ea, 'completed');
  expect(await finished(a!.id)).toBe(T(5));
  await atMinute(7);
  ea = await setState(ea, 'in_progress');
  expect(await finished(a!.id)).toBe(T(5));
  await atMinute(8);
  const reread = await start(a!.id);
  const recorded = await record(reread, { amount: '3' });
  expect(await finished(a!.id)).toBe(T(5));
  await atMinute(9);
  await transition(recorded, 'complete');
  expect(await finished(a!.id)).toBe(T(9));
  expect((await readEntry(a!.id)).state).toBe('in_progress');
  await atMinute(10);
  ea = await setState(ea, 'completed');
  expect(await finished(a!.id)).toBe(T(10));

  await atMinute(11);
  await entry(b!.id);
  await atMinute(12);
  const sb = await start(b!.id);
  await atMinute(13);
  await transition(sb, 'complete');
  expect(await finished(b!.id)).toBe(T(13));
  expect((await readEntry(b!.id)).state).toBe('planned');
  await atMinute(14);
  const abandoned = await start(b!.id);
  await atMinute(15);
  await transition(abandoned, 'abandon');
  expect(await finished(b!.id)).toBe(T(13));

  await atMinute(20);
  await removeEntry(await readEntry(b!.id));
  await atMinute(21);
  await entry(b!.id);
  expect(await finished(b!.id)).toBe(T(13));
  const dated = await shelf({ orderBy: 'finishedAt' });
  expect(ids(dated)).toEqual([b!.id, a!.id]);
});

test('each status tab opens with its documented sort and the three sorts differ', async () => {
  const subjects = await driver.provisionSubjects(15);
  const groups = new Map<EntryState, { x: string; y: string; z: string; base: number }>();
  for (const [index, state] of STATES.entries()) {
    const base = index * 100;
    const [x, y, z] = subjects.slice(index * 3, index * 3 + 3).map((subject) => subject.id) as [string, string, string];
    groups.set(state, { x, y, z, base });
    await atMinute(base + 1);
    await entry(x, state);
    await atMinute(base + 2);
    await entry(y, state);
    await atMinute(base + 3);
    await entry(z, state);
    await atMinute(base + 4);
    const sz = await start(z);
    await atMinute(base + 5);
    await transition(sz, 'complete');
    await atMinute(base + 6);
    const sy = await start(y);
    await atMinute(base + 7);
    await transition(sy, 'complete');
    await atMinute(base + 10);
    await start(x);
  }
  for (const state of STATES) {
    const { x, y, z } = groups.get(state)!;
    const order = async (orderBy: ShelfOrder) => ids(await shelf({ state, orderBy }));
    expect(await order('createdAt')).toEqual([z, y, x]);
    expect(await order('lastActivity')).toEqual([x, y, z]);
    expect(await order('finishedAt')).toEqual([y, z, x]);
    const opening = {
      in_progress: [x, y, z],
      planned: [z, y, x],
      completed: [y, z, x],
      paused: [x, y, z],
      dropped: [x, y, z],
    };
    expect(await order(DEFAULT_ORDER[state])).toEqual(opening[state]);
    expect(ids(await shelf({ state, orderBy: DEFAULT_ORDER[state], direction: 'desc' }))).toEqual(
      await order(DEFAULT_ORDER[state]),
    );
    expect(ids(await shelf({ state, orderBy: DEFAULT_ORDER[state], direction: 'asc' }))).toEqual(
      (await order(DEFAULT_ORDER[state])).reverse(),
    );
  }
});

// --- Sorts, ties and keyset walks -----------------------------------------------------------------------------------------

test('timestamp ties order by subject id and ascending mirrors descending in every sort', async () => {
  const subjects = await driver.provisionSubjects(5);
  const sorted = subjects.map((subject) => subject.id).sort();
  await atMinute(3);
  for (const subject of subjects) await entry(subject.id, 'completed');
  for (const orderBy of ORDERS) {
    expect(ids(await shelf({ orderBy }))).toEqual(sorted);
    expect(ids(await shelf({ orderBy, direction: 'desc' }))).toEqual(sorted);
    expect(ids(await shelf({ orderBy, direction: 'asc' }))).toEqual(mirror(sorted));
    expect(ids(await walk({ orderBy, direction: 'asc' }, 1))).toEqual(mirror(sorted));
    expect(ids(await walk({ orderBy, direction: 'desc' }, 2))).toEqual(sorted);
  }
  const noFinish = await driver.provisionSubjects(3);
  await atMinute(4);
  for (const subject of noFinish) await entry(subject.id, 'planned');
  const planned = noFinish.map((subject) => subject.id).sort();
  expect(ids(await shelf({ orderBy: 'finishedAt', direction: 'desc' }))).toEqual([...sorted, ...planned]);
  expect(ids(await shelf({ orderBy: 'finishedAt', direction: 'asc' }))).toEqual([
    ...mirror(planned),
    ...mirror(sorted),
  ]);
});

type Facts = { id: string; state: EntryState; created: number; activity: number; finished: number | null };
function expectedOrder(facts: readonly Facts[], orderBy: ShelfOrder, direction: ShelfDirection) {
  const sortKey = (fact: Facts) =>
    orderBy === 'createdAt' ? fact.created : orderBy === 'lastActivity' ? fact.activity : (fact.finished ?? -Infinity);
  const compare = (x: number | string, y: number | string) => (x === y ? 0 : x < y ? -1 : 1);
  return [...facts]
    .sort((a, b) => {
      const byKey = compare(sortKey(a), sortKey(b));
      if (byKey !== 0) return direction === 'desc' ? -byKey : byKey;
      return direction === 'desc' ? compare(a.id, b.id) : compare(b.id, a.id);
    })
    .map((fact) => fact.id);
}
async function buildLibrary(count: number) {
  const subjects = await driver.provisionSubjects(count);
  const facts: Facts[] = [];
  for (const [index, subject] of subjects.entries()) {
    const minute = 1 + Math.floor(index / 3);
    if (index % 3 === 0) await atMinute(minute);
    const state = STATES[index % 5]!;
    await entry(subject.id, state);
    facts.push({
      id: subject.id,
      state,
      created: BASE + minute * 60_000,
      activity: BASE + minute * 60_000,
      finished: state === 'completed' ? BASE + minute * 60_000 : null,
    });
  }
  const sessions = new Map<number, SessionView>();
  for (const [index, fact] of facts.entries()) {
    if (index % 4 !== 0) continue;
    await atMinute(200 + index);
    sessions.set(index, await start(fact.id));
    fact.activity = BASE + (200 + index) * 60_000;
  }
  for (const [index, fact] of facts.entries()) {
    if (index % 8 !== 0) continue;
    await atMinute(300 + index);
    await transition(sessions.get(index)!, 'complete');
    fact.activity = fact.finished = BASE + (300 + index) * 60_000;
  }
  return facts;
}

test('keyset walks at limit 1 and 48 return every entry once for each sort and direction', async () => {
  const facts = await buildLibrary(60);
  for (const orderBy of ORDERS) {
    for (const direction of DIRECTIONS) {
      const expected = expectedOrder(facts, orderBy, direction);
      const wide = await walk({ orderBy, direction }, 48);
      expect(ids(wide)).toEqual(expected);
      expect(wide.length).toBe(60);
      const planned = facts.filter((fact) => fact.state === 'planned');
      expect(ids(await walk({ orderBy, direction, state: 'planned' }, 1))).toEqual(
        expectedOrder(planned, orderBy, direction),
      );
      const byId = new Map(facts.map((fact) => [fact.id, fact]));
      for (const item of wide) {
        const fact = byId.get(item.subjectId)!;
        expect(Date.parse(item.createdAt)).toBe(fact.created);
        expect(Date.parse(item.lastActivityAt)).toBe(fact.activity);
        expect(item.finishedAt === null ? null : Date.parse(item.finishedAt)).toBe(fact.finished);
      }
    }
  }
  const first = await shelfPage({ orderBy: 'lastActivity', limit: 48 });
  expect(first.items).toHaveLength(48);
  expect(first.next).not.toBeNull();
});

test('state filtering and the Continue row use the same shelf mode', async () => {
  const [a, b, c, d] = await driver.provisionSubjects(4);
  await atMinute(1);
  const ea = await entry(a!.id, 'in_progress');
  await entry(b!.id, 'in_progress');
  await entry(c!.id, 'planned');
  await entry(d!.id, 'completed');
  await atMinute(2);
  const sa = await start(a!.id);
  await atMinute(3);
  await start(c!.id);
  const continueRow = await shelf({ state: 'in_progress', orderBy: 'lastActivity', limit: 48 });
  expect(ids(continueRow)).toEqual([a!.id, b!.id]);
  expect(continueRow[0]!.activeProgressSession).toEqual(sa);
  expect(continueRow[1]!.activeProgressSession).toBeNull();
  expect(ids(await shelf({ state: 'planned' }))).toEqual([c!.id]);
  expect(ids(await shelf())).toEqual([c!.id, a!.id, ...[b!.id, d!.id].sort()]);
  await atMinute(4);
  await setState(ea, 'paused');
  expect(ids(await shelf({ state: 'in_progress' }))).toEqual([b!.id]);
  expect(ids(await shelf({ state: 'paused' }))).toEqual([a!.id]);
  expect((await shelf({ state: 'paused' }))[0]!.activeProgressSession).toEqual(sa);
});

test('BASIC and FULL shelf items keep the entry fields and FULL adds only the subject', async () => {
  const [a] = await driver.provisionSubjects(1);
  await atMinute(1);
  await entry(a!.id, 'in_progress');
  await atMinute(2);
  const session = await start(a!.id);
  const basic = await shelf({ view: 'BASIC' });
  const full = await shelf({ view: 'FULL' });
  expect(Object.keys(basic[0]!).sort()).toEqual(SHELF_KEYS);
  expect(Object.keys(full[0]!).sort()).toEqual([...SHELF_KEYS, 'subject'].sort());
  const { subject, ...rest } = full[0]!;
  expect(rest).toEqual(basic[0]!);
  expect(subject).toBeTruthy();
  expect(full[0]!.activeProgressSession).toEqual(session);
  expect(Object.keys(full[0]!.activeProgressSession!).sort()).toEqual(SESSION_KEYS);
});

test('shelf requests with unknown values are refused as invalid requests', async () => {
  for (const query of [
    'orderBy=bogus',
    'orderBy=lastActivity&direction=sideways',
    'orderBy=lastActivity&limit=0',
    'orderBy=lastActivity&limit=101',
    'orderBy=lastActivity&state=bogus',
    `orderBy=lastActivity&type=${'x'.repeat(257)}`,
    'orderBy=lastActivity&unknown=1',
  ])
    await problem(await get(`/v1/libraryEntries?${query}`), 400, 'invalid_request');
  await problem(await get('/v1/libraryShelfSummary?unknown=1'), 400, 'invalid_request');
});

// --- Cursors ----------------------------------------------------------------------------------------------------------------

test('shelf cursors are bound to account state type order and direction and reject tampering and expiry', async () => {
  const subjects = await driver.provisionSubjects(3);
  const anime = await driver.provisionSubjects(2, { type: driver.types.anime });
  await atMinute(1);
  for (const subject of [...subjects, ...anime]) await entry(subject.id, 'planned');
  await entry(subjects[0]!.id, 'planned', 'other');
  await entry(subjects[1]!.id, 'planned', 'other');
  const base: ShelfParameters = { orderBy: 'lastActivity', direction: 'desc', limit: 1 };
  const issued = await shelfPage(base);
  const token = issued.next!;
  expect(token).toBeTruthy();
  expect(issued.next).not.toContain(subjects[0]!.id);
  expect((await shelfPage({ ...base, cursor: token })).items).toHaveLength(1);
  const rejected: [ShelfParameters, Persona][] = [
    [{ ...base, cursor: token }, 'other'],
    [{ ...base, state: 'planned', cursor: token }, 'owner'],
    [{ ...base, type: driver.types.anime, cursor: token }, 'owner'],
    [{ ...base, orderBy: 'createdAt', cursor: token }, 'owner'],
    [{ ...base, direction: 'asc', cursor: token }, 'owner'],
  ];
  for (const [parameters, as] of rejected) await problem(await get(shelfPath(parameters), as), 400, 'invalid_cursor');
  const middle = Math.floor(token.length / 2);
  const tampered = `${token.slice(0, middle)}${token[middle] === 'A' ? 'B' : 'A'}${token.slice(middle + 1)}`;
  for (const bad of [tampered, 'not-a-cursor', token.slice(1), `${token}x`])
    await problem(await get(shelfPath({ ...base, cursor: bad })), 400, 'invalid_cursor');
  const oldListCursor = (await body<{ next: string }>(await get('/v1/libraryEntries?limit=1'))).next;
  await problem(await get(shelfPath({ ...base, cursor: oldListCursor })), 400, 'invalid_cursor');
  await driver.ageCursors(16 * 60_000);
  await problem(await get(shelfPath({ ...base, cursor: token })), 400, 'invalid_cursor');
  const facet = await body<{ next: string | null }>(await get('/v1/libraryShelfTypes?limit=1'));
  expect(facet.next).not.toBeNull();
  await problem(await get(shelfPath({ ...base, cursor: facet.next! })), 400, 'invalid_cursor');
});

test('a continuation resumes from its key under concurrent activity without inventing a snapshot', async () => {
  const [a, b, c] = await driver.provisionSubjects(3);
  await atMinute(1);
  await entry(a!.id);
  await atMinute(2);
  await entry(b!.id);
  await atMinute(3);
  await entry(c!.id);
  const first = await shelfPage({ orderBy: 'lastActivity', limit: 1 });
  expect(ids(first.items)).toEqual([c!.id]);
  await atMinute(10);
  await start(a!.id);
  const second = await shelfPage({ orderBy: 'lastActivity', limit: 2, cursor: first.next! });
  expect(ids(second.items)).toEqual([b!.id]);
  expect(second.next).toBeNull();
  expect(ids(await shelf())).toEqual([a!.id, c!.id, b!.id]);
});

// --- Authorization --------------------------------------------------------------------------------------------------------------

test('shelf reads are private to the owner and scope-limited tokens are refused', async () => {
  const [a, b] = await driver.provisionSubjects(2);
  await atMinute(1);
  await entry(a!.id, 'in_progress');
  await atMinute(2);
  await start(a!.id);
  await entry(b!.id, 'planned', 'other');
  expect(ids(await shelf())).toEqual([a!.id]);
  expect(ids(await shelf({}, 'other'))).toEqual([b!.id]);
  expect((await shelf({}, 'other'))[0]!.activeProgressSession).toBeNull();

  const shelfPaths = [
    shelfPath({ limit: 48 }),
    shelfPath({ limit: 48, view: 'FULL' }),
    shelfPath({ limit: 48, state: 'in_progress' }),
  ];
  for (const path of shelfPaths) {
    await problem(await get(path, 'anonymous'), 401);
    expect([401, 403]).toContain((await get(path, 'suspended')).status);
    await problem(await get(path, 'libraryOnly'), 403, 'forbidden');
    await problem(await get(path, 'progressOnly'), 403, 'forbidden');
    await problem(await get(path, 'ungranted'), 403, 'forbidden');
  }
  const oldPath = '/v1/libraryEntries';
  expect((await get(oldPath, 'libraryOnly')).status).toBe(200);
  await problem(await get(oldPath, 'progressOnly'), 403, 'forbidden');
  await problem(await get(oldPath, 'ungranted'), 403, 'forbidden');
  await problem(await get(oldPath, 'anonymous'), 401);
  expect([401, 403]).toContain((await get(oldPath, 'suspended')).status);

  for (const path of ['/v1/libraryShelfSummary', '/v1/libraryShelfTypes']) {
    expect((await get(path, 'libraryOnly')).status).toBe(200);
    await problem(await get(path, 'progressOnly'), 403, 'forbidden');
    await problem(await get(path, 'ungranted'), 403, 'forbidden');
    await problem(await get(path, 'anonymous'), 401);
    expect([401, 403]).toContain((await get(path, 'suspended')).status);
  }
  expect(totals(await summary(undefined, 'libraryOnly')).in_progress).toBe(1);
  expect(totals(await summary(undefined, 'other')).in_progress).toBe(0);
});

test('closing the reading_progress gate refuses the shelf only and closing personal_library refuses every read', async () => {
  const [a] = await driver.provisionSubjects(1);
  await atMinute(1);
  await entry(a!.id);
  const gate = async (name: Gate, open: boolean) => driver.setGate(name, open);
  try {
    await gate('reading_progress', false);
    await problem(await get(shelfPath({ limit: 48 })), 403, 'platform_closed');
    await problem(await get(shelfPath({ limit: 48, state: 'in_progress' }), 'other'), 403, 'platform_closed');
    expect((await get('/v1/libraryEntries')).status).toBe(200);
    expect((await get('/v1/libraryShelfSummary')).status).toBe(200);
    expect((await get('/v1/libraryShelfTypes')).status).toBe(200);
    await gate('reading_progress', true);
    expect(ids(await shelf())).toEqual([a!.id]);

    await gate('personal_library', false);
    for (const path of [
      shelfPath({ limit: 48 }),
      '/v1/libraryEntries',
      '/v1/libraryShelfSummary',
      '/v1/libraryShelfTypes',
    ])
      await problem(await get(path), 403, 'platform_closed');
    await gate('personal_library', true);
    expect(ids(await shelf())).toEqual([a!.id]);
  } finally {
    await gate('reading_progress', true);
    await gate('personal_library', true);
  }
});

// --- Counts, types and the projection ----------------------------------------------------------------------------------------------

test('tab counts follow every state transition delete Collection and privacy boundary', async () => {
  const [a, b, c] = await driver.provisionSubjects(3);
  const owner = async () => totals(await summary());
  expect(await owner()).toEqual(zeroTotals);
  await atMinute(1);
  let ea = await entry(a!.id, 'planned');
  expect(await owner()).toEqual({ ...zeroTotals, all: 1, planned: 1 });
  await atMinute(2);
  ea = await setState(ea, 'in_progress');
  expect(await owner()).toEqual({ ...zeroTotals, all: 1, in_progress: 1 });
  const eb = await entry(b!.id, 'planned');
  const ec = await entry(c!.id, 'completed');
  expect(await owner()).toEqual({ ...zeroTotals, all: 3, in_progress: 1, planned: 1, completed: 1 });
  await atMinute(3);
  await start(a!.id);
  expect(await owner()).toEqual({ ...zeroTotals, all: 3, in_progress: 1, planned: 1, completed: 1 });
  await problem(await putEntry(b!.id, 'dropped', eb.revision + 3), 409, 'conflict');
  expect(await owner()).toEqual({ ...zeroTotals, all: 3, in_progress: 1, planned: 1, completed: 1 });
  await setState(eb, 'paused');
  await setState(ec, 'dropped');
  expect(await owner()).toEqual({ ...zeroTotals, all: 3, in_progress: 1, paused: 1, dropped: 1 });
  await removeEntry(await readEntry(a!.id));
  expect(await owner()).toEqual({ ...zeroTotals, all: 2, paused: 1, dropped: 1 });
  await atMinute(4);
  await entry(a!.id, 'planned');
  expect(await owner()).toEqual({ ...zeroTotals, all: 3, planned: 1, paused: 1, dropped: 1 });

  expect(totals(await summary(undefined, 'other'))).toEqual(zeroTotals);
  await entry(a!.id, 'completed', 'other');
  expect(totals(await summary(undefined, 'other'))).toEqual({ ...zeroTotals, all: 1, completed: 1 });
  expect((await owner()).completed).toBe(0);

  const created = await body<{ collection: { id: string; revision: number } }>(
    await write('POST', '/v1/collections', { title: 'Shelf', description: 'x', visibility: 'private' }),
    201,
  );
  expect((await owner()).collections).toBe(1);
  expect(totals(await summary(undefined, 'other')).collections).toBe(0);
  const removed = await write(
    'DELETE',
    `/v1/collections/${created.collection.id}?revision=${created.collection.revision}`,
  );
  expect(removed.status).toBe(204);
  expect((await owner()).collections).toBe(0);
  await expectCountersMatch();
  await problem(await get('/v1/libraryShelfSummary', 'anonymous'), 401);
  for (const tab of TABS) expect(Object.keys((await summary())[tab]).sort()).toEqual(['shown', 'total']);
});

test('the type filter returns every matching entry with shown and total counts and pages the facets', async () => {
  const { book, anime, game } = driver.types;
  const books = await driver.provisionSubjects(3);
  const animes = await driver.provisionSubjects(2, { type: anime });
  const [g] = await driver.provisionSubjects(1, { type: game });
  await atMinute(1);
  await entry(books[0]!.id, 'planned');
  await entry(books[1]!.id, 'in_progress');
  await entry(books[2]!.id, 'completed');
  await atMinute(2);
  await entry(animes[0]!.id, 'planned');
  await entry(animes[1]!.id, 'planned');
  await entry(g!.id, 'dropped');
  await atMinute(3);
  await start(animes[1]!.id);

  const tabs = await summary(anime);
  expect(tabs.all).toEqual({ total: 6, shown: 2 });
  expect(tabs.planned).toEqual({ total: 3, shown: 2 });
  expect(tabs.in_progress).toEqual({ total: 1, shown: 0 });
  expect(tabs.completed).toEqual({ total: 1, shown: 0 });
  expect(tabs.dropped).toEqual({ total: 1, shown: 0 });
  expect(tabs.collections).toEqual({ total: 0, shown: 0 });
  const plain = await summary();
  for (const tab of TABS) expect(plain[tab].shown).toBe(plain[tab].total);
  expect((await summary('com.example.Unknown')).all).toEqual({ total: 6, shown: 0 });

  const items = await shelf({ type: anime });
  expect(ids(items)).toEqual([animes[1]!.id, animes[0]!.id]);
  expect(ids(await shelf({ type: anime, state: 'planned' }))).toEqual([animes[1]!.id, animes[0]!.id]);
  expect(ids(await shelf({ type: book, state: 'in_progress' }))).toEqual([books[1]!.id]);
  expect(await shelf({ type: 'com.example.Unknown' })).toEqual([]);
  expect(ids(await walk({ type: book, orderBy: 'createdAt' }, 1)).sort()).toEqual(
    books.map((subject) => subject.id).sort(),
  );
  expect(items[0]!.activeProgressSession).toMatchObject({ subjectId: animes[1]!.id });

  const expected = [
    { type: book, count: 3 },
    { type: anime, count: 2 },
    { type: game, count: 1 },
  ].sort((x, y) => (x.type < y.type ? -1 : 1));
  expect(await typeFacets()).toEqual(expected);
  expect(await typeFacets('owner', 1)).toEqual(expected);
  expect(await typeFacets('other')).toEqual([]);
  const facetPage = await body<{ next: string }>(await get('/v1/libraryShelfTypes?limit=1'));
  await problem(
    await get(`/v1/libraryShelfTypes?limit=1&cursor=${encodeURIComponent(facetPage.next)}`, 'other'),
    400,
    'invalid_cursor',
  );
  await expectCountersMatch();
});

test('a subject type change moves every holder between type filters and counts', async () => {
  const { book, anime, game } = driver.types;
  const [s, t] = await driver.provisionSubjects(2);
  await atMinute(1);
  await entry(s!.id, 'in_progress');
  await entry(t!.id, 'planned');
  await entry(s!.id, 'completed', 'other');
  expect(ids(await shelf({ type: book }))).toHaveLength(2);

  const first = await driver.changeSubjectType(s!.id, anime);
  await driver.settle();
  expect(ids(await shelf({ type: anime }))).toEqual([s!.id]);
  expect(ids(await shelf({ type: book }))).toEqual([t!.id]);
  expect(ids(await shelf({ type: anime }, 'other'))).toEqual([s!.id]);
  expect(await shelf({ type: book }, 'other')).toEqual([]);
  expect((await summary(anime)).in_progress).toEqual({ total: 1, shown: 1 });
  expect((await summary(book)).in_progress).toEqual({ total: 1, shown: 0 });
  expect((await summary(anime, 'other')).completed).toEqual({ total: 1, shown: 1 });
  expect(await typeFacets()).toEqual(
    [
      { type: book, count: 1 },
      { type: anime, count: 1 },
    ].sort((x, y) => (x.type < y.type ? -1 : 1)),
  );
  await expectCountersMatch();

  const second = await driver.changeSubjectType(s!.id, game);
  await driver.settle();
  expect(second.revision).toBeGreaterThan(first.revision);
  expect(ids(await shelf({ type: game }))).toEqual([s!.id]);
  expect(await shelf({ type: anime })).toEqual([]);
  expect(await typeFacets('other')).toEqual([{ type: game, count: 1 }]);
  const stored = (await driver.inspect()).entries.filter((row) => row.subjectId === s!.id);
  expect(stored.map((row) => row.subjectType)).toEqual([game, game]);
  await expectCountersMatch();
});

test('source revisions delivered twice or out of order converge on the current type', async () => {
  const { anime, game } = driver.types;
  const [s] = await driver.provisionSubjects(1);
  await atMinute(1);
  await entry(s!.id, 'planned');
  await entry(s!.id, 'planned', 'other');
  await driver.changeSubjectType(s!.id, anime);
  await driver.changeSubjectType(s!.id, game);
  await driver.settle();
  const settled = await driver.inspect();
  for (const order of ['reverse', 'repeat', 'reverse'] as const) {
    await driver.redeliver({ subjectId: s!.id, order });
    expect(ids(await shelf({ type: game }))).toEqual([s!.id]);
    expect(await shelf({ type: anime })).toEqual([]);
    expect((await summary(game)).all).toEqual({ total: 1, shown: 1 });
  }
  const replayed = await driver.inspect();
  expect(replayed.counts).toEqual(settled.counts);
  expect(replayed.entries.map((row) => row.subjectType)).toEqual(settled.entries.map((row) => row.subjectType));
  await driver.changeSubjectType(s!.id, anime);
  await driver.redeliver({ subjectId: s!.id, order: 'reverse' });
  expect(ids(await shelf({ type: anime }))).toEqual([s!.id]);
  expect(ids(await shelf({ type: anime }, 'other'))).toEqual([s!.id]);
  await expectCountersMatch();
});

test('merged subjects follow the survivor type including later type changes', async () => {
  const { anime } = driver.types;
  const [gone, survivor] = await driver.provisionSubjects(2);
  await atMinute(1);
  await entry(gone!.id, 'planned');
  await entry(survivor!.id, 'planned', 'other');
  await driver.mergeSubjects({ from: gone!.id, into: survivor!.id });
  await driver.settle();
  expect(ids(await shelf({ type: driver.types.book }))).toEqual([gone!.id]);
  const stored = (await driver.inspect()).entries.find((row) => row.accountId === driver.accounts.owner.id)!;
  expect(stored.subjectId).toBe(gone!.id);
  expect(stored.typeSourceId).toBe(survivor!.id);
  await driver.changeSubjectType(survivor!.id, anime);
  await driver.settle();
  expect(ids(await shelf({ type: anime }))).toEqual([gone!.id]);
  expect(ids(await shelf({ type: anime }, 'other'))).toEqual([survivor!.id]);
  expect(await shelf({ type: driver.types.book })).toEqual([]);
  expect((await summary(anime)).planned).toEqual({ total: 1, shown: 1 });
  await expectCountersMatch();
});

// --- Bounded cost -------------------------------------------------------------------------------------------------------------------

test('shelf order and active progress have a bounded same-account contract', async () => {
  const subjects = await driver.provisionSubjects(60);
  for (const [index, subject] of subjects.entries()) {
    await atMinute(1 + index);
    await entry(subject.id, STATES[index % 5]!);
    if (index % 2 === 0) {
      const session = await start(subject.id, index % 3 === 0 ? 'completed_units' : 'scalar_amount', 'page');
      if (index % 4 === 0) await transition(session, 'complete');
    }
  }
  const tested = await shelf();
  const issued = (await shelfPage({ limit: 48 })).next!;
  const scales = [256, 1024, 4096];
  type Cost = { statements: number; rows: number; buffers: number };
  const costs = new Map<string, Cost[]>();
  const record = (name: string, cost: Cost) => costs.set(name, [...(costs.get(name) ?? []), cost]);
  for (const scale of scales) {
    await driver.seed({ entries: scale, activeSessions: scale, inactiveSessions: scale });
    expect(await shelf()).toEqual(tested);
    const measured = async (name: string, operation: () => Promise<Response>, status = 200) => {
      const result = await driver.measure(operation);
      expect(result.value.status).toBe(status);
      record(name, { statements: result.statements, rows: result.rows, buffers: result.buffers });
    };
    await measured('first page', () => get(shelfPath({ limit: 48 })));
    await measured('continuation', () => get(shelfPath({ limit: 48, cursor: issued })));
    await measured('state page', () => get(shelfPath({ limit: 48, state: 'in_progress' })));
    await measured('type page', () =>
      get(shelfPath({ limit: 48, type: driver.types.book, orderBy: 'createdAt', direction: 'asc' })),
    );
    await measured('finished page', () => get(shelfPath({ limit: 48, orderBy: 'finishedAt', state: 'completed' })));
    await measured('summary', () => get('/v1/libraryShelfSummary'));
    await measured('type facets', () => get('/v1/libraryShelfTypes?limit=100'));
    const [fresh] = await driver.provisionSubjects(1);
    await atMinute(500 + scale);
    await measured('entry put', () => putEntry(fresh!.id, 'planned'), 201);
    await measured(
      'session start',
      () => write('POST', '/v1/progressSessions', { subjectId: fresh!.id, mode: 'scalar_amount', unit: 'page' }),
      201,
    );
    const live = (await shelf()).find((item) => item.subjectId === fresh!.id)!.activeProgressSession!;
    await measured('session record', () =>
      write('POST', `/v1/progressSessions/${live.id}:record`, { revision: live.revision, amount: '2' }),
    );
    const recorded = await readSession(live.id);
    await measured('session complete', () =>
      write('POST', `/v1/progressSessions/${live.id}:complete`, { revision: recorded.revision }),
    );
    const second = await start(fresh!.id);
    await measured('session abandon', () =>
      write('POST', `/v1/progressSessions/${second.id}:abandon`, { revision: second.revision }),
    );
    const current = await readEntry(fresh!.id);
    await measured(
      'entry delete',
      () => write('DELETE', `/v1/libraryEntries/${fresh!.id}?revision=${current.revision}`),
      204,
    );
  }
  for (const [name, samples] of costs) {
    const [small, ...larger] = samples;
    for (const sample of larger) {
      expect(`${name} statements ${sample.statements}`).toBe(`${name} statements ${small!.statements}`);
      expect(`${name} rows ${sample.rows}`).toBe(`${name} rows ${small!.rows}`);
      expect(sample.buffers).toBeLessThanOrEqual(small!.buffers * 2 + 16);
    }
  }
});
