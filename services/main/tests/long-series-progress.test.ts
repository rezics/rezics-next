import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { StructureProgressStore, InvalidStructureProgress, ProgressOrderUnavailable, STRUCTURE_PROGRESS_COST, type StructureProgress } from '../src/modules/progress/store.ts';
import { createHash, randomUUID } from 'node:crypto';
import { ObjectUnavailable, type ImmutableObjects } from '../src/infrastructure/immutable-objects.ts';
import { chooserPosition } from '../src/modules/reading-position/chooser-position.ts';
import { ReadingPositionTraversal } from '../src/modules/reading-position/traversal.ts';
import { orderTree, recordTree } from '../src/modules/structure/change.ts';
import { COMPOSITION_PROFILE, orderTreeKey, type CompositionHeader } from '../src/modules/structure/graph.ts';
import { STRUCTURE_MANIFEST_FORMAT, STRUCTURE_PAGE_FORMAT, type OccurrenceRecord } from '../src/modules/structure/format.ts';
import { newCost } from '../src/modules/structure/tree.ts';
import { WorkReadUnavailable, type ReadRow, type WorkReadSession } from '../src/modules/work/read-session.ts';

import { ReadingSeekUnavailable, ReadingResumeUnavailable, ReadingResumeContinuation, ReadingContinuityUnsupported } from '../src/modules/reading-position/errors.ts';
import { continuityAnchors } from '../src/modules/reading-position/continuity.ts';
import { disclosedCompletedProgress } from '../src/modules/progress/disclosure.ts';
import { ReadingPositionStore } from '../src/modules/reading-position/store.ts';
import { ProgressOrderProjection } from '../src/modules/progress/order-projection.ts';
import { ReadingBoundary } from '../src/modules/reading-position/boundary.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
const binding = (value: string) => ({ value,
  type: value.startsWith('https://') || value.startsWith('urn:') ? 'uri' : 'literal' });

