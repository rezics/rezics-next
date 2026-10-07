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

import { ReadingSeekUnavailable, ReadingResumeUnavailable, ReadingResumeDisclosureBound } from '../src/modules/reading-position/errors.ts';
import { disclosedCompletedProgress } from '../src/modules/progress/disclosure.ts';
import { ReadingPositionStore } from '../src/modules/reading-position/store.ts';
import { ProgressOrderProjection } from '../src/modules/progress/order-projection.ts';

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
      resumeCandidates: async () => {
        indexReads++;
        const selected = records.filter(record => completed.includes(record.occurrence) && record !== special)
          .sort((a, b) => key(a) < key(b) ? 1 : -1).slice(0, STRUCTURE_PROGRESS_COST.resumeCandidates + 1);
        indexRows += selected.length;
        return { items: selected.slice(0, STRUCTURE_PROGRESS_COST.resumeCandidates).map(record => ({ structure,
          occurrence: record.occurrence, selectedRevision: null, completed: true, position: null, version: 1 })),
          more: selected.length > STRUCTURE_PROGRESS_COST.resumeCandidates };
      },
    }, readingPositions: {
      completedPage: async () => { historyPages++; throw new Error('Resume must never page history'); },
      finishedWorks: async () => { throw new Error('Resume must never scan Library history'); },
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

test('hidden furthest completion falls back within 16 candidates; exhaustion is explicit', async () => {
  const f = await fixture(true);
  f.completed.push(f.episodes[0]!.occurrence, f.episodes[999]!.occurrence);
  f.hidden.add(f.episodes[999]!.target!);
  expect(await chooserPosition(f.session, f.traversal(), 'mine', true, f.disclose)).toBe(f.episodes[0]!.occurrence);
  f.completed.push(...f.episodes.slice(983, 999).map(row => row.occurrence));
  for (const row of f.episodes.slice(983)) f.hidden.add(row.target!);
  await expect(chooserPosition(f.session, f.traversal(), 'mine', true, f.disclose))
    .rejects.toBeInstanceOf(ReadingResumeDisclosureBound);
  expect(await chooserPosition(f.session, f.traversal(), 'mine', false, f.disclose)).toBe('start');
});

test('a visible last sibling never returns a physical ordinal over 999 hidden items', async () => {
  const f = await fixture();
  for (const row of f.episodes.slice(0, 999)) f.hidden.add(row.target!);
  const page = await f.traversal().page({ limit: 1 });
  expect(page.items[0]!.occurrence).toBe(f.episodes[999]!.occurrence);
  expect(page.items.every(row => !Object.hasOwn(row, 'ordinal'))).toBe(true);
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
});

test('order maintenance skips occurrence inventories by owner prefix and repairs only two rows per step', async () => {
  const f = await fixture();
  const native = f.session.deps.environment.fuseki.query.bind(f.session.deps.environment.fuseki);
  f.session.deps.environment.fuseki.query = async (q, options) => q.includes('ASK') ? { boolean: true } : native(q, options);
  Object.assign(f.session.deps.environment, { lineage: { dataEpoch: 'test', routingEpoch: 'test' } });
  const rows = f.episodes.slice(0, 3).map(row => ({ occurrence: row.occurrence, selection_key: '' }))
    .sort((a, b) => a.occurrence.localeCompare(b.occurrence));
  const writes: string[] = [];
  let state = { ready: false, order_revision: f.revision, invalidations: '0',
    reindex_cursor: null as { occurrence?: string; selection?: string } | null, reindex_invalidations: null as string | null };
  const client = { release: () => {}, query: async (sql: string, params: unknown[] = []) => {
    if (sql.startsWith('SELECT order_revision')) return { rows: [state] };
    if (sql.startsWith('SELECT occurrence,selection_key')) {
      expect(sql).toContain('LIMIT 3');
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
