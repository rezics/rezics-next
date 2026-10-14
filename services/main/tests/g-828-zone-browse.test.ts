import { expect, test } from 'bun:test';
import { readZoneBrowse } from '../src/modules/zone-modules/browse.ts';
import { WorkReadExpired, WorkReadInvalid, WorkReadUnavailable, type WorkReadSession } from '../src/modules/work/read-session.ts';
import type { BrowseEntry } from '../src/modules/zone-browse/store.ts';
import type { Pool } from 'pg';
import { SerialStatisticsProjection } from '../src/modules/work/serial-projection.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../src/modules/outbox/relay-position.ts';
import { configureDisclosure } from '../src/modules/disclosure/read.ts';
import { ANONYMOUS_VIEWER } from '../src/modules/suitability/policy.ts';
import type { RealmPolicy } from '../src/modules/space/policy.ts';
import { fixtureDisclosureReader } from './support/disclosure-ancestry.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const realm = id(9000), concept = id(9001), book = 'https://schema.org/Book';
const binding = (value: string) => ({ value });

function fixture(count = 1000) {
  const entries: BrowseEntry[] = Array.from({ length: count }, (_, n) => ({ work: id(n + 1),
    adoptedOrder: String(count - n), words: n, updatedAt: n < 700 ? '2026-09-20T00:00:00.000001Z' : null }));
  const hidden = new Set<string>(), reads: number[] = [];
  const environment = { lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' }, fuseki: {
    query: async (sparql: string) => {
      if (!sparql.includes('SELECT ?work ?head ?owningWork') || !sparql.includes(`<${realm}>`)) {
        throw new Error('Unexpected Realm disclosure query');
      }
      return { results: { bindings: [{ work: binding(realm), head: binding(id(9002)) }] } };
    },
  } } as unknown as WorkActivationEnvironment;
  configureDisclosure(environment, fixtureDisclosureReader(async targets => targets.map(target =>
    target.owner === 'graph' && target.resource === realm && target.component === 'record' ? 'visible' : 'hidden')));
  const ordinal = (work: string) => Number(work.slice(-12));
  const basis = (work: string) => ({ main: id(10000 + ordinal(work)), structure: id(20000 + ordinal(work)),
    head: id(30000 + ordinal(work)), occurrence: id(40000 + ordinal(work)),
    publication: id(50000 + ordinal(work)), eligibility: id(60000 + ordinal(work)),
    variant: `urn:rezics:variant:00000000-0000-4000-8000-${work.slice(-12)}`,
    revision: `urn:rezics:content:revision:00000000-0000-4000-8000-${work.slice(-12)}` });
  const serialStats = new SerialStatisticsProjection({ query: async (sql: string, args: unknown[]) => {
    const ids = (sql.includes('FROM access.serial_chapter') ? args[1] : args[0]) as string[];
    return { rows: ids.map(work => {
      const selected = basis(work), entry = entries.find(entry => entry.work === work)!;
      return sql.includes('FROM access.serial_chapter') ? { work, occurrence: selected.occurrence, resource: work,
        variant: selected.variant, revision: selected.revision, publication: selected.publication, eligibility: selected.eligibility }
        : { generation: 'serial-generation', graph_epoch: 'epoch', sequence: '1', work,
          main_version: selected.main, structure: selected.structure, structure_head: selected.head,
          chapter_count: 1, word_count: entry.words === null ? null : String(entry.words),
          last_updated_at: entry.updatedAt ? new Date(entry.updatedAt) : null };
    }) };
  } } as unknown as Pool, { query: async (sql: string) => ({ rows: sql.includes('max(sequence)')
    ? [{ stream_scope: MAIN_RELAY_STREAM_SCOPE, data_epoch: 'epoch', sequence: '1' }]
    : [{ graph_sequence: '10000' }] }) } as unknown as Pool, {} as Pool,
  { lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' }, fuseki: { query: async (sql: string) => {
    const chosen = entries.filter(entry => sql.includes(`<${sql.includes('SELECT ?work ?head')
      ? entry.work : basis(entry.work).occurrence}>`));
    return { results: { bindings: chosen.map(entry => {
      const selected = basis(entry.work);
      const values = sql.includes('SELECT ?work ?head') ? { work: entry.work, head: selected.head }
        : { occurrence: selected.occurrence, variant: selected.variant, revision: selected.revision,
          publication: selected.publication, eligibility: selected.eligibility, epoch: 'epoch', sequence: '1', public: 'true' };
      return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, binding(value)]));
    }) } };
  } } } as unknown as WorkActivationEnvironment);
  let tagState: 'current' | 'stale' | 'unavailable' = 'current';
  const make = (cursor?: string, sequence = '10000') => ({
    options: { cursor, limit: 20, language: 'en' }, position: { dataEpoch: 'epoch', sequence },
    viewer: ANONYMOUS_VIEWER,
    checkDeadline: () => {},
    observeDependency: () => {},
    realm: async (): Promise<RealmPolicy> => ({ realmRevision: id(9002), space: id(9006),
      visibility: 'public', reviewMode: 'mandatory', revision: id(9007), listing: 'listed',
      history: 'everything', admission: 'open' }),
    query: async (sparql: string) => {
      const ids = [...sparql.matchAll(/<(https:\/\/rezics\.com\/id\/[^>]+)>/g)]
        .map(match => match[1]!).filter(value => entries.some(entry => entry.work === value));
      if (sparql.includes('?evidence')) return ids.filter(work => !hidden.has(work)).map(work => ({
        work: binding(work), head: binding(id(9003)), main: binding(id(9004)), evidence: binding(id(9005)),
        revisionEpoch: binding('epoch'), sequence: binding('1'), status: binding(Number(work.slice(-12)) % 2 ? 'completed' : 'ongoing'),
      }));
      if (sparql.includes('SELECT ?work ?type')) return ids.map(work => ({ work: binding(work), type: binding(book) }));
      if (sparql.includes('SELECT ?work ?head')) return ids.map(work => ({ work: binding(work) }));
      return [];
    },
    summaries: async (ids: string[]) => ids.map(work => ({ status: 'available', disclosure: 'public',
      type: work === concept ? 'concept' : 'work', name: { value: `Story ${work}`, language: 'en',
        direction: 'ltr', basis: 'requested' }, avatar: { kind: 'fallback', policy: 'test', key: work, resourceType: 'work' } })),
    deps: {
      environment,
      serialStats,
      zoneBrowse: { current: () => true, batch: async (_: string, sort: 'newest' | 'updated', after: { work: string; key: string | null } | null) => {
        const ordered = [...entries].sort((a, b) => sort === 'newest' ? Number(b.adoptedOrder) - Number(a.adoptedOrder)
          || b.work.localeCompare(a.work) : (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || b.work.localeCompare(a.work));
        const found = ordered.filter(entry => !after || (sort === 'newest'
          ? Number(entry.adoptedOrder) < Number(after.key) || entry.adoptedOrder === after.key && entry.work < after.work
          : (entry.updatedAt ?? '') < (after.key ?? '') || entry.updatedAt === after.key && entry.work < after.work)).slice(0, 64);
        reads.push(found.length);
        return found;
      } },
      discovery: { active: async () => {
        if (tagState === 'unavailable') throw new WorkReadUnavailable('Tags unavailable');
        return { stale: tagState === 'stale' };
      }, workTerms: async (_: unknown, ids: string[]) => ids.filter(work => Number(work.slice(-12)) % 3 === 0)
        .map(work => ({ work, concept })) },
    },
  }) as unknown as WorkReadSession;
  return { entries, hidden, reads, make, setTags: (value: typeof tagState) => { tagState = value; } };
}

