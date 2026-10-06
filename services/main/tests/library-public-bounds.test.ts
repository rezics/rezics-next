import { expect, test } from 'bun:test';
import { readPublicShelves, readPublicStatusShelf, PUBLIC_SHELF_COST } from '../src/modules/library/public.ts';
import { readShelfPage } from '../src/modules/library/shelf-page.ts';
import { STATUS_SHELF_COST, type ReaderLibraryStatusStore, type ShelfRow } from '../src/modules/library/status.ts';
import { WorkReadInvalid, WorkReadMoved, type WorkReadSession } from '../src/modules/work/read-session.ts';

const id = (number: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const agent = id(900_000);

function fixture(size: number, visible: (index: number) => boolean = () => true,
  published: (index: number) => boolean = visible) {
  let revision = '0', visibility = 'public', graphCalls = 0, candidates = 0, batches = 0;
  const store = {
    fence: async () => revision,
    sortedPage: async (_agent: string, status: string, limit: number, _sort: string, _order: string,
      after?: { work: string }) => {
      batches++;
      const start = after ? Number(after.work.slice(-12)) + 1 : 1;
      const rows = Array.from({ length: status === 'reading' ? Math.max(0, Math.min(limit, size - start + 1)) : 0 },
        (_, index): ShelfRow => ({ work: id(start + index), status: 'reading', version: 1,
          startedOn: null, finishedOn: null, changedAt: '2026-01-01', sortValue: String(start + index) }));
      candidates += rows.length;
      return rows;
    },
  } as unknown as ReaderLibraryStatusStore;
  const session = (cursor?: string, limit = 20) => ({
    options: { cursor, limit }, position: { dataEpoch: 'epoch', sequence: '1' },
    principal: null, displayLanguages: ['en'], checkDeadline: () => {},
    viewer: { signedIn: false, age: 'unknown', country: null,
      optIns: { general: true, r15: false, sexual: false, grotesque: false } },
    deps: { profiles: { agentFence: async () => 'agent-head',
      visibility: { read: async () => ({ visibility, version: 1 }) },
      listing: { read: async () => ({ listing: 'listed', version: 1 }) } },
      personPreferences: { profileVisible: async () => true } },
    query: async (sql: string) => {
      graphCalls++;
      if (sql.includes('SELECT ?displayName')) return [{ displayName: { value: 'Reader' },
        agentKind: { value: 'https://rezics.com/vocab/PersonAgent' }, agentHead: { value: id(900_001) } }];
      const works = [...sql.matchAll(/<https:\/\/rezics.com\/id\/[0-9a-f-]{36}>/g)].map(match => match[0].slice(1, -1));
      if (sql.includes('SELECT DISTINCT ?id')) return works.filter(work => published(Number(work.slice(-12))))
        .map(work => ({ id: { value: work } }));
      return [];
    },
    summaries: async (works: string[]) => works.map(work => visible(Number(work.slice(-12)))
      ? { status: 'available', type: 'work', name: { value: 'Book', language: 'en' }, avatar: null }
      : { status: 'unavailable' }),
  }) as unknown as WorkReadSession;
  return { store, session, measure: () => ({ graphCalls, candidates, batches }),
    change: () => { revision = '1'; }, hide: () => { visibility = 'private'; } };
}

test('Public first pages and summaries examine the same bounded neighbourhood at 1,000 and 20,000 rows', async () => {
  const measures = [];
  for (const size of [1_000, 20_000]) {
    const home = fixture(size);
    const page = await readPublicStatusShelf(home.session(), agent, home.store, 'reading');
    expect(page).toMatchObject({ statusCount: 20, statusCountKind: 'lower-bound' });
    expect(page.items).toHaveLength(20);
    expect(home.measure().candidates).toBeLessThanOrEqual(PUBLIC_SHELF_COST.candidateBatch * PUBLIC_SHELF_COST.candidateBatches);
    measures.push(home.measure());
    const summary = fixture(size);
    const shelves = await readPublicShelves(summary.session(), agent, summary.store);
    const reading = shelves.statusShelves.find(shelf => shelf.status === 'reading')!;
    expect(reading).toMatchObject({ count: 20, countKind: 'lower-bound' });
    expect(reading.nextCursor).toBeTruthy();
    const next = await readPublicStatusShelf(summary.session(reading.nextCursor!), agent, summary.store, 'reading');
    expect(next.statusCount).toBe(40);
  }
  expect(measures[0]).toEqual(measures[1]);
});

test('Hidden and nameless prefixes yield resumable empty pages and never contribute to a public total', async () => {
  const home = fixture(247, index => index === 247);
  let cursor: string | undefined;
  const works: string[] = [];
  let pages = 0;
  do {
    const before = home.measure();
    const page = await readPublicStatusShelf(home.session(cursor), agent, home.store, 'reading');
    expect(home.measure().candidates - before.candidates).toBeLessThanOrEqual(40);
    expect(home.measure().batches - before.batches).toBeLessThanOrEqual(2);
    works.push(...page.items.map(item => item.work));
    expect(page.statusCount).toBe(works.length);
    expect(page.statusCountKind).toBe(page.nextCursor ? 'lower-bound' : 'exact');
    cursor = page.nextCursor ?? undefined;
    expect(++pages).toBeLessThanOrEqual(7);
  } while (cursor);
  expect(works).toEqual([id(247)]);
  const invisible = fixture(247, () => false);
  const summary = await readPublicShelves(invisible.session(), agent, invisible.store);
  expect(summary.statusShelves.find(shelf => shelf.status === 'reading')).toMatchObject({
    count: 0, countKind: 'lower-bound', changedAt: null });
  const nameless = fixture(30, () => false, () => true);
  expect(await readPublicStatusShelf(nameless.session(), agent, nameless.store, 'reading'))
    .toMatchObject({ statusCount: 0, statusCountKind: 'exact', items: [], nextCursor: null });
});

test('Counting through all 1,000 cards preserves each identity exactly once, including the terminal boundary', async () => {
  const home = fixture(1_000);
  let cursor: string | undefined;
  const works: string[] = [];
  do {
    const page = await readPublicStatusShelf(home.session(cursor), agent, home.store, 'reading');
    works.push(...page.items.map(item => item.work));
    expect(page.statusCount).toBe(works.length);
    cursor = page.nextCursor ?? undefined;
    if (!cursor) expect(page.statusCountKind).toBe('exact');
  } while (cursor);
  expect(works).toHaveLength(1_000);
  expect(new Set(works).size).toBe(1_000);
});

test('Public continuation rejects changed membership, privacy, sort and tampered count state', async () => {
  const home = fixture(30);
  const page = await readPublicStatusShelf(home.session(), agent, home.store, 'reading');
  await expect(readPublicStatusShelf(home.session(page.nextCursor!), agent, home.store, 'reading', { sort: 'title' }))
    .rejects.toBeInstanceOf(WorkReadInvalid);
  const token = `${page.nextCursor!.startsWith('A') ? 'B' : 'A'}${page.nextCursor!.slice(1)}`;
  await expect(readPublicStatusShelf(home.session(token), agent, home.store, 'reading')).rejects.toBeInstanceOf(WorkReadInvalid);
  const differentAudience = home.session(page.nextCursor!);
  Object.assign(differentAudience, { viewer: { ...differentAudience.viewer, signedIn: true } });
  await expect(readPublicStatusShelf(differentAudience, agent, home.store, 'reading')).rejects.toBeInstanceOf(WorkReadInvalid);
  const differentGraph = home.session(page.nextCursor!);
  differentGraph.position.sequence = '2';
  await expect(readPublicStatusShelf(differentGraph, agent, home.store, 'reading')).rejects.toBeInstanceOf(WorkReadMoved);
  home.change();
  await expect(readPublicStatusShelf(home.session(page.nextCursor!), agent, home.store, 'reading')).rejects.toBeInstanceOf(WorkReadMoved);
  home.hide();
  await expect(readPublicStatusShelf(home.session(page.nextCursor!), agent, home.store, 'reading')).rejects.toThrow('unavailable');
});

test('Private pages keep unavailable placeholders without adding public count fields', async () => {
  const home = fixture(30, () => false);
  const page = await readShelfPage(home.session(), agent, home.store, 'reading', {}, '0', false);
  expect(page.items).toHaveLength(STATUS_SHELF_COST.pageSize);
  expect(page.items.every(item => item.card === null)).toBe(true);
  expect(page).not.toHaveProperty('statusCount');
});

test('A concurrent status change during hydration discards the whole public response', async () => {
  const home = fixture(30), session = home.session();
  const summaries = session.summaries.bind(session);
  session.summaries = async (...args) => {
    const result = await summaries(...args);
    home.change();
    return result;
  };
  await expect(readPublicStatusShelf(session, agent, home.store, 'reading')).rejects.toBeInstanceOf(WorkReadMoved);
});
