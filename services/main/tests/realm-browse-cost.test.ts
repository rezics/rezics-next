import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { configureDisclosure } from '../src/modules/disclosure/read.ts';
import { DiscoveryProjection } from '../src/modules/discovery/store.ts';
import { DISCOVERY_SOURCE_PROFILE } from '../src/modules/discovery/profile.ts';
import { ANONYMOUS_VIEWER } from '../src/modules/suitability/policy.ts';
import type { RealmPolicy } from '../src/modules/space/policy.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { WorkReadUnavailable, type WorkReadSession } from '../src/modules/work/read-session.ts';
import { ZoneBrowseProjection } from '../src/modules/zone-browse/store.ts';
import { fusekiReadBudget } from '../src/infrastructure/fuseki.ts';
import { readZoneBrowse } from '../src/modules/zone-modules/browse.ts';
import { fixtureDisclosureReader } from './support/disclosure-ancestry.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const term = (value: string) => ({ type: 'literal', value });
const uri = (value: string) => ({ type: 'uri', value });
const realm = id(1000001), concept = id(1000002);

/** The independently retained seven Works and Concept edges do not change.
 * A newer graph counter represents an unrelated private Work write, while
 * Access's classification source fence and active generation stay unchanged. */
function fixture(type: string, count = 7, limit = 20) {
  const inventory = Array.from({ length: count }, (_, index) => id(index + 1));
  const credits: string[] = [];
  const row = { generation_id: '00000000-0000-4000-8000-000000000001', state: 'ready',
    scope: 'realm', realm, context: null, principal_id: null, complete: true,
    source_epoch: 'epoch', source_sequence: '97', covered_sequence: '97',
    source_profile: DISCOVERY_SOURCE_PROFILE, access_revision: '1', recovery_generation: 'recovery',
    work_count: String(count), storage_version: '0' };
  const source = { sequence: '97' };
  const calls: string[] = [];
  const query = async (sql: string, values: unknown[] = []) => {
    calls.push(sql);
    if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/.test(sql)) return { rows: [] };
    if (sql.includes('SELECT open FROM access.recovery_fence')) return { rows: [{ open: true }] };
    if (sql.includes('SELECT active_generation::text')) return { rows: [{ active_generation: row.generation_id }] };
    if (sql.includes('SELECT d.*, g.state')) return { rows: [row] };
    if (sql.includes('FROM access.discovery_source_fence')) return { rows: [{ revision: '1', changed: false,
      wide: false, statements: [], generation: 'recovery' }] };
    if (sql.includes('FROM access.discovery_entries(')) return { rows: inventory
      .filter(work => (values[2] as string[]).includes(work)).map(work => ({ work, term: concept, concept })) };
    throw new Error(`Unexpected Discovery owner query: ${sql}`);
  };
  const discovery = new DiscoveryProjection({ query, connect: async () => ({ query, release() {} }) } as unknown as Pool);
  const environment = { lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' }, fuseki: {
    query: async (body: string) => {
      if (body.includes('SELECT ?work ?head ?owningWork') && body.includes(`<${realm}>`)) {
        return { results: { bindings: [{ work: uri(realm), head: uri(id(102)) }] } };
      }
      throw new Error('Unexpected Realm disclosure query');
    },
  } } as unknown as WorkActivationEnvironment;
  configureDisclosure(environment, fixtureDisclosureReader(async targets => targets.map(target =>
    target.owner === 'graph' && target.resource === realm && target.component === 'record' ? 'visible' : 'hidden')));
  const session = () => ({
    deps: { environment, discovery,
      personPreferences: { visibleNameOwners: async (owners: readonly string[]) => new Set(owners) },
      zoneBrowse: { current: () => true,
      batch: async (_realm: string, _sort: string, after: { key: string } | null) => inventory
        .map((work, index) => ({ work, adoptedOrder: String(count - index), updatedAt: null, words: null }))
        .filter(entry => !after || BigInt(entry.adoptedOrder) < BigInt(after.key)).slice(0, 64) } },
    options: { limit, language: 'en' }, position: { dataEpoch: 'epoch', sequence: source.sequence },
    viewer: ANONYMOUS_VIEWER, checkDeadline: () => {}, observeDependency: () => {},
    realm: async (): Promise<RealmPolicy> => ({ realmRevision: id(102), space: id(103), visibility: 'public',
      reviewMode: 'mandatory', revision: id(104), listing: 'listed', history: 'everything', admission: 'open' }),
    summaries: async (works: string[]) => works.map(work => ({ status: 'available', disclosure: 'public',
      type: work === concept ? 'concept' : 'work', name: { value: 'Retained inventory', language: 'en',
        direction: 'ltr', basis: 'requested' }, avatar: { kind: 'fallback', policy: 'test', key: work, resourceType: 'work' } })),
    query: async (body: string) => {
      const works = [...new Set([...body.matchAll(/<(https:\/\/rezics\.com\/id\/[^>]+)>/g)]
        .map(match => match[1]!).filter(work => inventory.includes(work)))];
      if (body.includes('SELECT ?work ?id ?key ?ordinal ?agent')) {
        credits.push(body);
        return works.map(work => ({ work: uri(work), id: uri(id(20000 + Number(work.slice(-12)))), agent: uri(id(20000)) }));
      }
      if (body.includes('SELECT ?agent ?displayName ?handle')) return [{ agent: uri(id(20000)), displayName: term('Owner Person') }];
      if (body.includes('?evidence')) return works.map(work => ({ work: uri(work), head: uri(id(105)),
        main: uri(id(106)), evidence: uri(id(107)), revisionEpoch: term('epoch'), sequence: term('97') }));
      if (body.includes('SELECT ?work ?type')) return works.map(work => ({ work: uri(work), type: uri(type) }));
      if (body.includes('SELECT ?work ?head') || body.includes('# Zone population batch')) return works.map(work => ({ work: uri(work) }));
      return [];
    },
  }) as unknown as WorkReadSession;
  return { session, inventory, source, row, calls, discovery, credits };
}