test('G828: 1,000 adoptions traverse newest and updated, every Condition, ties and unknown update keys', async () => {
  for (const sort of ['newest', 'updated'] as const) {
    for (const filter of [{}, { type: [book] }, { status: ['completed'] }, { length: '950-' },
      { concept: [concept] }, { excludeConcept: [concept] }, { excludeStatus: ['completed' as const] }]) {
      const data = fixture(), seen: string[] = [];
      data.hidden.add(id(2));
      let cursor: string | undefined, last;
      do {
        last = await readZoneBrowse(data.make(cursor), realm, { sort, ...filter });
        seen.push(...last.items.map(item => item.id));
        cursor = last.nextCursor ?? undefined;
      } while (cursor);
      const expected = data.entries.filter(entry => !data.hidden.has(entry.work)
        && (!('status' in filter) || Number(entry.work.slice(-12)) % 2 === 1)
        && (!('excludeStatus' in filter) || Number(entry.work.slice(-12)) % 2 === 0)
        && (!('length' in filter) || entry.words! >= 950)
        && (!('concept' in filter) || Number(entry.work.slice(-12)) % 3 === 0)
        && (!('excludeConcept' in filter) || Number(entry.work.slice(-12)) % 3 !== 0));
      expect(new Set(seen).size).toBe(seen.length);
      expect([...seen].sort()).toEqual(expected.map(entry => entry.work).sort());
      expect(last!.matches).toEqual({ value: expected.length, kind: 'exact' });
      expect(data.reads.every(size => size <= 64)).toBe(true);
    }
  }
});

