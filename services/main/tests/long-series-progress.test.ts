import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { StructureProgressStore, InvalidStructureProgress } from '../src/modules/progress/store.ts';
import { createHash, randomUUID } from 'node:crypto';
import { ObjectUnavailable, type ImmutableObjects } from '../src/infrastructure/immutable-objects.ts';
import { chooserPosition } from '../src/modules/reading-position/chooser-position.ts';
import { ReadingPositionTraversal } from '../src/modules/reading-position/traversal.ts';
import { orderTree, recordTree } from '../src/modules/structure/change.ts';
import { COMPOSITION_PROFILE, orderTreeKey } from '../src/modules/structure/graph.ts';
import { STRUCTURE_MANIFEST_FORMAT, STRUCTURE_PAGE_FORMAT, type OccurrenceRecord } from '../src/modules/structure/format.ts';
import { newCost } from '../src/modules/structure/tree.ts';
import { WorkReadMissing, WorkReadUnavailable, type ReadRow, type WorkReadSession } from '../src/modules/work/read-session.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
const binding = (value: string) => ({ value,
  type: value.startsWith('https://') || value.startsWith('urn:') ? 'uri' : 'literal' });

async function fixture(grouped = false, reverseNumbers = false) {
  const work = id(), structure = id(), revision = id(), generation = id(), specials = id(), main = id();
  const stored = new Map<string, Uint8Array>();
  let objectsRead = 0, rowsRead = 0, calls = 0;
  const objects: ImmutableObjects = {
    put: async body => {
      const digest = createHash('sha256').update(body).digest('hex');
      stored.set(digest, body); return digest;
    },
    get: async digest => {
      objectsRead++;
      const body = stored.get(digest);
      if (!body) throw new ObjectUnavailable('missing order object');
      return body;
    },
  };
  const episodes: OccurrenceRecord[] = Array.from({ length: 1000 }, (_, index) => ({
    occurrence: id(), state: 'active', parent: grouped ? main : structure, segmentKey: 'a',
    orderKey: (index + 1).toString(36).padStart(4, '0'), role: 'part', target: id(),
    selection: { mode: 'follow-context' }, introducedBy: revision,
    labels: [], qualifier: { type: 'work-part', displayLabel: `Episode ${index + 1}`, inclusion: 'required' },
  }));
  const group: OccurrenceRecord = { occurrence: specials, state: 'active', parent: structure,
    segmentKey: 'b', orderKey: 'a', role: 'group', introducedBy: revision,
    labels: [{ value: 'Specials', language: 'en' }] };
  const special: OccurrenceRecord = { ...episodes[0]!, occurrence: id(), parent: specials, target: id(),
    segmentKey: 'a', orderKey: 'a', qualifier: { type: 'work-part', displayLabel: 'Special', inclusion: 'extra' } };
  const mainGroup: OccurrenceRecord = { ...group, occurrence: main, segmentKey: 'a', labels: [{ value: 'Main', language: 'en' }] };
  const records = [...episodes, ...(grouped ? [mainGroup] : []), group, special];
  const numbers = new Map(episodes.map((record, index) => [record.target!, String(reverseNumbers ? 1000 - index : index + 1)]));
  const cost = newCost();
  const entries = records.map(record => ({ parent: record.parent, segmentKey: record.segmentKey!,
    orderKey: record.orderKey!, occurrence: record.occurrence }));
  const manifest = { format: STRUCTURE_MANIFEST_FORMAT, structure, structureOf: id(),
    profile: 'work-composition' as const, generation, pageFormat: STRUCTURE_PAGE_FORMAT,
    records: await recordTree(objects).apply(await recordTree(objects).empty(cost),
      new Map(records.map(record => [record.occurrence, record])), cost),
    order: await orderTree(objects).apply(await orderTree(objects).empty(cost),
      new Map(entries.map(entry => [orderTreeKey(entry), entry])), cost),
    placementCount: records.length, measures: [], model: COMPOSITION_PROFILE, shape: COMPOSITION_PROFILE };
  const digest = await objects.put(new TextEncoder().encode(JSON.stringify(manifest)));
  objectsRead = 0;
  const completed: string[] = [], hidden = new Set<string>();
  let finished = false, ambiguous = false, historyPages = 0;
  const principal = { issuer: 'https://reader.test', subject: 'viewer', emailVerified: true };
  const session = {
    deps: { structureObjects: objects, readingPositions: {
      completedPage: async (_principal: unknown, selected: string[], after?: string) => {
        expect(selected).toEqual([structure]); historyPages++;
        const offset = after ? Number(after) : 0;
        return { items: completed.slice(offset, offset + 50), next: completed.length > offset + 50 ? String(offset + 50) : null };
      },
      finishedWorks: async () => new Set(finished ? [work] : []),
    } },
    principal, options: { actingSubject: id() }, checkDeadline: () => {},
    query: async (query: string) => {
      calls++;
      expect(query).not.toContain('OFFSET');
      // Numeric terminal-part seeks never traverse all PartRole navigation
      // entries in the text index, including on an untitled Episode.
      expect(query).not.toContain('reading-position:label-index');
      let rows: ReadRow[];
      if (query.includes('# reading-position:work\n')) {
        const resource = query.match(/BIND\(<([^>]+)> AS \?work\)/)![1]!;
        if (resource === work) rows = [{ work: binding(work), structure: binding(structure),
          revision: binding(revision), generation: binding(generation) }];
        else {
          // Episodes lack rv:mainVersion. A mandatory Work binding cannot
          // return their metadata; an optional composition returns a leaf.
          expect(query).toMatch(/OPTIONAL \{ <[^>]+> rv:mainVersion/);
          rows = ambiguous ? [{ work: binding(resource) }, { work: binding(resource) }] : [{ work: binding(resource) }];
        }
      } else if (query.includes('# reading-position:works')) {
        expect(query).toContain('rv:composedWork');
        rows = [{ work: binding(work), structure: binding(structure), revision: binding(revision), generation: binding(generation) }];
      } else if (query.includes('# reading-position:accepted-number')) {
        const parent = query.match(/rv:parent <([^>]+)>/)! [1]!;
        const number = query.match(/VALUES \?number \{ \"([^\"]+)\"/)! [1]!;
        const after = query.match(/FILTER\(\?segmentKey > \"([^\"]+)\" \|\| \(\?segmentKey = \"[^\"]+\"\s+&& \?orderKey > \"([^\"]+)\"/);
        const limit = Number(query.match(/LIMIT (\d+)$/)! [1]!);
        rows = records.filter(record => record.parent === parent && (record.role === 'group' || numbers.get(record.target!) === number)
          && (!after || record.segmentKey! > after[1]! || record.segmentKey === after[1] && record.orderKey! > after[2]!))
          .sort((a, b) => orderTreeKey(a).localeCompare(orderTreeKey(b))).slice(0, limit).map(record => ({
            occurrence: binding(record.occurrence), parent: binding(parent), segmentKey: binding(record.segmentKey!),
            orderKey: binding(record.orderKey!), matches: binding(String(record.role !== 'group' && numbers.get(record.target!) === number)),
          }));
      } else if (query.includes('# reading-position:manifest')) rows = [{ manifest: binding(`urn:rezics:sha256:${digest}`) }];
      else {
        expect(query).toMatch(/# reading-position:(records|hydrate)/);
        const wanted = query.match(/VALUES [^{]+\{([^}]+)}/)![1]!;
        rows = records.filter(record => wanted.includes(record.occurrence)).map(record => ({
          work: binding(work), structure: binding(structure), revision: binding(revision),
          occurrence: binding(record.occurrence), parent: binding(record.parent), segmentKey: binding(record.segmentKey!),
          orderKey: binding(record.orderKey!), role: binding(`https://rezics.com/vocab/${record.role === 'part' ? 'PartRole' : 'GroupRole'}`),
          ...(record.target ? { target: binding(record.target) } : {}),
          ...(record.qualifier?.type === 'work-part' ? { displayLabel: binding(record.qualifier.displayLabel) } : {}),
        }));
      }
      rowsRead += rows.length; return rows;
    },
  } as unknown as WorkReadSession;
  const traversal = () => new ReadingPositionTraversal(session, work, async resources => new Set(resources.filter(resource => !hidden.has(resource))));
  return { work, main, episodes, special, session, completed, hidden, traversal,
    finish: () => { finished = true; }, ambiguous: () => { ambiguous = true; },
    measure: () => ({ objectsRead, rowsRead, calls, historyPages }) };
}

test('a numeric seek to accepted Episode 1000 reads counted paths and the exact terminal occurrence', async () => {
  const f = await fixture();
  const page = await f.traversal().page({ limit: 1, q: '１０００' });
  expect(page.items).toMatchObject([{ occurrence: f.episodes[999]!.occurrence, ordinal: 1000, role: 'part' }]);
  expect(page.complete).toBe(true); expect(page.next).toBeNull();
  expect(f.measure().objectsRead).toBeLessThanOrEqual(16);
  expect(f.measure().rowsRead).toBeLessThanOrEqual(12);
  expect(f.measure().calls).toBeLessThanOrEqual(12);
  expect((await f.traversal().page({ limit: 1, q: '1000', after: f.episodes[999]!.occurrence })).items).toEqual([]);
});

test('Episode parts page and finish without a Work main version, and specials keep their own sibling ordinal', async () => {
  const f = await fixture();
  const first = await f.traversal().page({ limit: 1 });
  expect(first.items[0]!.occurrence).toBe(f.episodes[0]!.occurrence);
  expect(first.next).toBe(f.episodes[0]!.occurrence);
  const special = await f.traversal().page({ limit: 1, after: f.episodes[999]!.occurrence });
  expect(special.items).toMatchObject([{ occurrence: f.special.occurrence, parent: f.special.parent, ordinal: 1 }]);
  const last = await f.traversal().last(f.work);
  expect(last?.item.occurrence).toBe(f.special.occurrence);
});

test('missing accepted numbers do not walk terminal Episode navigation entries', async () => {
  const f = await fixture();
  for (const q of ['0', '1001', '1002', '1000000000000']) {
    const before = f.measure();
    const page = await f.traversal().page({ limit: 1, q });
    expect(page).toMatchObject({ items: [], complete: true, next: null });
    expect(f.measure().calls - before.calls).toBeLessThanOrEqual(12);
    expect(f.measure().rowsRead - before.rowsRead).toBeLessThanOrEqual(12);
    expect(f.measure().objectsRead - before.objectsRead).toBeLessThanOrEqual(16);
  }
});

test('Mine chooses furthest current completion after out-of-order ticks and another device sees the same occurrence', async () => {
  const f = await fixture();
  f.completed.push(f.episodes[999]!.occurrence, ...f.episodes.slice(0, 999).reverse().map(record => record.occurrence), id());
  for (let device = 0; device < 2; device++) {
    expect(await chooserPosition(f.session, f.traversal(), 'mine', true)).toBe(f.episodes[999]!.occurrence);
  }
  expect(f.measure().historyPages).toBe(42);
  expect(f.measure().rowsRead).toBeLessThan(2010);
  expect(f.measure().calls).toBeLessThanOrEqual(48);
  expect(f.measure().objectsRead).toBe(0);
  f.completed.splice(0);
  expect(await chooserPosition(f.session, f.traversal(), 'mine', true)).toBe('start');
  f.finish();
  expect(await chooserPosition(f.session, f.traversal(), 'mine', true)).toBe(f.special.occurrence);
});

test('hidden completed targets and ambiguous terminal metadata fail closed', async () => {
  const f = await fixture();
  f.completed.push(f.episodes[999]!.occurrence);
  f.hidden.add(f.episodes[999]!.target!);
  expect((await f.traversal().page({ limit: 1, q: '1000' })).items).toEqual([]);
  await expect(chooserPosition(f.session, f.traversal(), 'mine', true)).rejects.toBeInstanceOf(WorkReadMissing);
  expect(await chooserPosition(f.session, f.traversal(), 'mine', false)).toBe('start');
  f.hidden.clear(); f.ambiguous();
  await expect(f.traversal().metadataFor(f.episodes[999]!.target!)).rejects.toBeInstanceOf(WorkReadUnavailable);
});

test('completed progress pages keep sparse continuation and selection-qualified primary-key order', async () => {
  const structure = id(), occurrence = id(), later = id();
  const revision = `urn:rezics:content:revision:${randomUUID()}`;
  const principal = { issuer: 'https://reader.test', subject: 'reader' };
  const rows = [
    { occurrence, selection_key: '', completed: false, position: 'episode:1', version: '2' },
    { occurrence, selection_key: revision, completed: true, position: null, version: '3' },
    { occurrence: later, selection_key: '', completed: true, position: null, version: '1' },
  ];
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const pool = { query: async (sql: string, values: unknown[]) => {
    calls.push({ sql, values });
    return { rows: calls.length === 1 ? rows.slice(0, 2) : rows.slice(1, 3) };
  } } as unknown as Pool;
  const store = new StructureProgressStore(pool);
  const first = await store.completedPage(principal, structure, 1);
  expect(first).toEqual({ items: [], next: { occurrence, selectedRevision: null } });
  expect(calls[0]!.values).toEqual([principal.issuer, principal.subject, structure, 2]);
  expect(calls[0]!.sql).not.toContain('AND completed');
  expect(calls[0]!.sql).toContain('ORDER BY occurrence, selection_key LIMIT $4');
  const second = await store.completedPage(principal, structure, 1, first.next!);
  expect(second).toEqual({ items: [{ structure, occurrence, selectedRevision: revision,
    completed: true, position: null, version: 3 }], next: { occurrence, selectedRevision: revision } });
  expect(calls[1]!.sql).toContain('(occurrence, selection_key) > ($4, $5)');
  expect(calls[1]!.values).toEqual([principal.issuer, principal.subject, structure, occurrence, '', 2]);
});

test('completed progress rejects invalid page keys and limits without touching owner storage', async () => {
  let calls = 0;
  const store = new StructureProgressStore({ query: async () => { calls++; return { rows: [] }; } } as unknown as Pool);
  const principal = { issuer: 'https://reader.test', subject: 'reader' }, structure = id();
  for (const limit of [0, 51, 1.5, Number.NaN]) {
    await expect(store.completedPage(principal, structure, limit)).rejects.toBeInstanceOf(InvalidStructureProgress);
  }
  await expect(store.completedPage(principal, 'invalid')).rejects.toBeInstanceOf(InvalidStructureProgress);
  await expect(store.completedPage(principal, structure, 50, { occurrence: id(), selectedRevision: 'invalid' }))
    .rejects.toBeInstanceOf(InvalidStructureProgress);
  expect(calls).toBe(0);
  expect(await store.completedPage(principal, structure)).toEqual({ items: [], next: null });
  expect(calls).toBe(1);
});

test('numeric seeks descend a thousand terminal Episode parts in a group using accepted values, not position', async () => {
  const f = await fixture(true, true);
  for (const [number, index, ordinal] of [['1', 999, 1000], ['1000', 0, 1]] as const) {
    const before = f.measure();
    const page = await f.traversal().page({ limit: 1, q: number });
    expect(page.items).toMatchObject([{ occurrence: f.episodes[index]!.occurrence,
      parent: f.main, ordinal, target: f.episodes[index]!.target }]);
    expect(page.items).toHaveLength(1);
    expect(page.complete).toBe(true);
    expect(f.measure().calls - before.calls).toBeLessThan(15);
    expect(f.measure().rowsRead - before.rowsRead).toBeLessThan(15);
    expect(f.measure().objectsRead - before.objectsRead).toBeLessThan(20);
    expect((await f.traversal().page({ limit: 1, q: number, after: f.episodes[index]!.occurrence })).items).toEqual([]);
  }
  expect(await f.traversal().page({ limit: 1, q: '1002' })).toMatchObject({ items: [], complete: true });
  f.hidden.add(f.episodes[0]!.target!);
  expect(await f.traversal().page({ limit: 1, q: '1000' })).toMatchObject({ items: [], complete: true });
});
