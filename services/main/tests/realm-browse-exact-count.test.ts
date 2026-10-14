import { expect, test } from 'bun:test';
import { readZoneBrowse } from '../src/modules/zone-modules/browse.ts';
import { encodeReadCursor, WorkReadExpired, WorkReadUnavailable, type WorkReadSession } from '../src/modules/work/read-session.ts';
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

function fixture(count = 21) {
  const entries: BrowseEntry[] = Array.from({ length: count }, (_, n) => ({ work: id(n + 1),
    adoptedOrder: String(count - n), words: n, updatedAt: n < 700 ? '2026-09-20T00:00:00.000001Z' : null }));
  const hidden = new Set<string>(), reads: number[] = [];
  const coverage = { current: true };
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
      zoneBrowse: { current: () => coverage.current, batch: async (_: string, sort: 'newest' | 'updated', after: { work: string; key: string | null } | null) => {
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
  return { entries, hidden, reads, make, coverage, setTags: (value: typeof tagState) => { tagState = value; } };
}

for (const sort of ['newest', 'updated', 'relevance'] as const) {
  const query = { sort, type: [book], ...(sort === 'relevance' ? { q: 'Story' } : {}) };
  test(`first and later readers finish an independently expected 21-Work ${sort} inventory exactly`, async () => {
    const data = fixture();
    const expected = data.entries.map(entry => entry.work);
    for (const reader of ['first', 'later']) {
      const first = await readZoneBrowse(data.make(), realm, query);
      expect(first.items, reader).toHaveLength(20);
      expect(first.matches).toEqual({ value: 20, kind: 'lower-bound' });
      expect(first.window.complete).toBe(false);
      expect(first.nextCursor).toBeString();
      const last = await readZoneBrowse(data.make(first.nextCursor!), realm, query);
      expect(last.items).toHaveLength(1);
      expect([...first.items, ...last.items].map(item => item.id).sort()).toEqual([...expected].sort());
      expect(new Set([...first.items, ...last.items].map(item => item.id)).size).toBe(21);
      expect(last.nextCursor).toBeNull();
      expect(last.matches).toEqual({ value: 21, kind: 'exact' });
      expect(last.window.complete).toBe(true);
    }
    const none = await readZoneBrowse(data.make(), realm, { ...query, q: 'Missing' });
    expect(none.items).toEqual([]);
    expect(none.matches).toEqual({ value: 0, kind: 'exact' });
    expect(none.window.complete).toBe(true);
  });

  test(`an incomplete first-reader ${sort} cut refuses a cursor`, async () => {
    const data = fixture();
    data.coverage.current = false;
    await expect(readZoneBrowse(data.make(), realm, query)).rejects.toBeInstanceOf(WorkReadUnavailable);
    expect(data.reads).toEqual([]);
  });

  test(`a historical incomplete ${sort} cursor cannot pin later terminal count precision`, async () => {
    const data = fixture();
    // This is the exact state issued by the historical reader after delivering
    // twenty identities while its projection coverage was incomplete.
    const binding = ['zone-browse-v3', realm, query.q ?? null, sort,
      { all: [{ facet: 'type', any: [book] }] }, 'en'];
    const after = data.entries[sort === 'updated' ? 1 : 19]!;
    const cursor = encodeReadCursor(binding, data.make().position, JSON.stringify({
      after: { work: after.work, key: sort === 'updated' ? after.updatedAt : after.adoptedOrder },
      current: false, visible: 20,
    }), '', Date.now() + 300_000);
    let answer: unknown;
    try { answer = await readZoneBrowse(data.make(cursor), realm, query); }
    catch (error) { answer = error; }
    if (!(answer instanceof WorkReadExpired)) {
      await Bun.write(`.temp/realm-browse-exact-count-owner-${Bun.env.REZICS_QA_RUN_ID}-${sort}.json`,
        JSON.stringify({ expected: data.entries.map(entry => entry.work), priorVisible: 20, answer }, null, 2));
    }
    expect(answer).toBeInstanceOf(WorkReadExpired);
    expect(data.reads).toEqual([]);
    const first = await readZoneBrowse(data.make(), realm, query);
    const last = await readZoneBrowse(data.make(first.nextCursor!), realm, query);
    expect(last.matches).toEqual({ value: 21, kind: 'exact' });
    expect(last.window.complete).toBe(true);
  });
}