test('G828: hidden and rejected batches still continue; privacy never contributes counts', async () => {
  const data = fixture();
  data.entries.slice(0, 900).forEach(entry => data.hidden.add(entry.work));
  const first = await readZoneBrowse(data.make(), realm, {});
  expect(first.items).toEqual([]);
  expect(first.matches.value).toBe(0);
  expect(first.window.scanned).toBe(0);
  expect(first.facets.type).toEqual([]);
  expect(first.nextCursor).not.toBeNull();
  const seen: string[] = [];
  let cursor = first.nextCursor!;
  for (;;) {
    const page = await readZoneBrowse(data.make(cursor), realm, {});
    seen.push(...page.items.map(item => item.id));
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  expect(seen).toHaveLength(100);
  expect(new Set(seen).size).toBe(100);
});

test('G828: newest resumes after an adoption; changed filter and restore epoch invalidate the cursor', async () => {
  const data = fixture(60);
  const first = await readZoneBrowse(data.make(), realm, {});
  data.entries.push({ work: id(1001), adoptedOrder: '61', updatedAt: null, words: 0 });
  const second = await readZoneBrowse(data.make(first.nextCursor!, '10001'), realm, {});
  expect(second.items.map(item => item.id)).not.toContain(id(1001));
  expect(new Set([...first.items, ...second.items].map(item => item.id)).size).toBe(40);
  await expect(readZoneBrowse(data.make(first.nextCursor!), realm, { status: ['completed'] })).rejects.toBeInstanceOf(WorkReadInvalid);
  const restored = data.make(first.nextCursor!);
  restored.position.dataEpoch = 'restored';
  await expect(readZoneBrowse(restored, realm, {})).rejects.toBeInstanceOf(WorkReadExpired);
});

test('G828: stale and unavailable Tags refuse Conditions; unconditioned browse remains available', async () => {
  const data = fixture(6);
  data.setTags('stale');
  await expect(readZoneBrowse(data.make(), realm, { concept: [concept] })).rejects.toBeInstanceOf(WorkReadUnavailable);
  expect((await readZoneBrowse(data.make(), realm, {})).items).toHaveLength(6);
  data.setTags('unavailable');
  await expect(readZoneBrowse(data.make(), realm, { concept: [concept] })).rejects.toBeInstanceOf(WorkReadUnavailable);
});

test('G828: title queries use adoption order, describe the fallback, and traverse all matches', async () => {
  const data = fixture();
  const first = data.make();
  const original = first.summaries.bind(first);
  first.summaries = async ids => (await original(ids)).map((summary, n) => summary.status === 'available'
    ? { ...summary, name: { ...summary.name, value: ids[n] === id(1) ? 'A Story' : 'Story' } } : summary);
  const page = await readZoneBrowse(first, realm, { q: 'Story', sort: 'relevance' });
  expect(page.items[0]!.id).toBe(id(1)); // A later exact title must not rank ahead of the first adoption.
  expect(page.query).toMatchObject({ sort: 'relevance', appliedSort: 'newest', textMatch: 'title' });
  const seen = page.items.map(item => item.id);
  let cursor = page.nextCursor;
  while (cursor) {
    const next = await readZoneBrowse(data.make(cursor), realm, { q: 'Story', sort: 'relevance' });
    seen.push(...next.items.map(item => item.id));
    cursor = next.nextCursor;
  }
  expect(new Set(seen).size).toBe(1000);
  expect(seen).toEqual(data.entries.map(entry => entry.work));
  expect((await readZoneBrowse(data.make(), realm, { q: 'No such title' })).items).toEqual([]);
  expect((await readZoneBrowse(data.make(), realm, { q: 'S' })).items).toHaveLength(20);
});

test('an incomplete projection reports a lower bound without admitting a traversal of all 65 eligible Works', async () => {
  const data = fixture(65), session = data.make();
  session.deps.zoneBrowse!.current = () => false;
  // A first read declares lag as a lower bound, rather than a 503 or an exact empty inventory.
  const page = await readZoneBrowse(session, realm, {});
  expect(page).toMatchObject({ items: [], nextCursor: null, matches: { value: 0, kind: 'lower-bound' },
    window: { scanned: 0, complete: false }, sourcePosition: { dataEpoch: 'epoch', sequence: '10000' } });
});

test('projection coverage lost during hydration cannot publish a continuation', async () => {
  const data = fixture(65), session = data.make();
  let probes = 0;
  session.deps.zoneBrowse!.current = () => ++probes === 1;
  // Coverage lost after hydration preserves disclosed items as a lower bound, without a cursor that could skip a missing prefix.
  const page = await readZoneBrowse(session, realm, {});
  expect(page.items.map(item => item.id)).toEqual(data.entries.slice(0, 20).map(entry => entry.work));
  expect(page).toMatchObject({ nextCursor: null, matches: { value: 20, kind: 'lower-bound' },
    window: { complete: false } });
  expect(probes).toBe(2);
});

test('projection lag gives a lower bound and requires a continuation restart until traversal can resume', async () => {
  const data = fixture(30), first = data.make();
  first.deps.zoneBrowse!.current = () => false;
  // Lagging first readers can inspect an incomplete lower bound without claiming an exact total.
  expect(await readZoneBrowse(first, realm, {})).toMatchObject({ items: [], nextCursor: null,
    matches: { value: 0, kind: 'lower-bound' }, window: { complete: false } });
  const fresh = await readZoneBrowse(data.make(), realm, {});
  const lagged = data.make(fresh.nextCursor!);
  lagged.deps.zoneBrowse!.current = () => false;
  // A continuation must restart at the current prefix; dependency lag is a moved basis, not a service outage.
  await expect(readZoneBrowse(lagged, realm, {})).rejects.toBeInstanceOf(WorkReadExpired);
  const end = await readZoneBrowse(data.make(fresh.nextCursor!), realm, {});
  expect(end.items).toHaveLength(10);
  expect(end.matches.kind).toBe('exact');
});
