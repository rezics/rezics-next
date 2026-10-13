import { expect, test } from 'bun:test';
import { FusekiClient, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import type { VerifiedPrincipal } from '../src/modules/access/admission.ts';
import { configureDisclosure } from '../src/modules/disclosure/read.ts';
import { configureFixtureDisclosureAncestry, fixtureDisclosureReader } from './support/disclosure-ancestry.ts';
import { defaultPreferences, type HomeExclusion } from '../src/modules/feed/personal.ts';
import { RankingHomeTrendingReader, TRENDING_COST, type TrendingQuery } from '../src/modules/feed/trending.ts';
import type { RankingCheckpoint, ReadRankingProjection } from '../src/modules/rankings/projection.ts';
import { readRankings } from '../src/modules/rankings/read.ts';
import { derivedId } from '../src/modules/structure/graph.ts';
import { WorkReadInvalid, WorkReadMoved, WorkReadSession } from '../src/modules/work/read-session.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';

const uri = (value: string) => ({ type: 'uri' as const, value });
const literal = (value: string) => ({ type: 'literal' as const, value });
type Candidate = { work: string; score: string; growth: string };
type Rejection = 'hide' | 'absent' | 'denied';
const principal: VerifiedPrincipal = { issuer: 'account', subject: 'trending-reader' };
const agent = derivedId('trending-refill-reader');
const position = { dataEpoch: 'trending-epoch', sequence: '1' };

/** Owner responses are fake; admission, encrypted cursors, summary hydration,
 * placement selection and their fences use the production readers. */
function fixture(count: number, rejected = 0, rejection: Rejection = 'hide') {
  const candidates: Candidate[] = Array.from({ length: count }, (_, index) => ({
    work: derivedId(`trending-refill-work-${index}`), score: String(count - index), growth: String(count - index),
  }));
  const rejects = new Set(candidates.slice(0, rejected).map(row => row.work));
  const known = new Set(candidates.map(row => row.work));
  const head = derivedId('trending-refill-head'), main = derivedId('trending-refill-main');
  const hydration: string[][] = [], admissions: string[][] = [], placements: string[][] = [];
  const seeks: { after: { value: string; work: string } | null; limit: number; works: string[]; preflight?: boolean }[] = [];
  const state = {
    checkpoint: { generation: '00000000-0000-4000-8000-000000000001', contentEpoch: position.dataEpoch,
      contentSequence: '1', graphEpoch: position.dataEpoch, reviewPosition: '1' } satisfies RankingCheckpoint,
    personalRevision: 'home-1', followsRevision: 'follows-1', graphSequence: '1',
    onSeek: null as (() => void) | null,
    exclusions: rejection === 'hide' ? [...rejects].map(target => ({ kind: 'work', target, strength: 'hide' } as HomeExclusion)) : [],
    realm: (work: string) => derivedId(`trending-refill-realm-${work}`),
    actor: (work: string) => derivedId(`trending-refill-actor-${work}`),
    language: (_work: string): string | null => null,
    contentLanguages: [] as string[],
    unfollowed: new Set<string>(),
  };
  const values = (query: string, variable: string) => [...new Set([...query.matchAll(new RegExp(`VALUES \\?${variable} \\{([^}]+)\\}`, 'g'))]
    .flatMap(match => [...match[1]!.matchAll(/<([^>]+)>/g)].map(term => term[1]!)))];
  const graph = new FusekiClient('http://trending-graph.invalid');
  graph.query = async query => {
    let rows: NonNullable<SparqlResult['results']>['bindings'];
    if (query.includes('SELECT DISTINCT ?work ?main ?head')) {
      const works = values(query, 'work');
      admissions.push(works);
      rows = works.filter(work => known.has(work) && !(rejection === 'absent' && rejects.has(work)))
        .map(work => ({ work: uri(work), main: uri(main), head: uri(head) }));
    } else if (query.includes('SELECT ?epoch ?sequence ?hold ?r')) {
      const works = values(query, 'r');
      hydration.push(works);
      rows = works.map(work => ({ epoch: literal(position.dataEpoch), sequence: literal(state.graphSequence),
        r: uri(work), type: literal('work'), work: uri(work), head: uri(head), public: literal('true'),
        label: { ...literal(`Title ${work}`), 'xml:lang': 'en' }, erased: literal('false') }));
    } else if (query.includes('SELECT ?work ?head') && query.includes('rv:descriptiveMetadataHead')) {
      rows = values(query, 'work').map(work => ({ work: uri(work) }));
    } else if (query.includes('SELECT ?resource ?head WHERE')) {
      rows = values(query, 'resource').map(resource => ({ resource: uri(resource), head: uri(head) }));
    } else if (query.includes('SELECT ?work ?type')) {
      rows = values(query, 'work').map(work => ({ work: uri(work), type: uri('https://schema.org/CreativeWork') }));
    } else if (query.includes('SELECT DISTINCT ?work ?realm ?actor ?language ?zone')) {
      const works = values(query, 'work');
      placements.push(works);
      rows = works.map(work => ({ work: uri(work), realm: uri(state.realm(work)), actor: uri(state.actor(work)),
        ...(state.language(work) ? { language: literal(state.language(work)!) } : {}) }));
    } else throw new Error(`Unexpected Trending fixture query: ${query}`);
    return { results: { bindings: rows } };
  };
  const environment = { fuseki: graph, objectDirectory: '.temp/trending-refill',
    lineage: { dataEpoch: position.dataEpoch, routingEpoch: 'routing' } };
  configureDisclosure(environment, fixtureDisclosureReader(async targets => targets.map(target =>
    rejection === 'denied' && rejects.has(target.resource) ? 'hidden' : 'visible')));
  configureFixtureDisclosureAncestry(environment, target => target.work ? { resource: target.work, head,
    ...(target.workRevision !== undefined ? { protectedRevision: target.workRevision } : {}) } : undefined);
  const projection = {
    current: async () => ({ ...state.checkpoint }),
    capture: async (...args: Parameters<ReadRankingProjection['capture']>) => {
      const [metric, interval, bucket, order, after, limit, realm] = args;
      const checkpoint = { ...state.checkpoint };
      const key = order === 'growth' ? 'growth' : 'score';
      const sorted = [...candidates].sort((a, b) => Number(b[key]) - Number(a[key]) || a.work.localeCompare(b.work));
      const page = sorted.filter(row => !after || BigInt(row[key]) < BigInt(after.value)
        || row[key] === after.value && row.work > after.work).slice(0, limit);
      // A continuation first captures its revision before issuing the seek.
      if (after && seeks.at(-1)?.after === null) seeks.at(-1)!.preflight = true;
      seeks.push({ after, limit, works: page.map(row => row.work) });
      state.onSeek?.();
      return { checkpoint, revision: '1', removalRevision: '0', rows: page,
        population: { metric, interval, bucket, context: realm ?? 'urn:rezics:context:global' } };
    },
    fence: async (cut: Awaited<ReturnType<ReadRankingProjection['capture']>>) =>
      cut.checkpoint.generation === state.checkpoint.generation
      && cut.checkpoint.contentEpoch === state.checkpoint.contentEpoch
      && cut.checkpoint.graphEpoch === state.checkpoint.graphEpoch,
  } as unknown as ReadRankingProjection;
  const deps = { environment, access: {}, homePersonal: {
    read: async () => ({ owner: 'reader', revision: state.personalRevision,
      preferences: { ...defaultPreferences, contentLanguages: state.contentLanguages }, exclusions: state.exclusions }),
    fence: async () => ({ revision: state.personalRevision }),
  }, follows: { matches: async (_principal: VerifiedPrincipal, _agent: string, identities: string[][]) => ({
    revision: state.followsRevision, count: identities.length,
    matches: identities.map(ids => !ids.some(id => state.unfollowed.has(id))), reasons: [],
  }) } } as unknown as MainWorkDependencies;
  const session = (options: ConstructorParameters<typeof WorkReadSession>[2] = {}, viewer = principal) => {
    const read = new WorkReadSession(deps, new Request('http://main.test/v1/home/trending'),
      { actingSubject: agent, ...options }, position);
    read.principal = viewer;
    return read;
  };
  const reader = new RankingHomeTrendingReader(projection);
  const read = (query: TrendingQuery = { scope: 'global' }, viewer = principal) => reader.read(session({}, viewer),
    { query, principal: viewer, agent });
  return { candidates, rejects, state, projection, session, read, hydration, admissions, placements, seeks };
}

for (const rejection of ['hide', 'absent', 'denied'] as const) {
  for (const rejected of [TRENDING_COST.examinedLimit - 1, TRENDING_COST.examinedLimit, TRENDING_COST.examinedLimit + 1]) {
    test(`G1034: Trending ${rejection} prefix of ${rejected} advances within the examined cap and resumes without skips`, async () => {
      const f = fixture(rejected + TRENDING_COST.items, rejected, rejection);
      const first = await f.read();
      const expected = f.candidates.slice(rejected).map(row => row.work);
      expect(first.items.map(item => item.work)).toEqual(rejected < TRENDING_COST.examinedLimit ? expected.slice(0, 1) : []);
      expect(first.hasMore).toBe(true);
      expect(first.cursor).toEqual(expect.any(String));
      const examined = f.seeks.filter(seek => !seek.preflight)
        .reduce((total, seek) => total + Math.min(seek.limit - 1, seek.works.length), 0);
      expect(examined).toBe(TRENDING_COST.examinedLimit);
      expect(f.seeks.every(seek => seek.limit <= TRENDING_COST.chunkSize + 1)).toBe(true);
      for (const work of f.rejects) expect(JSON.stringify(first)).not.toContain(work);
      const second = await f.read({ scope: 'global', cursor: first.cursor! });
      expect([...first.items, ...second.items].map(item => item.work)).toEqual(expected);
      expect(second.hasMore).toBe(false);
      expect(second.cursor).toBeNull();
      if (rejection !== 'hide') {
        expect(f.hydration.flat().every(work => !f.rejects.has(work))).toBe(true);
        expect(f.placements.flat().every(work => !f.rejects.has(work))).toBe(true);
      }
    });
  }
  test(`G1034: Trending refills a ${rejection} prefix below its examined cap`, async () => {
    const f = fixture(12, 7, rejection);
    const result = await f.read();
    expect(result.items.map(item => item.work)).toEqual(f.candidates.slice(7).map(row => row.work));
    expect(result.items.map(item => item.rank)).toEqual([1, 2, 3, 4, 5]);
    expect(result.hasMore).toBe(false);
    expect(result.cursor).toBeNull();
  });
}

test('G1034: Ranking raw continuation counts rejected rows and never hydrates its lookahead', async () => {
  const f = fixture(8, 2, 'denied');
  const first = await readRankings(f.session({ limit: 3 }), f.projection,
    { realm: null, metric: 'reads', interval: 'week', order: 'growth' });
  expect(first.items.map(item => item.id)).toEqual([f.candidates[2]!.work]);
  expect(first.nextCursor).toEqual(expect.any(String));
  expect(f.admissions.flat()).toEqual(f.candidates.slice(0, 3).map(row => row.work));
  expect(f.hydration.flat()).toEqual([f.candidates[2]!.work, f.candidates[2]!.work]);
  const second = await readRankings(f.session({ limit: 3, cursor: first.nextCursor! }), f.projection,
    { realm: null, metric: 'reads', interval: 'week', order: 'growth' });
  expect(second.items.map(item => item.id)).toEqual(f.candidates.slice(3, 6).map(row => row.work));
});

test('G1034: Trending fills partial chunks without skipping accepted candidates and keeps rank then identity order', async () => {
  const f = fixture(13);
  f.candidates.forEach(row => { row.growth = '20'; });
  const sorted = [...f.candidates].sort((a, b) => a.work.localeCompare(b.work));
  f.state.exclusions = [sorted[1]!, sorted[3]!, sorted[5]!].map(row => ({ kind: 'work', target: row.work, strength: 'hide' }));
  const expected = sorted.filter(row => !f.state.exclusions.some(rule => rule.target === row.work)).map(row => row.work);
  const first = await f.read();
  const second = await f.read({ scope: 'global', cursor: first.cursor! });
  expect(first.items.map(item => item.work)).toEqual(expected.slice(0, 5));
  expect(second.items.map(item => item.work)).toEqual(expected.slice(5));
  expect(first.items.map(item => item.rank)).toEqual([1, 2, 3, 4, 5]);
  expect(f.seeks.some(seek => seek.limit < TRENDING_COST.chunkSize + 1)).toBe(true);
});

test('G1034: Trending exhausts bounded work for placement and Realm-cap rejections', async () => {
  const f = fixture(12);
  f.state.realm = () => derivedId('trending-shared-realm');
  const result = await f.read();
  expect(result.items).toHaveLength(TRENDING_COST.realmCap);
  expect(result.hasMore).toBe(false);
  expect(result.cursor).toBeNull();
});

for (const filter of ['person', 'realm', 'language', 'follow'] as const) {
  test(`G1034: Trending refills after ${filter} placement rejection`, async () => {
    const f = fixture(12), rejected = f.candidates.slice(0, 7);
    if (filter === 'person' || filter === 'realm') f.state.exclusions = rejected.map(row => ({
      kind: filter, target: filter === 'realm' ? f.state.realm(row.work) : f.state.actor(row.work), strength: 'mute',
    }));
    if (filter === 'language') {
      const ids = new Set(rejected.map(row => row.work));
      f.state.language = work => ids.has(work) ? 'fr' : 'en';
      f.state.contentLanguages = ['en'];
    }
    if (filter === 'follow') f.state.unfollowed = new Set(rejected.map(row => row.work));
    const result = await f.read({ scope: filter === 'follow' ? 'followed' : 'global' });
    expect(result.items.map(item => item.work)).toEqual(f.candidates.slice(7).map(row => row.work));
    expect(result.hasMore).toBe(false);
  });
}

for (const field of ['generation', 'contentSequence', 'contentEpoch', 'reviewPosition'] as const) {
  test(`G1034: Ranking and Trending fence their own ${field} movement during admission`, async () => {
    for (const owner of ['ranking', 'trending'] as const) {
      const f = fixture(7);
      f.state.onSeek = () => { f.state.checkpoint[field] = field === 'generation'
        ? '00000000-0000-4000-8000-000000000002' : '2'; };
      const operation = owner === 'trending' ? f.read() : readRankings(f.session({ limit: 3 }), f.projection,
        { realm: null, metric: 'reads', interval: 'week', order: 'growth' });
      if (owner === 'ranking' && (field === 'contentSequence' || field === 'reviewPosition'))
        await expect(operation).resolves.toMatchObject({ count: { kind: 'exact-page' } });
      else await expect(operation).rejects.toBeInstanceOf(WorkReadMoved);
    }
  });
}

for (const field of ['personalRevision', 'followsRevision'] as const) {
  test(`G1034: Trending rejects real ${field} movement within a page`, async () => {
    const f = fixture(7);
    f.state.onSeek = () => { f.state[field] = '2'; };
    await expect(f.read()).rejects.toBeInstanceOf(WorkReadMoved);
  });
}

test('Trending retains admitted candidates across unrelated graph sequence movement', async () => {
  const f = fixture(7);
  f.state.onSeek = () => { f.state.graphSequence = '2'; };
  const page = await f.read();
  expect(page.items.map(item => item.work)).toEqual(f.candidates.slice(0, TRENDING_COST.items).map(item => item.work));
  expect(page.hasMore).toBe(true);
  const continued = await f.read({ scope: 'global', cursor: page.cursor! });
  expect([...page.items, ...continued.items].map(item => item.work)).toEqual(f.candidates.map(item => item.work));
  expect(continued.hasMore).toBe(false);
});

for (const dependency of ['scope', 'window', 'preferences', 'follows', 'principal', 'actingSubject'] as const) {
  test(`G1034: Trending continuation binds ${dependency}`, async () => {
    const f = fixture(12);
    const first = await f.read();
    expect(first.hasMore).toBe(true);
    const query: TrendingQuery = { scope: 'global', cursor: first.cursor! };
    let viewer = principal;
    if (dependency === 'scope') query.scope = 'followed';
    if (dependency === 'window') query.window = 'day';
    if (dependency === 'preferences') f.state.personalRevision = 'home-2';
    if (dependency === 'follows') f.state.followsRevision = 'follows-2';
    if (dependency === 'principal') viewer = { ...principal, subject: 'another-reader' };
    const operation = dependency === 'actingSubject' ? new RankingHomeTrendingReader(f.projection).read(
      f.session({ actingSubject: derivedId('trending-other-reader') }),
      { query, principal, agent: derivedId('trending-other-reader') }) : f.read(query, viewer);
    await expect(operation).rejects.toBeInstanceOf(WorkReadInvalid);
  });
}