async function fixture(grouped = false, _reverseNumbers = false, singletons = false, book = false, mutate?: (records: OccurrenceRecord[]) => void) {
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
  const parents = Array.from({ length: 1000 }, id);
  const episodes: OccurrenceRecord[] = Array.from({ length: 1000 }, (_, index) => ({
    occurrence: id(), state: 'active', parent: singletons ? parents[index]! : grouped ? main : structure, segmentKey: 'a',
    orderKey: (index + 1).toString(36).padStart(4, '0'), role: book ? 'chapter' : 'part', target: id(),
    ...(book ? { selection: { mode: 'follow-context' as const } } : {}), introducedBy: revision,
    labels: [], ...(book ? {} : { qualifier: { type: 'work-part' as const, displayLabel: `Episode ${index + 1}`, inclusion: 'required' as const } }),
  }));
  const group: OccurrenceRecord = { occurrence: specials, state: 'active', parent: structure,
    segmentKey: 'b', orderKey: 'a', role: 'group', introducedBy: revision,
    labels: [{ value: 'Specials', language: 'en' }] };
  const special: OccurrenceRecord = { ...episodes[0]!, occurrence: id(), parent: specials, target: id(),
    segmentKey: 'a', orderKey: 'a', qualifier: { type: 'work-part', displayLabel: 'Special', inclusion: 'extra' } };
  const mainGroup: OccurrenceRecord = { ...group, occurrence: main, segmentKey: 'a', labels: [{ value: 'Main', language: 'en' }] };
  if (book) delete special.qualifier;
  const singletonGroups: OccurrenceRecord[] = singletons ? parents.map((parent, index) => ({ ...mainGroup, occurrence: parent, orderKey: (index + 1).toString(36).padStart(4, '0') })) : [];
  const records = [...episodes, ...(grouped ? [mainGroup] : []), ...singletonGroups, group, special];
  mutate?.(records);
  const cost = newCost();
  const entries = records.map(record => ({ parent: record.parent, segmentKey: record.segmentKey!,
    orderKey: record.orderKey!, occurrence: record.occurrence }));
  const manifest = { format: STRUCTURE_MANIFEST_FORMAT, structure, structureOf: id(),
    profile: book ? 'book-composition' as const : 'work-composition' as const, generation, pageFormat: STRUCTURE_PAGE_FORMAT,
    records: await recordTree(objects).apply(await recordTree(objects).empty(cost),
      new Map(records.map(record => [record.occurrence, record])), cost),
    order: await orderTree(objects).apply(await orderTree(objects).empty(cost),
      new Map(entries.map(entry => [orderTreeKey(entry), entry])), cost),
    placementCount: records.length, measures: [], model: COMPOSITION_PROFILE, shape: COMPOSITION_PROFILE };
  const digest = await objects.put(new TextEncoder().encode(JSON.stringify(manifest)));
  objectsRead = 0;
  const completed: string[] = [], hidden = new Set<string>(), published = new Set<string>();
  const header: CompositionHeader = { structure, profile: manifest.profile, owner: work, component: manifest.structureOf,
    mainVersion: manifest.structureOf, work, head: revision, generation, placementCount: records.length, manifest: `urn:rezics:sha256:${digest}` };
  const env = { structureObjects: objects, fuseki: { query: async (q: string) => ({ results: { bindings: q.includes('SELECT ?component') ? [{ component: binding(header.component), profile: binding(`https://rezics.com/vocab/${book ? 'BookComposition' : 'WorkComposition'}`), head: binding(revision), generation: binding(generation), count: binding(String(records.length)), manifest: binding(header.manifest) }] : [{ owner: binding(work) }] } }) } };
  let ambiguous = false, historyPages = 0, indexRows = 0, indexReads = 0;
  const key = (record: OccurrenceRecord) => (record.parent === structure ? '' : `${record.parent === specials ? 'b' : 'a'}\u0002${singletons ? parents.indexOf(record.parent).toString(36).padStart(4, '0') : 'a'}\u0001`) + `${record.segmentKey}\u0002${record.orderKey}`;
  const principal = { issuer: 'https://reader.test', subject: 'viewer', emailVerified: true };
  const session = {
    deps: { environment: env, structureObjects: objects, progress: {
      resumeCandidates: async (_principal: unknown, _structure: string, _revision: string, after?: { occurrence: string }) => {
        indexReads++;
        const ordered = records.filter(record => completed.includes(record.occurrence) && record !== special)
          .sort((a, b) => key(a) < key(b) ? 1 : -1);
        const offset = after ? ordered.findIndex(row => row.occurrence === after.occurrence) + 1 : 0;
        const selected = ordered.slice(offset, offset + STRUCTURE_PROGRESS_COST.resumeCandidates + 1);
        const last = selected[Math.min(selected.length, STRUCTURE_PROGRESS_COST.resumeCandidates) - 1];
        indexRows += selected.length;
        return { items: selected.slice(0, STRUCTURE_PROGRESS_COST.resumeCandidates).map(record => ({ structure,
          occurrence: record.occurrence, selectedRevision: null, completed: true, position: null, version: 1 })),
          more: selected.length > STRUCTURE_PROGRESS_COST.resumeCandidates,
          next: selected.length > STRUCTURE_PROGRESS_COST.resumeCandidates && last ? { occurrence: last.occurrence, selectedRevision: null } : null };
      },
    }, readingPositions: {
      completedPage: async () => { historyPages++; throw new Error('Resume must never page history'); },
      finishedWorks: async () => { throw new Error('Resume must never scan Library history'); },
    } },
    principal, options: { actingSubject: id() }, checkDeadline: () => {},
    query: async (query: string) => {
      calls++;
      expect(query).not.toContain('OFFSET');
      expect(query).not.toContain('rv:composedWork');
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
      } else if (query.includes('# reading-position:nested-composition')) rows = [];
      else if (query.includes('# progress:published-selections')) {
        rows = [...published].filter(value => value.split('\0').every(part => query.includes(part)))
          .map(value => { const [target, pin] = value.split('\0'); return { target: binding(target!), revision: binding(pin!) }; });
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
  return { work, main, structure, revision, header, objects, records, episodes, special, session, completed, hidden, published, traversal,
    disclose: (reader: WorkReadSession, selected: CompositionHeader, rows: readonly StructureProgress[]) => disclosedCompletedProgress(reader, selected, rows, async (_session, _profile, targets) => new Set(targets.filter(target => !hidden.has(target)))),
    ambiguous: () => { ambiguous = true; },
    measure: () => ({ objectsRead, rowsRead, calls, historyPages, indexRows, indexReads }) };
}

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


test('1000 singleton groups cannot emulate an accepted-number seek without the kernel index', async () => {
  const f = await fixture(false, false, true);
  for (const q of ['1', '1000']) {
    const before = f.measure();
    await expect(f.traversal().page({ limit: 1, q })).rejects.toBeInstanceOf(ReadingSeekUnavailable);
    expect(f.measure().calls - before.calls).toBe(2);
    expect(f.measure().rowsRead - before.rowsRead).toBe(2);
    expect(f.measure().objectsRead - before.objectsRead).toBe(1);
  }
});

test('Mine over 1000 completions uses one fixed owner index window and never pages history', async () => {
  const f = await fixture(true);
  f.completed.push(f.episodes[999]!.occurrence, ...f.episodes.slice(0, 999).reverse().map(row => row.occurrence));
  expect(await chooserPosition(f.session, f.traversal(), 'mine', true, f.disclose)).toBe(f.episodes[999]!.occurrence);
  expect(f.measure().historyPages).toBe(0);
  expect(f.measure().indexReads).toBe(1);
  expect(f.measure().indexRows).toBe(17);
  expect(f.measure().calls).toBeLessThan(8);
});

test('hidden furthest completion falls back within 16 candidates and continues beyond them', async () => {
  const f = await fixture(true);
  f.completed.push(f.episodes[0]!.occurrence, f.episodes[999]!.occurrence);
  f.hidden.add(f.episodes[999]!.target!);
  expect(await chooserPosition(f.session, f.traversal(), 'mine', true, f.disclose)).toBe(f.episodes[0]!.occurrence);
  f.completed.push(...f.episodes.slice(983, 999).map(row => row.occurrence));
  for (const row of f.episodes.slice(983)) f.hidden.add(row.target!);
  let next: ReadingResumeContinuation | undefined;
  try { await chooserPosition(f.session, f.traversal(), 'mine', true, f.disclose); }
  catch (error) { expect(error).toBeInstanceOf(ReadingResumeContinuation); next = error as ReadingResumeContinuation; }
  expect(next).toBeDefined();
  expect(await chooserPosition(f.session, f.traversal(), 'mine', true, f.disclose, next!.after))
    .toBe(f.episodes[0]!.occurrence);
  expect(await chooserPosition(f.session, f.traversal(), 'mine', false, f.disclose)).toBe('start');
});

test('search plus Mine resumes its pending window before advancing search pages', async () => {
  const f = await fixture();
  const key = { occurrence: f.episodes[983]!.occurrence, selectedRevision: null };
  const windows: Array<typeof key | undefined> = [];
  f.session.deps.progress!.resumeCandidates = async (_principal, _structure, _revision, after) => {
    windows.push(after as typeof key | undefined);
    if (!after) throw new ReadingResumeContinuation(key);
    return { items: [], more: false, next: null };
  };
  Object.assign(f.session.deps, { access: { canReadAsBaselineMember: async () => true } });
  const boundary = new ReadingBoundary(f.session, 'mine'), traversal = f.traversal();
  boundary.traversalFor = () => traversal;
  const browse = traversal.page.bind(traversal);
  const searches: Array<string | undefined> = [];
  // These fixture rows all match "Episode"; the native test exercises the
  // real title index. Here the existing range verifies checkpoint advancement.
  traversal.page = input => { searches.push(input.q); return browse({ ...input, q: undefined }); };
  const pending = await boundary.chooser(f.work, 1, undefined, 'Episode');
  expect(pending).toMatchObject({ resolved: 'pending', items: [], complete: false,
    scope: 'positions', visibility: 'pending' });
  expect(pending.next).toBeString(); expect(searches).toEqual([]);
  const first = await boundary.chooser(f.work, 1, pending.next!, 'Episode');
  expect(first.items.map(row => row.occurrence)).toEqual([f.episodes[0]!.occurrence]);
  expect(first.next).toBeString();
  const second = await boundary.chooser(f.work, 1, first.next!, 'Episode');
  expect(second.items.map(row => row.occurrence)).toEqual([f.episodes[1]!.occurrence]);
  expect(searches).toEqual(['Episode', 'Episode']);
  expect(windows).toEqual([undefined, key, key]);
  expect(first.items.every(row => !Object.hasOwn(row, 'ordinal'))).toBe(true);
  expect(second.items.every(row => !Object.hasOwn(row, 'ordinal'))).toBe(true);
});

test('owner Mine omits ordinals while a public page of the same order keeps them', async () => {
  const f = await fixture();
  Object.assign(f.session.deps, { access: { canReadAsBaselineMember: async () => true } });
  const traversal = f.traversal();
  const mine = new ReadingBoundary(f.session, 'mine');
  mine.traversalFor = () => traversal;
  const privatePage = await mine.chooser(f.work, 1);
  expect(privatePage.items.map(row => row.occurrence)).toEqual([f.episodes[0]!.occurrence]);
  expect(privatePage.items.every(row => !Object.hasOwn(row, 'ordinal'))).toBe(true);
  const opened = new ReadingBoundary(f.session, 'start');
  opened.traversalFor = () => traversal;
  const publicPage = await opened.chooser(f.work, 1);
  const openedItem = publicPage.items[0]!;
  expect('ordinal' in openedItem && openedItem.ordinal).toBe(1);
});

test('a filled page reads its withheld lookahead in one scan window', async () => {
  const f = await fixture();
  for (const row of f.episodes.slice(1, 40)) f.hidden.add(row.target!);
  const before = f.measure();
  const page = await f.traversal().page({ limit: 1 });
  expect(page.items.map(row => row.occurrence)).toEqual([f.episodes[0]!.occurrence]);
  expect(page.complete).toBe(false);
  expect(page.next).toBeString();
  // The first probe is the item plus one hidden lookahead. The rest of the
  // scan window is one widened read, not a disclosure per hidden sibling.
  expect(f.measure().calls - before.calls).toBeLessThan(8);
  expect(f.measure().rowsRead - before.rowsRead).toBeLessThan(40);
  const next = await f.traversal().page({ limit: 1, after: page.next! });
  expect(next.items.every(row => row.occurrence !== f.episodes[0]!.occurrence)).toBe(true);
});

test('a visible last sibling never returns a physical ordinal over 999 hidden items', async () => {
  const f = await fixture();
  for (const row of f.episodes.slice(0, 999)) f.hidden.add(row.target!);
  let after: string | undefined, found = false;
  for (let index = 0; index < 40; index++) {
    const before = f.measure();
    const page = await f.traversal().page({ limit: 1, after });
    expect(f.measure().rowsRead - before.rowsRead).toBeLessThan(40);
    expect(f.measure().calls - before.calls).toBeLessThan(10);
    expect(page.items.every(row => !Object.hasOwn(row, 'ordinal'))).toBe(true);
    if (page.items.some(row => row.occurrence === f.episodes[999]!.occurrence)) { found = true; break; }
    expect(page).toMatchObject({ items: [], visibility: 'pending', complete: false });
    expect(page.next).not.toBeNull();
    after = page.next!;
  }
  expect(found).toBe(true);
});

test('completed collection filters hidden IDs, pins, positions and missing keys before counting', async () => {
  const f = await fixture();
  const rows: StructureProgress[] = f.episodes.slice(0, 50).map(record => ({ structure: f.structure,
    occurrence: record.occurrence, selectedRevision: null, completed: true, position: 'private saved position', version: 1 }));
  expect(await f.disclose(f.session, f.header, rows)).toHaveLength(50);
  f.hidden.add(f.episodes[0]!.target!);
  const hidden = rows[0]!;
  const selected = { ...hidden, selectedRevision: `urn:rezics:content:revision:${randomUUID()}` };
  const missing = { ...hidden, occurrence: id() };
  expect(await f.disclose(f.session, f.header, [hidden, selected, missing, rows[1]!])).toEqual([rows[1]!]);
});

test('same-target fixed pins require their own policy and current public revision; withdrawal hides the row', async () => {
  const first = `urn:rezics:content:revision:${randomUUID()}`, second = `urn:rezics:content:revision:${randomUUID()}`;
  const f = await fixture(false, false, false, true, records => {
    records[0]!.selection = { mode: 'fixed-revision', revision: first };
    records[1]!.target = records[0]!.target;
    records[1]!.selection = { mode: 'fixed-revision', revision: second };
    records[2]!.target = records[0]!.target;
  });
  const rows = f.episodes.slice(0, 3).map(record => ({ structure: f.structure, occurrence: record.occurrence,
    selectedRevision: first, completed: true, position: 'private pinned position', version: 1 }));
  f.published.add(`${f.episodes[0]!.target}\0${first}`);
  expect(await f.disclose(f.session, f.header, rows)).toEqual([rows[0]!, rows[2]!]);
  f.published.clear();
  expect(await f.disclose(f.session, f.header, rows)).toEqual([]);
});

test('owner resume seek is a partial-index top range and readiness refuses stale or legacy keys', async () => {
  const principal = { issuer: 'https://reader.test', subject: 'viewer' }, structure = id(), revision = id();
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  let stale = false;
  const pool = { query: async (sql: string, params: unknown[]) => {
    calls.push({ sql, params });
    if (sql.includes('FROM structure.progress_scope')) return { rows: [{ ready: true, order_revision: stale ? id() : revision }] };
    return { rows: Array.from({ length: sql.includes('LIMIT 1') ? 1 : 17 }, () => ({ occurrence: id(), selection_key: '', completed: true, position: null, version: '1' })) };
  } } as unknown as Pool;
  const store = new StructureProgressStore(pool);
  const page = await store.resumeCandidates(principal, structure, revision);
  expect(page.items).toHaveLength(16); expect(page.more).toBe(true);
  expect(calls[1]!.sql).toContain('ORDER BY order_key DESC, occurrence DESC, selection_key ASC LIMIT $5');
  expect(calls[1]!.sql).toContain('completed AND resume_eligible AND order_key IS NOT NULL');
  expect(calls[1]!.params).toEqual([principal.issuer, principal.subject, structure, revision, 17]);
  stale = true;
  await expect(store.resumeCandidates(principal, structure, revision)).rejects.toBeInstanceOf(ProgressOrderUnavailable);
  expect(calls.at(-1)!.sql).toContain('LIMIT 1');
});

test('reader fence is one version row, never a hash or aggregate of progress/session/library history', async () => {
  let calls = 0;
  const pool = { query: async (sql: string) => {
    calls++; expect(sql).toContain('structure.progress_reader');
    expect(sql).not.toMatch(/string_agg|md5|consumption_session|library_status/);
    return { rows: [{ version: '12345678901234567890' }] };
  } } as unknown as Pool;
  const principal = { issuer: 'https://reader.test', subject: 'viewer' };
  expect(await new ReadingPositionStore(pool).privateSnapshot(principal, id())).toBe('12345678901234567890');
  expect(await new StructureProgressStore(pool).readerVersion(principal)).toBe('12345678901234567890');
  expect(calls).toBe(2);
});

test('missing progress owner reports resume unavailable without consulting history sources', async () => {
  const f = await fixture();
  f.session.deps.progress = undefined;
  await expect(chooserPosition(f.session, f.traversal(), 'mine', true, f.disclose)).rejects.toBeInstanceOf(ReadingResumeUnavailable);
  expect(f.measure().historyPages).toBe(0);
  const omitted = await fixture();
  delete omitted.session.deps.progress;
  await expect(chooserPosition(omitted.session, omitted.traversal(), 'mine', true, omitted.disclose))
    .rejects.toBeInstanceOf(ReadingResumeUnavailable);
  expect(omitted.measure().historyPages).toBe(0);
});

test('order maintenance skips occurrence inventories by owner prefix and repairs only two rows per step', async () => {
  const f = await fixture();
  const native = f.session.deps.environment.fuseki.query.bind(f.session.deps.environment.fuseki);
  f.session.deps.environment.fuseki.query = async (q, options) => q.includes('ASK') ? { boolean: true } : native(q, options);
  Object.assign(f.session.deps.environment, { lineage: { dataEpoch: 'test', routingEpoch: 'test' } });
  const rows = f.episodes.slice(0, 3).map(row => ({ occurrence: row.occurrence, selection_key: '', completed: true }))
    .sort((a, b) => a.occurrence.localeCompare(b.occurrence));
  const writes: string[] = [];
  let state = { ready: false, order_revision: f.revision, invalidations: '0',
    reindex_cursor: null as { occurrence?: string; selection?: string } | null, reindex_invalidations: null as string | null };
  const client = { release: () => {}, query: async (sql: string, params: unknown[] = []) => {
    if (sql.startsWith('SELECT order_revision')) return { rows: [state] };
    if (sql.startsWith('SELECT occurrence,selection_key')) {
      expect(sql).toContain('LIMIT 3');
      expect(sql).not.toContain('AND completed');
      expect(sql).not.toContain('resume_eligible');
      return { rows: rows.filter(row => !params[3] || row.occurrence > String(params[3])).slice(0, 3) };
    }
    if (sql.includes("reindex_cursor='{}'")) state = { ...state, reindex_cursor: {}, reindex_invalidations: state.invalidations };
    if (sql.startsWith('UPDATE structure.progress SET')) writes.push(String(params[3]));
    if (sql.includes('ready=(NOT $4)')) state = { ...state, ready: !params[3],
      reindex_cursor: params[3] ? JSON.parse(String(params[4])) : null };
    return { rows: [] };
  } };
  const pool = { connect: async () => client, query: async (sql: string) => {
    expect(sql).toContain('ORDER BY principal_issuer,principal_subject,structure,occurrence,selection_key LIMIT 1');
    expect(sql).not.toMatch(/DISTINCT|GROUP BY/);
    return { rows: [{ principal_issuer: 'https://reader.test', principal_subject: 'viewer', structure: f.structure }] };
  } } as unknown as Pool;
  const projection = new ProgressOrderProjection(pool, f.session.deps.environment);
  await projection.step();
  expect(writes).toHaveLength(2); expect(state.ready).toBe(false);
  await projection.step();
  expect(writes).toHaveLength(3); expect(state.ready).toBe(true);
});

test('ambiguous terminal metadata fails closed and cannot masquerade as an admitted Work', async () => {
  const f = await fixture();
  f.ambiguous();
  await expect(f.traversal().metadataFor(f.episodes[0]!.target!)).rejects.toBeInstanceOf(WorkReadUnavailable);
});

async function volumeSeries() {
  const series = id(), volume1 = id(), volume2 = id(), seriesStructure = id(), book1 = id(), book2 = id();
  const seriesRevision = id(), bookRevision = id(), generation = id();
  const member1 = id(), member2 = id(), early = id(), reader = id(), late = id();
  const stored = new Map<string, Uint8Array>();
  const objects = { put: async (body: Uint8Array) => {
    const digest = createHash('sha256').update(body).digest('hex');
    stored.set(digest, body); return digest;
  }, get: async (digest: string) => {
    const body = stored.get(digest);
    if (!body) throw new ObjectUnavailable('missing order object');
    return body;
  } };
  const record = (occurrence: string, parent: string, orderKey: string, role: 'part' | 'chapter', target: string): OccurrenceRecord => ({
    occurrence, state: 'active', parent, segmentKey: 'a', orderKey, role, target, introducedBy: seriesRevision,
    labels: [], ...(role === 'part' ? { qualifier: { type: 'work-part' as const, displayLabel: orderKey, inclusion: 'required' as const } } : {}),
  });
  const seriesRecords = [record(member1, seriesStructure, 'a', 'part', volume1), record(member2, seriesStructure, 'b', 'part', volume2)];
  // Book chapters name a catalogue type, as the composition owner stores them.
  const chapterTarget = 'https://schema.org/DigitalDocument';
  const bookRecords = [record(early, book1, 'a', 'chapter', chapterTarget), record(reader, book1, 'b', 'chapter', chapterTarget)];
  const laterRecords = [record(late, book2, 'a', 'chapter', chapterTarget)];
  const compose = async (structure: string, profile: 'work-composition' | 'book-composition', records: OccurrenceRecord[]) => {
    const cost = newCost();
    const entries = records.map(row => ({ parent: row.parent, segmentKey: row.segmentKey!, orderKey: row.orderKey!, occurrence: row.occurrence }));
    const manifest = { format: STRUCTURE_MANIFEST_FORMAT, structure, structureOf: id(), profile, generation,
      pageFormat: STRUCTURE_PAGE_FORMAT, placementCount: records.length, measures: [], model: COMPOSITION_PROFILE, shape: COMPOSITION_PROFILE,
      records: await recordTree(objects).apply(await recordTree(objects).empty(cost), new Map(records.map(row => [row.occurrence, row])), cost),
      order: await orderTree(objects).apply(await orderTree(objects).empty(cost), new Map(entries.map(entry => [orderTreeKey(entry), entry])), cost) };
    const digest = await objects.put(new TextEncoder().encode(JSON.stringify(manifest)));
    const work = structure === seriesStructure ? series : structure === book1 ? volume1 : volume2;
    const header: CompositionHeader = { structure, profile, owner: work, component: manifest.structureOf, mainVersion: manifest.structureOf,
      work, head: structure === seriesStructure ? seriesRevision : bookRevision, generation, placementCount: records.length,
      manifest: `urn:rezics:sha256:${digest}` };
    return header;
  };
  const headers = new Map([
    [seriesStructure, await compose(seriesStructure, 'work-composition', seriesRecords)],
    [book1, await compose(book1, 'book-composition', bookRecords)],
    [book2, await compose(book2, 'book-composition', laterRecords)],
  ]);
  const placed = [
    { occurrence: member1, structure: seriesStructure, work: series, parent: seriesStructure, segmentKey: 'a', orderKey: 'a', role: 'part' as const, target: volume1 },
    { occurrence: member2, structure: seriesStructure, work: series, parent: seriesStructure, segmentKey: 'a', orderKey: 'b', role: 'part' as const, target: volume2 },
    { occurrence: early, structure: book1, work: volume1, parent: book1, segmentKey: 'a', orderKey: 'a', role: 'chapter' as const, target: bookRecords[0]!.target! },
    { occurrence: reader, structure: book1, work: volume1, parent: book1, segmentKey: 'a', orderKey: 'b', role: 'chapter' as const, target: bookRecords[1]!.target! },
    { occurrence: late, structure: book2, work: volume2, parent: book2, segmentKey: 'a', orderKey: 'a', role: 'chapter' as const, target: laterRecords[0]!.target! },
  ];
  const saved: Array<{ structure: string; occurrence: string }> = [{ structure: book1, occurrence: reader }];
  const env = { structureObjects: objects, fuseki: { query: async (q: string) => {
    if (q.includes('# reading-position:enclosing-member')) {
      const child = q.match(/schema:item <([^>]+)>/)![1]!;
      const member = child === volume1 ? member1 : child === volume2 ? member2 : '';
      return { results: { bindings: member ? [{ work: binding(series), structure: binding(seriesStructure), occurrence: binding(member) }] : [] } };
    }
    const structure = [...headers.keys()].find(value => q.includes(value));
    const header = structure ? headers.get(structure) : undefined;
    return { results: { bindings: q.includes('SELECT ?component') && header ? [{
      component: binding(header.component), profile: binding(`https://rezics.com/vocab/${header.profile === 'book-composition' ? 'BookComposition' : 'WorkComposition'}`),
      head: binding(header.head), generation: binding(generation), count: binding(String(header.placementCount)), manifest: binding(header.manifest),
    }] : [{ owner: binding(header?.work ?? series) }] } };
  } } };
  const session = {
    deps: { environment: env, progress: { readerVersion: async () => '1', anchorsCurrent: async () => true, resumeCandidates: async (_principal: unknown, structure: string) => ({
      items: saved.filter(row => row.structure === structure).map(row => ({ structure, occurrence: row.occurrence,
        selectedRevision: null, completed: true, position: null, version: 1 })),
      more: false, next: null,
    }) }, readingPositions: { lookup: async () => new Map(), required: async () => new Set(), generation: async () => '1',
      privateSnapshot: async () => '1' }, access: { canReadAsBaselineMember: async () => true } },
    principal: { issuer: 'https://reader.test', subject: 'viewer', emailVerified: true },
    options: { actingSubject: id() }, checkDeadline: () => {},
    query: async (query: string) => {
      if (query.includes('# reading-position:work\n')) {
        const resource = query.match(/BIND\(<([^>]+)> AS \?work\)/)![1]!;
        const structure = resource === series ? seriesStructure : resource === volume1 ? book1 : resource === volume2 ? book2 : '';
        const revision = structure === seriesStructure ? seriesRevision : bookRevision;
        return structure ? [{ work: binding(resource), structure: binding(structure), revision: binding(revision), generation: binding(generation) }] : [{ work: binding(resource) }];
      }
      if (query.includes('# reading-position:parent-work')) {
        const child = query.match(/schema:item <([^>]+)>/)![1]!;
        const member = child === volume1 ? member1 : child === volume2 ? member2 : '';
        return member ? [{ occurrence: binding(member) }] : [];
      }
      if (query.includes('# reading-position:records')) {
        const wanted = query.match(/VALUES [^{]+\{([^}]+)}/)![1]!;
        return placed.filter(row => wanted.includes(row.occurrence)).map(row => ({
          work: binding(row.work), structure: binding(row.structure),
          revision: binding(row.structure === seriesStructure ? seriesRevision : bookRevision),
          occurrence: binding(row.occurrence), parent: binding(row.parent), segmentKey: binding(row.segmentKey),
          orderKey: binding(row.orderKey), role: binding(`https://rezics.com/vocab/${row.role === 'part' ? 'PartRole' : 'ChapterRole'}`),
          target: binding(row.target),
        }));
      }
      return [];
    },
  } as unknown as WorkReadSession;
  const disclose = async (_reader: WorkReadSession, selected: { structure: string }, rows: readonly { occurrence: string }[]) =>
    rows.filter(row => placed.some(item => item.occurrence === row.occurrence && item.structure === selected.structure));
  return { series, seriesStructure, book1, member1, early, reader, late, saved, headers, env, session, disclose, placed };
}

test('a chapter inside volume 1 resumes across the series and keeps only earlier introductions', async () => {
  const f = await volumeSeries();
  const local = { revision: f.headers.get(f.book1)!.head, key: 'a\u0002b', eligible: true };
  const anchors = await continuityAnchors(f.env as never, f.headers.get(f.book1)!, f.reader, local);
  expect(anchors).toEqual([{ structure: f.seriesStructure, order: { revision: f.headers.get(f.seriesStructure)!.head,
    key: 'a\u0002a\u0001a\u0002b', eligible: true } }]);
  f.saved.push({ structure: f.seriesStructure, occurrence: f.reader });
  const traversal = new ReadingPositionTraversal(f.session, f.series, async resources => new Set(resources));
  expect(await chooserPosition(f.session, traversal, 'mine', true, f.disclose as never)).toBe(f.reader);
  const earlyRecord = id(), lateRecord = id();
  f.session.deps.readingPositions!.lookup = async (records: readonly string[]) => new Map(records.flatMap(record =>
    record === earlyRecord ? [[record, [{ record, recordKind: 'entity' as const, continuityWork: f.series, occurrence: f.early, receipt: 'publication' }]]]
      : record === lateRecord ? [[record, [{ record, recordKind: 'entity' as const, continuityWork: f.series, occurrence: f.late, receipt: 'publication' }]]] : []));
  const boundary = new ReadingBoundary(f.session, 'mine');
  boundary.traversalFor = () => traversal;
  expect([...(await boundary.visible([earlyRecord, lateRecord, 'untagged']))]).toEqual([earlyRecord, 'untagged']);
});

test('a completed volume part resumes at the chapter inside that volume', async () => {
  const f = await volumeSeries();
  f.saved.length = 0;
  f.saved.push({ structure: f.seriesStructure, occurrence: f.member1 }, { structure: f.book1, occurrence: f.reader });
  const traversal = new ReadingPositionTraversal(f.session, f.series, async resources => new Set(resources));
  expect(await chooserPosition(f.session, traversal, 'mine', true, f.disclose as never)).toBe(f.reader);
});

test('a position nested past one volume is refused instead of completing as unread', async () => {
  const f = await volumeSeries();
  const inner = id(), innerPart = id();
  f.placed.push({ occurrence: innerPart, structure: f.book1, work: f.headers.get(f.book1)!.work, parent: f.book1,
    segmentKey: 'a', orderKey: 'c', role: 'part', target: inner });
  f.saved.length = 0;
  f.saved.push({ structure: f.seriesStructure, occurrence: f.member1 }, { structure: f.book1, occurrence: innerPart });
  const native = f.session.query.bind(f.session);
  f.session.query = async (query: string, limit: number) => {
    if (query.includes('# reading-position:work\n') && query.includes(inner)) {
      return [{ work: binding(inner), structure: binding(id()), revision: binding(id()), generation: binding(id()) }];
    }
    return native(query, limit);
  };
  const traversal = new ReadingPositionTraversal(f.session, f.series, async resources => new Set(resources));
  await expect(chooserPosition(f.session, traversal, 'mine', true, f.disclose as never)).rejects.toBeInstanceOf(ReadingContinuityUnsupported);
  // The same refusal must fail the wiki read. Swallowing it would publish the
  // page as though the reader had not reached the introduction.
  f.session.deps.progress!.resumeCandidates = async () => {
    throw new ReadingContinuityUnsupported('A reading position is nested deeper than this continuity can resolve');
  };
  const record = id();
  f.session.deps.readingPositions!.lookup = async () => new Map([[record, [{ record, recordKind: 'entity' as const,
    continuityWork: f.series, occurrence: f.early, receipt: 'publication' }]]]);
  const boundary = new ReadingBoundary(f.session, 'mine');
  boundary.traversalFor = () => traversal;
  await expect(boundary.visible([record, 'untagged'])).rejects.toBeInstanceOf(ReadingContinuityUnsupported);
});

test('a nested chapter is disclosed by its own volume before it resumes anything', async () => {
  const f = await volumeSeries();
  f.saved.push({ structure: f.seriesStructure, occurrence: f.reader });
  const hidden = new Set<string>();
  const volumePolicy = async (_reader: WorkReadSession, selected: { structure: string }, rows: readonly { occurrence: string }[]) =>
    rows.filter(row => f.placed.some(item => item.occurrence === row.occurrence
      && item.structure === selected.structure && !hidden.has(item.occurrence)));
  const traversal = new ReadingPositionTraversal(f.session, f.series, async resources => new Set(resources));
  expect(await chooserPosition(f.session, traversal, 'mine', true, volumePolicy as never)).toBe(f.reader);
  // Withholding the chapter's target is the same answer as never having saved it.
  hidden.add(f.reader);
  expect(await chooserPosition(f.session, traversal, 'mine', true, volumePolicy as never)).toBe('start');
  f.saved.push({ structure: f.seriesStructure, occurrence: f.early });
  expect(await chooserPosition(f.session, traversal, 'mine', true, volumePolicy as never)).toBe(f.early);
});

test('a continuation after a withheld scan window never carries a physical ordinal', async () => {
  const f = await fixture();
  // The first page ends exactly where the scan window does. The visible
  // sibling that follows is physically the 33rd.
  for (const row of f.episodes.slice(0, 32)) f.hidden.add(row.target!);
  const first = await f.traversal().page({ limit: 1 });
  expect(first.items).toEqual([]);
  expect(first.next).not.toBeNull();
  const second = await f.traversal().page({ limit: 1, after: first.next! });
  expect(second.items.map(row => row.occurrence)).toEqual([f.episodes[32]!.occurrence]);
  expect(Object.hasOwn(second.items[0]!, 'ordinal')).toBe(false);
  // A page that never stepped over a withheld part keeps its ordinal.
  const open = await fixture();
  const opened = await open.traversal().page({ limit: 1 });
  const carried = await open.traversal().page({ limit: 1, after: opened.next! });
  expect(carried.items[0]!.ordinal).toBe(2);
});

test('an unstarted owner continues the opening page with a cursor the next request accepts', async () => {
  const f = await fixture();
  Object.assign(f.session.deps, { access: { canReadAsBaselineMember: async () => true } });
  const traversal = f.traversal();
  const mine = new ReadingBoundary(f.session, 'mine');
  mine.traversalFor = () => traversal;
  const first = await mine.chooser(f.work, 1);
  expect(first).toMatchObject({ resolved: 'start', scope: 'positions' });
  expect(first.items.map(row => row.occurrence)).toEqual([f.episodes[0]!.occurrence]);
  expect(first.next).toBeString();
  const second = await mine.chooser(f.work, 1, first.next!);
  expect(second.items.map(row => row.occurrence)).toEqual([f.episodes[1]!.occurrence]);
  expect(second.items.every(row => !Object.hasOwn(row, 'ordinal'))).toBe(true);
  expect(second.next).toBeString();
});

test('a volume whose anchors are not prepared for the current heads makes series resume unavailable', async () => {
  const f = await volumeSeries();
  f.saved.push({ structure: f.seriesStructure, occurrence: f.reader });
  const asked: unknown[] = [];
  f.session.deps.progress!.anchorsCurrent = async (_principal, member, parent) => {
    asked.push([member, parent]); return false;
  };
  const traversal = new ReadingPositionTraversal(f.session, f.series, async resources => new Set(resources));
  // The stored key was derived from an earlier order of this volume. Reading it
  // would resume at a chapter that is no longer the furthest.
  await expect(chooserPosition(f.session, traversal, 'mine', true, f.disclose as never))
    .rejects.toBeInstanceOf(ReadingResumeUnavailable);
  expect(asked).toEqual([[{ structure: f.book1, revision: f.headers.get(f.book1)!.head },
    { structure: f.seriesStructure, revision: f.headers.get(f.seriesStructure)!.head }]]);
  f.session.deps.progress!.anchorsCurrent = async () => true;
  expect(await chooserPosition(f.session, traversal, 'mine', true, f.disclose as never)).toBe(f.reader);
});

function anchorClient(f: Awaited<ReturnType<typeof volumeSeries>>, rows: Array<{ occurrence: string; selection_key: string; completed: boolean }>) {
  const writes: Array<{ sql: string; params: unknown[] }> = [];
  const head = f.headers.get(f.book1)!.head;
  let basis: { anchor_revision: string | null; anchor_parent: string | null; anchor_parent_revision: string | null;
    anchor_cursor: { occurrence?: string; selection?: string } | null } = { anchor_revision: null, anchor_parent: null,
    anchor_parent_revision: null, anchor_cursor: null };
  let rolledBack = false;
  const client = { release: () => {}, query: async (sql: string, params: unknown[] = []) => {
    if (sql.startsWith('SELECT order_revision')) return { rows: [{ ready: true, order_revision: head, invalidations: '0',
      reindex_cursor: null, reindex_invalidations: null }] };
    if (sql.startsWith('SELECT anchor_revision')) return { rows: [basis] };
    if (sql.includes('UPDATE structure.progress_scope SET anchor_revision=$4')) {
      basis = { anchor_revision: String(params[3]), anchor_parent: String(params[4]), anchor_parent_revision: String(params[5]),
        anchor_cursor: params[6] === null ? null : JSON.parse(String(params[6])) };
    } else if (sql.includes('UPDATE structure.progress_scope SET anchor_cursor')) {
      basis = { ...basis, anchor_cursor: params[3] === null ? null : JSON.parse(String(params[3])) };
    } else if (sql.startsWith('SELECT occurrence,selection_key,completed')) {
      expect(sql).toContain('LIMIT 3');
      const after = params[3] as string | undefined;
      return { rows: rows.filter(row => !after || row.occurrence > after).slice(0, 3) };
    } else if (sql.startsWith('ROLLBACK')) rolledBack = true;
    else if (sql.includes('INSERT INTO structure.progress\n') || sql.includes('UPDATE structure.progress SET')) writes.push({ sql, params });
    return { rows: [] };
  } };
  return { client, writes, state: () => basis, rolledBack: () => rolledBack };
}

async function anchorProjection(f: Awaited<ReturnType<typeof volumeSeries>>, client: unknown) {
  const native = f.env.fuseki.query.bind(f.env.fuseki);
  // The owner of a Structure is found through its component.
  f.env.fuseki.query = async (q: string) => {
    if (/\bASK \{/.test(q)) return { boolean: true } as never;
    const owner = q.startsWith('SELECT ?owner') ? [...f.headers.values()].find(header => q.includes(header.component)) : undefined;
    return (owner ? { results: { bindings: [{ owner: binding(owner.work) }] } } : await native(q)) as never;
  };
  Object.assign(f.env, { lineage: { dataEpoch: 'test', routingEpoch: 'test' } });
  const pool = { connect: async () => client, query: async () => ({ rows: [] }) } as unknown as Pool;
  const projection = new ProgressOrderProjection(pool, f.env as never);
  projection.request({ issuer: 'https://reader.test', subject: 'viewer' }, f.book1);
  return projection;
}

test('earlier completions are anchored on the enclosing series two at a time, resumably', async () => {
  const f = await volumeSeries();
  // The last key sorts after any generated identity: an incomplete row nothing is anchored for.
  const unplaced = 'https://rezics.com/id/ffffffff-ffff-ffff-ffff-ffffffffffff';
  const rows = [...[f.early, f.reader].sort(), unplaced].map(occurrence => ({ occurrence, selection_key: '', completed: occurrence !== unplaced }));
  const done = anchorClient(f, rows);
  const projection = await anchorProjection(f, done.client);
  const seriesHead = f.headers.get(f.seriesStructure)!.head;
  await projection.step();
  const anchored = () => done.writes.filter(write => write.sql.includes('INSERT INTO structure.progress\n'));
  expect(done.state()).toMatchObject({ anchor_revision: f.headers.get(f.book1)!.head, anchor_parent: f.seriesStructure,
    anchor_parent_revision: seriesHead, anchor_cursor: { occurrence: rows[1]!.occurrence } });
  // Two rows per step; the third row is the lookahead that proves there is more.
  expect(anchored().length + done.writes.filter(write => write.sql.includes('UPDATE structure.progress SET')).length).toBe(2);
  expect(anchored().map(write => write.params[3])).toEqual(
    rows.slice(0, 2).map(row => row.occurrence));
  expect(anchored().every(write => write.params[2] === f.seriesStructure && write.params[5] === seriesHead)).toBe(true);
  await projection.step();
  expect(done.state().anchor_cursor).toBeNull();
  // The incomplete third row withdraws any anchor it had; nothing is created.
  expect(done.writes.at(-1)!.sql).toContain('UPDATE structure.progress SET completed = false');
  // A prepared scope is not rewritten again until a head moves.
  const before = done.writes.length;
  await projection.step();
  expect(done.writes.length).toBe(before);
});

test('a head that moves during an anchor page leaves the scope unprepared', async () => {
  const f = await volumeSeries();
  const done = anchorClient(f, [{ occurrence: f.reader, selection_key: '', completed: true }]);
  const projection = await anchorProjection(f, done.client);
  const book = f.headers.get(f.book1)!;
  const native = f.env.fuseki.query.bind(f.env.fuseki);
  let reads = 0;
  f.env.fuseki.query = async (q: string) => {
    const value = await native(q) as { results?: { bindings: Array<Record<string, { value: string }>> } };
    // The series head is read before the page and again before it commits.
    if (q.includes('SELECT ?component') && q.includes(f.seriesStructure) && ++reads > 1) {
      for (const binding of value.results?.bindings ?? []) binding.head = { value: id() };
    }
    return value as never;
  };
  await expect(projection.step()).rejects.toThrow('Progress anchor basis changed');
  expect(done.rolledBack()).toBe(true);
  expect(book.head).toBe(f.headers.get(f.book1)!.head);
});

test('a write vouches for its anchors only at the heads they were derived from', async () => {
  const principal = { issuer: 'https://reader.test', subject: 'viewer' };
  const structure = id(), parent = id(), head = id(), parentHead = id();
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const client = { query: async (sql: string, params: unknown[]) => { calls.push({ sql, params }); return { rows: [] }; } };
  const store = new StructureProgressStore({} as Pool) as unknown as {
    recordAnchorBasis(client: unknown, input: unknown, opened: boolean): Promise<void> };
  const order = { revision: head, key: 'a\u0002b' };
  const write = { principal, structure, order, anchors: [{ structure: parent, order: { revision: parentHead, key: 'a\u0002a\u0001a\u0002b' } }] };
  // A scope this write opens is prepared for exactly its heads.
  await store.recordAnchorBasis(client, write, true);
  expect(calls[0]!.sql).toContain('SET anchor_revision=$4, anchor_parent=$5');
  expect(calls[0]!.params).toEqual([principal.issuer, principal.subject, structure, head, parent, parentHead]);
  // A scope prepared for other heads stops vouching for them.
  await store.recordAnchorBasis(client, write, false);
  expect(calls[1]!.sql).toContain('SET anchor_revision=NULL');
  expect(calls[1]!.sql).toContain('anchor_revision <> $4');
  expect(calls[1]!.params).toEqual([principal.issuer, principal.subject, structure, head, parent, parentHead]);
  // A direct write that carries no anchors says nothing about them.
  await store.recordAnchorBasis(client, { ...write, anchors: undefined }, false);
  expect(calls).toHaveLength(2);
});

test('a volume placed in two compositions saves chapter progress without a series anchor', async () => {
  const f = await volumeSeries();
  const book = f.headers.get(f.book1)!;
  const volume = book.work;
  const omnibus = id(), omnibusStructure = id(), omnibusMember = id();
  const native = f.env.fuseki.query.bind(f.env.fuseki);
  f.env.fuseki.query = (async (q: string) => {
    if (q.includes('# reading-position:enclosing-member') && q.includes(volume)) {
      return { results: { bindings: [
        { work: binding(f.series), structure: binding(f.seriesStructure), occurrence: binding(f.member1) },
        { work: binding(omnibus), structure: binding(omnibusStructure), occurrence: binding(omnibusMember) },
      ] } };
    }
    return native(q);
  }) as typeof f.env.fuseki.query;
  const local = { revision: book.head, key: 'a\u0002b', eligible: true };
  // The progress route stores this list. Empty means the chapter write records
  // no series anchor and does not fail.
  await expect(continuityAnchors(f.env as never, book, f.reader, local)).resolves.toEqual([]);
  const done = anchorClient(f, [{ occurrence: f.reader, selection_key: '', completed: true }]);
  const projection = await anchorProjection(f, done.client);
  await projection.step();
  expect(done.writes.filter(write => write.sql.includes('structure.progress'))).toEqual([]);
  expect(done.state()).toMatchObject({ anchor_parent: '', anchor_cursor: null });
  // The chapter stands on its book. Series resume sees that book and refuses
  // to treat the missing anchor as an unstarted series.
  Object.assign(f.session.deps.progress!, { resumeStructures: async () => [book.structure] });
  const traversal = new ReadingPositionTraversal(f.session, f.series, async resources => new Set(resources));
  await expect(chooserPosition(f.session, traversal, 'mine', true, f.disclose as never))
    .rejects.toThrow('A reading position belongs to more than one series');
});

test('eligible progress structures are one index page, not a series inventory', async () => {
  const principal = { issuer: 'https://reader.test', subject: 'viewer' };
  const structure = id();
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool = { query: async (sql: string, params: unknown[]) => {
    calls.push({ sql, params });
    return { rows: [{ structure }, { structure }] };
  } } as unknown as Pool;
  const store = new StructureProgressStore(pool);
  expect(await store.resumeStructures(principal)).toEqual([structure]);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.sql).toContain('FROM structure.progress');
  expect(calls[0]!.sql).toContain('AND completed AND resume_eligible');
  expect(calls[0]!.sql).toContain('ORDER BY structure, occurrence, selection_key');
  expect(calls[0]!.sql).not.toContain('JOIN');
  expect(calls[0]!.params).toEqual([principal.issuer, principal.subject, STRUCTURE_PROGRESS_COST.resumeCandidates + 1]);
});

test('anchor readiness is one keyed scope row, and an unprepared scope asks for preparation', async () => {
  const principal = { issuer: 'https://reader.test', subject: 'viewer' };
  const member = { structure: id(), revision: id() }, parent = { structure: id(), revision: id() };
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  let prepared = false;
  const pool = { query: async (sql: string, params: unknown[]) => {
    calls.push({ sql, params }); return { rows: prepared ? [{}] : [] };
  } } as unknown as Pool;
  const store = new StructureProgressStore(pool);
  expect(await store.anchorsCurrent(principal, member, parent)).toBe(false);
  prepared = true;
  expect(await store.anchorsCurrent(principal, member, parent)).toBe(true);
  expect(calls).toHaveLength(2);
  expect(calls[0]!.sql).toContain('anchor_cursor IS NULL');
  expect(calls[0]!.params).toEqual([principal.issuer, principal.subject, member.structure, member.revision, parent.structure, parent.revision]);
  await expect(store.anchorsCurrent(principal, { ...member, revision: 'invalid' }, parent)).rejects.toBeInstanceOf(InvalidStructureProgress);
});