for (const type of ['https://schema.org/Book', 'https://schema.org/TVSeries']) {
  test(`seven ${type} Concept matches are exact only at an authoritative current classification cut`, async () => {
    const data = fixture(type);
    const before = await readZoneBrowse(data.session(), realm, { concept: [concept] });
    expect(before.items.map(item => item.id)).toEqual(data.inventory);
    expect(before.matches).toEqual({ value: 7, kind: 'exact' });
    expect(before.window.complete).toBe(true);
    data.source.sequence = '98';
    const basis = await data.discovery.active({ scope: 'realm', realm, context: null, owner: null }, data.session().position);
    expect(basis.stale).toBe(true);
    // Access's unchanged fence alone does not prove that no graph change
    // reaches this Realm. Preserve the refusal instead of relabelling a cut.
    await expect(readZoneBrowse(data.session(), realm, { concept: [concept] })).rejects.toBeInstanceOf(WorkReadUnavailable);
  });
}

for (const count of [21, 65, 1000]) {
  test(`a ten-Work page uses one credit seek over ${count} eligible Works and retains native Person credit`, async () => {
    const data = fixture('https://schema.org/Book', count, 10);
    const first = await readZoneBrowse(data.session(), realm, { sort: 'newest' });
    expect(first.items.map(item => item.id)).toEqual(data.inventory.slice(0, 10));
    expect(first.matches).toEqual({ value: 10, kind: 'lower-bound' });
    expect(first.nextCursor).toBeString();
    expect(data.credits).toHaveLength(1);
    for (const item of first.items) expect(item.primaryCredits).toContainEqual(expect.objectContaining({
      agent: id(20000), participantKind: 'agent', role: 'author', displayName: 'Owner Person',
    }));
    const session = data.session(); session.options.cursor = first.nextCursor!;
    const second = await readZoneBrowse(session, realm, { sort: 'newest' });
    expect(second.items.map(item => item.id)).toEqual(data.inventory.slice(10, 20));
    expect(second.matches).toEqual({ value: 20, kind: 'lower-bound' });
    expect(data.credits).toHaveLength(2);
  });
}

function projectPage(count: number, malformed = false) {
  const rows = Array.from({ length: count }, (_, index) => ({ realm: uri(realm), work: uri(id(index + 1)),
    sequence: term(malformed && index === 1 ? 'bad' : String(index + 1)), epochOrder: term('1') }));
  const inserts: unknown[][] = [], statements: string[] = [];
  const sql = async (body: string, values: unknown[] = []) => {
    statements.push(body);
    if (body.includes('INSERT INTO access.zone_browse_entry')) inserts.push(values);
    return { rows: [] };
  };
  const access = { connect: async () => ({ query: sql, release() {} }) } as unknown as Pool;
  const environment = { lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' }, fuseki: {
    query: async () => {
      fusekiReadBudget.getStore()?.signal.throwIfAborted();
      return { results: { bindings: rows } };
    },
  } } as unknown as WorkActivationEnvironment;
  const projection = new ZoneBrowseProjection(access, {} as Pool, environment);
  const project = () => (projection as unknown as { project(where: string, epochs: string): Promise<{ realm: string; work: string }[]> })
    .project('', '');
  return { project, inserts, statements };
}

for (const count of [1, 21, 64]) {
  test(`a projection page writes ${count} adoption candidates in one bounded SQL statement`, async () => {
    const data = projectPage(count);
    expect(await data.project()).toEqual(Array.from({ length: count }, (_, index) => ({ realm, work: id(index + 1) })));
    expect(data.inserts).toHaveLength(1);
    const tuples = JSON.parse(String(data.inserts[0]![0])) as { realm: string; work: string; adopted_order: string }[];
    expect(tuples).toEqual(Array.from({ length: count }, (_, index) => ({ realm, work: id(index + 1),
      adopted_order: String(10n ** 38n + BigInt(index + 1)) })));
    const insert = data.statements.find(body => body.includes('INSERT INTO access.zone_browse_entry'))!;
    expect(data.statements).toContain('SELECT generation FROM access.serial_stats_checkpoint WHERE singleton FOR SHARE');
    expect(insert).toContain('LEFT JOIN LATERAL');
    expect(insert).toContain('WHERE generation = c.generation AND work = candidate.work LIMIT 1');
    expect(insert).toContain('ON CONFLICT (realm, work) DO UPDATE SET updated_at = EXCLUDED.updated_at, word_count = EXCLUDED.word_count');
  });
}

test('a malformed adoption page rolls back without any candidate write', async () => {
  const data = projectPage(21, true);
  await expect(data.project()).rejects.toBeInstanceOf(WorkReadUnavailable);
  expect(data.inserts).toEqual([]);
  expect(data.statements).toContain('ROLLBACK');
});

test('an upstream page with more than 64 adoption rows is refused before a SQL write', async () => {
  const data = projectPage(65);
  await expect(data.project()).rejects.toBeInstanceOf(WorkReadUnavailable);
  expect(data.inserts).toEqual([]);
});

test('cancelled projection work performs no SQL transaction or candidate write', async () => {
  const data = projectPage(64), controller = new AbortController();
  controller.abort(new Error('projection preparation cancelled'));
  await expect(fusekiReadBudget.run({ signal: controller.signal, callsLeft: 6, bytesLeft: 256 * 1024 },
    data.project)).rejects.toThrow('projection preparation cancelled');
  expect(data.statements).toEqual([]);
});
