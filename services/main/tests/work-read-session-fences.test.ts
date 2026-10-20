import { expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { workReadRoutes } from '../src/routes/work-reads.ts';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { readWorkRating } from '../src/modules/work/read-rating.ts';
import { searchPageRatings } from '../src/modules/search/ratings.ts';
import { applyWorkSearchMutes } from '../src/modules/work/search-presentation.ts';
import { prepareComponent, RV } from '../src/modules/work/activate.ts';
import { GLOBAL_CONTEXT_PROFILE, GLOBAL_OBSERVATION_PROFILE, GLOBAL_RATING_POPULATION,
  GLOBAL_RATING_POPULATION_OWNER, globalRatingDigest } from '../src/modules/rating/global.ts';
import { RATING_LATEST_MEAN_POLICY, RATING_STANDING_CADENCE } from '../src/modules/rating/context.ts';
import { RatingAggregateUnavailable } from '../src/modules/rating/aggregate.ts';
import type { RatingAggregateInventory } from '../src/modules/rating/aggregate-inventory.ts';
import { FusekiClient, fusekiReadBudget, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { WORK_READ_COST } from '../src/modules/work/read-contract.ts';
import { WorkReadSession, WorkReadMoved, WorkReadMissing, WorkReadUnavailable, readDependencyToken,
  workRead, type ReadRow } from '../src/modules/work/read-session.ts';
import { AccountAssertionDenied } from '../src/modules/account/verify-assertion.ts';
import { SerialStatisticsProjection } from '../src/modules/work/serial-projection.ts';
import { selectedSerialFixture } from './serial-selected-fixture.ts';
import { withSearchGraphSnapshot } from '../src/modules/search/snapshot.ts';
import { SearchIndexUnavailable, SearchSnapshotMoved } from '../src/modules/work/search-readiness.ts';
import { DEFAULT_MEDIA_CONTEXT, type AvatarRow } from '../src/modules/media/store.ts';
import { readWorkHeader } from '../src/modules/work/read-header.ts';
import { readRealmThreads } from '../src/modules/realm-reply/thread-read.ts';
import { configureDisclosure } from '../src/modules/disclosure/read.ts';
import { configureFixtureDisclosureAncestry, fixtureDisclosureReader } from './support/disclosure-ancestry.ts';
import { realm as threadRealm, world as threadWorld } from './support/realm-thread-world.ts';

const id = (number: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const work = id(1), realm = id(2), actor = id(3);
const term = (value: string, type = 'literal') => ({ type, value });
const result = (bindings: ReadRow[]): SparqlResult => ({ results: { bindings } });
const selected = 'SELECT ?head ?structure ?main ?publication WHERE { VALUES ?work { <' + work + '> } }';

function fixture() {
  const state = { epoch: 'epoch', sequence: 1, calls: 0, head: id(10), structure: id(11),
    main: id(12), publication: id(13), title: 'Shown title', public: true, erased: false,
    mediaEpoch: 'media', mediaSequence: 1, mediaRows: new Map<string, AvatarRow>(), membership: 'proof',
    realmVisibility: 'private', active: true, recovery: true, recoveryChecks: 0 };
  const graph = new class extends FusekiClient {
    constructor() { super('http://graph.invalid/rezics'); }
    override async query(query: string): Promise<SparqlResult> {
      state.calls++;
      const control = { epoch: term(state.epoch), sequence: term(String(state.sequence)) };
      if (query.includes('SELECT ?space ?realmRevision')) return result([{ space: term(id(4), 'uri'),
        disclosure: term(`https://rezics.com/vocab/${state.realmVisibility === 'private' ? 'Private' : 'Public'}`, 'uri'),
        visibility: term(state.realmVisibility), mode: term('mandatory'), head: term(id(14), 'uri') }]);
      if (query.includes('SELECT ?epoch ?sequence ?hold ?r')) return result(state.erased ? [control] : [{
        ...control, r: term(work, 'uri'), type: term('work'), work: term(work, 'uri'),
        head: term(state.head, 'uri'), public: term(String(state.public)),
        label: { ...term(state.title), 'xml:lang': 'en' } }]);
      if (query.includes('SELECT ?epoch ?sequence')) return result([control]);
      if (query.includes('SELECT ?resource ?head')) return result([{ resource: term(work, 'uri'), head: term(state.head, 'uri') }]);
      if (query.includes(selected)) return result(state.erased ? [] : [{
        head: term(state.head, 'uri'), structure: term(state.structure, 'uri'),
        main: term(state.main, 'uri'), publication: term(state.publication, 'uri') }]);
      throw new Error(`Unexpected selected read: ${query}`);
    }
  }();
  const deps = { environment: { fuseki: graph, lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' },
    objectDirectory: '.temp/work-read-session-fences' },
  account: { verify: async () => ({ issuer: 'account', subject: 'reader' }) },
  access: { activePrincipalId: async () => state.active ? 'reader' : null,
    canReadWork: async () => state.public, realmReadProof: async () => state.membership,
    assertRecoveryOpen: async () => { state.recoveryChecks++; if (!state.recovery) throw new WorkReadUnavailable('Recovery hold'); } },
  media: { store: { avatarRows: async () => ({ rows: new Map(state.mediaRows),
    generation: { dataEpoch: state.mediaEpoch, sequence: String(state.mediaSequence) } }) } },
  } as unknown as MainWorkDependencies;
  configureFixtureDisclosureAncestry(deps.environment, target => target.work
    ? { resource: target.work, head: state.head, protectedRevision: target.workRevision } : undefined);
  configureDisclosure(deps.environment, fixtureDisclosureReader(async targets => targets.map(() => 'visible')));
  return { state, graph, deps, request: new Request('http://main.test/v1/resources/' + work.slice(-36) + '/page') };
}

function headerFixture() {
  const f = fixture();
  const header = { published: false, description: null as string | null, selection: null as string | null,
    profile: 'a'.repeat(64), otherProfile: 'b'.repeat(64),
    stats: { chapterCount: 2, wordCount: 200, lastUpdatedAt: null as string | null },
    unrelatedStats: { chapterCount: 1, wordCount: 20, lastUpdatedAt: null as string | null } };
  const originalQuery = f.graph.query.bind(f.graph);
  f.graph.query = async body => {
    if (body.includes('SELECT ?text WHERE')) {
      f.state.calls++;
      return result(header.description ? [{ text: { ...term(header.description), 'xml:lang': 'en' } }] : []);
    }
    if (body.includes('SELECT ?head ?main ?mainHead')) {
      f.state.calls++;
      return result([{ head: term(f.state.head, 'uri'), main: term(f.state.main, 'uri'),
        mainHead: term(id(19), 'uri'), public: term('true') }]);
    }
    if (body.includes('SELECT ?selection ?language')) {
      f.state.calls++;
      return result(header.selection ? [{ selection: term(header.selection, 'uri'), language: term('en') }] : []);
    }
    if (body.includes('SELECT ?structuredDecision ?structuredSource')) {
      f.state.calls++;
      return result(header.published ? [{ structuredDecision: term(f.state.publication, 'uri'),
        structuredSource: term('urn:rezics:work-source:publication', 'uri'),
        structuredStructure: term(f.state.structure, 'uri'),
        structuredProfile: term(`${RV}RecipeComposition`, 'uri'),
        structuredRevision: term(id(15), 'uri'), structuredGeneration: term(id(16), 'uri'),
        structuredExact: term('true'),
        structuredRoot: term(`urn:rezics:sha256:${'c'.repeat(64)}`, 'uri') }] : []);
    }
    if (body.includes('SELECT ?work ?parent')) {
      f.state.calls++;
      return result([{ work: term(work, 'uri') }]);
    }
    return originalQuery(body);
  };
  f.graph.commandHealth = async () => {
    f.state.calls++;
    return { profiles: { 'work-metadata-v1': header.profile, 'unselected-profile': header.otherProfile } } as never;
  };
  f.deps.serialStats = { batch: async () => new Map([
    [work, { ...header.stats }], [id(200), { ...header.unrelatedStats }],
  ]) } as unknown as SerialStatisticsProjection;
  return { ...f, header };
}

test('an Account without a selected Agent reads the public header with its Account disclosure viewer and no implicit choice', async () => {
  const f = headerFixture(); f.header.selection = id(40);
  let verifications = 0, choices = 0; const viewers: boolean[] = [];
  f.deps.account.verify = async (request, scopes) => {
    expect(request.headers.get('authorization')).toBe('Bearer reader');
    expect(scopes).toEqual(['work:read']); verifications++;
    return { issuer: 'account', subject: 'reader' };
  };
  f.deps.sessionAgents = { readMain: async () => { choices++; return null; }, readSession: async () => { choices++; return null; } } as never;
  configureDisclosure(f.deps.environment, fixtureDisclosureReader(async (targets, viewer) => {
    viewers.push(viewer.signedIn); return targets.map(() => 'visible');
  }));
  const app = new Elysia().use(workReadRoutes(f.deps));
  const response = await app.handle(new Request(`http://main.test/v1/works/${work.slice(-36)}`, { headers: { authorization: 'Bearer reader' } }));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ id: work, selectedLanguage: 'en', publicationState: 'published' });
  expect(verifications).toBe(1); expect(choices).toBe(0);
  expect(viewers.length).toBeGreaterThan(0); expect(viewers.every(Boolean)).toBe(true);
});

test('ordinary Work header dependencies ignore unrelated writes and keep a constant owner fence cost', async () => {
  const costs: number[] = [];
  for (const count of [0, 8, 32]) {
    const f = headerFixture(); let attempts = 0;
    const page = await workRead(f.deps, f.request, {}, async session => {
      attempts++;
      const page = await readWorkHeader(session, work);
      f.state.sequence += count;
      f.state.mediaSequence += count;
      f.header.otherProfile = 'd'.repeat(64);
      f.header.unrelatedStats.wordCount += count;
      return page;
    });
    expect(attempts).toBe(1);
    expect(page).toMatchObject({ publicationState: 'unpublished', selectedLanguage: null,
      chapterCount: 2, wordCount: 200, sourcePosition: { dataEpoch: 'epoch', sequence: '1' } });
    expect(page.sourcePosition).not.toHaveProperty('dependencyToken');
    costs.push(f.state.calls);
  }
  expect(new Set(costs).size).toBe(1);
});

for (const changed of ['publication', 'language', 'profile', 'statistics', 'description'] as const) {
  test(`ordinary Work headers replay a selected ${changed} owner dependency without opting into a local cursor basis`, async () => {
    const f = headerFixture(); let attempts = 0;
    const page = await workRead(f.deps, f.request, {}, async session => {
      attempts++;
      const page = await readWorkHeader(session, work);
      if (attempts === 1) {
        if (changed === 'publication') f.header.published = true;
        else if (changed === 'language') f.header.selection = id(40);
        else if (changed === 'profile') f.header.profile = 'e'.repeat(64);
        else if (changed === 'description') f.header.description = 'Current catalogue synopsis';
        else f.header.stats.wordCount = 500;
      }
      return page;
    });
    expect(attempts).toBe(2);
    expect(f.state.recoveryChecks).toBe(2);
    if (changed === 'publication') expect(page.publicationState).toBe('published');
    if (changed === 'language') expect(page.selectedLanguage).toBe('en');
    if (changed === 'statistics') expect(page.wordCount).toBe(500);
    if (changed === 'description') expect(page.description).toMatchObject({
      value: 'Current catalogue synopsis', language: 'en', basis: 'fallback' });
  });
}

test('a nonempty Realm thread inventory consumes selected root summaries through an ordinary session', async () => {
  const threaded = threadWorld([{ id: 1, author: 1 }]);
  const baseline = threaded.session;
  const originalSummaryQuery = baseline.deps.environment.fuseki.query.bind(baseline.deps.environment.fuseki);
  const graph = new FusekiClient('http://graph.invalid/thread');
  graph.query = async body => body.includes('SELECT ?resource ?head')
    ? result([{ resource: term('https://rezics.com/id/00000000-0000-4000-8000-00000000000b', 'uri'),
      head: term('thread-head', 'uri') }])
    : body.includes('SELECT ?epoch ?sequence ?hold') ? originalSummaryQuery(body) : result(await baseline.query(body, 512));
  const session = new WorkReadSession({ ...baseline.deps,
    environment: { ...baseline.deps.environment, fuseki: graph } }, baseline.request,
  baseline.options, baseline.position);
  configureFixtureDisclosureAncestry(session.deps.environment, target => target.work
    ? { resource: target.work, head: 'thread-head', protectedRevision: target.workRevision } : undefined);
  configureDisclosure(session.deps.environment, fixtureDisclosureReader(async targets => targets.map(() => 'visible')));
  session.realm = baseline.realm.bind(baseline);
  const page = await readRealmThreads(session, threadRealm, { sort: 'new' });
  expect(session.fencesSelectedUnits).toBe(true);
  expect(page.items).toHaveLength(1);
  expect(page.items[0]?.work.title.value).toBe('Rainy Night Bookshop');
  await session.fenceDependencies();
});

test('ordinary reads retain their opening position and a constant fence cost under 0, 8 and 32 unrelated writes', async () => {
  const costs: number[] = [];
  for (const count of [0, 8, 32]) {
    const f = fixture();
    let attempts = 0;
    const page = await workRead(f.deps, f.request, {}, async session => {
      attempts++; expect(session.attemptCount).toBe(1);
      await session.query(selected, 1);
      const summaries = await session.summaries([work]);
      f.state.sequence += count; f.state.mediaSequence += count;
      return { summaries, position: session.position };
    });
    expect(attempts).toBe(1);
    expect(page.position).toEqual({ dataEpoch: 'epoch', sequence: '1' });
    expect(page.summaries[0]?.status).toBe('available');
    costs.push(f.state.calls);
  }
  expect(new Set(costs).size).toBe(1);
});

test('owner qualification can re-pin only an unconsumed first-page basis in the same data epoch', async () => {
  const f = fixture();
  const session = new WorkReadSession(f.deps, f.request, {}, { dataEpoch: 'epoch', sequence: '1' });
  session.repin({ dataEpoch: 'epoch', sequence: '2' });
  expect(session.position).toEqual({ dataEpoch: 'epoch', sequence: '2' });
  expect(() => session.repin({ dataEpoch: 'restored', sequence: '0' })).toThrow(WorkReadMoved);
  await session.query(selected, 1);
  expect(() => session.repin({ dataEpoch: 'epoch', sequence: '3' })).toThrow(WorkReadMoved);
  const continuation = new WorkReadSession(f.deps, f.request, { cursor: 'retained' },
    { dataEpoch: 'epoch', sequence: '1' });
  expect(() => continuation.repin({ dataEpoch: 'epoch', sequence: '2' })).toThrow(WorkReadMoved);
});

test('target query fences exclude their diagnostic dataset sequence but retain the selected row head', async () => {
  const f = fixture();
  f.graph.query = async () => result([{ epoch: term('epoch'), sequence: term(String(f.state.sequence)), head: term(f.state.head) }]);
  let attempts = 0;
  const project = (rows: readonly ReadRow[]) => rows.map(({ sequence: _sequence, ...row }) => row);
  await workRead(f.deps, f.request, {}, async session => {
    attempts++; await session.query(selected, 1, project); f.state.sequence += 32;
  });
  expect(attempts).toBe(1);
  attempts = 0;
  const row = await workRead(f.deps, f.request, {}, async session => {
    attempts++; const [read] = await session.query(selected, 1, project);
    if (attempts === 1) f.state.head = id(54);
    return read;
  });
  expect(attempts).toBe(2); expect(row?.head?.value).toBe(id(54));
});

for (const unit of ['head', 'structure', 'main', 'publication'] as const) {
  test(`an ordinary read replays a changed selected ${unit} and returns its fresh joined basis`, async () => {
    const f = fixture(); let attempts = 0;
    const row = await workRead(f.deps, f.request, {}, async session => {
      attempts++; const [read] = await session.query(selected, 1);
      if (attempts === 1) { f.state[unit] = id(50); f.state.sequence++; }
      return read;
    });
    expect(attempts).toBe(2); expect(row?.[unit]?.value).toBe(id(50));
    expect(f.state.recoveryChecks).toBe(2);
  });
}

for (const change of ['title', 'mediaEpoch', 'erased', 'public'] as const) {
  test(`ordinary summaries fence selected ${change} without a dataset sequence fence`, async () => {
    const f = fixture(); let attempts = 0;
    const page = await workRead(f.deps, f.request, {}, async session => {
      attempts++; const read = await session.summaries([work]);
      if (attempts === 1) {
        if (change === 'title') f.state.title = 'Fresh title';
        else if (change === 'mediaEpoch') f.state.mediaEpoch = 'restored-media';
        else f.state[change] = change === 'erased';
      }
      return read;
    });
    expect(attempts).toBe(2);
    if (change === 'title') expect(page[0]?.status === 'available' && page[0].name.value).toBe('Fresh title');
    if (change === 'erased' || change === 'public') expect(page[0]?.status).toBe('unavailable');
  });
}

test('selected media rows move a read while writes to another avatar and the global media sequence do not', async () => {
  const f = fixture();
  const image = { target: work, context: DEFAULT_MEDIA_CONTEXT, selection: id(40).slice(-36),
    selectionPosition: '1', use: id(41).slice(-36), asset: id(42).slice(-36), crop: null,
    representation: id(43).slice(-36), sha256: 'a'.repeat(64), mediaType: 'image/png',
    width: 400, height: 600, byteLength: 1000, disclosure: 'public', moderation: 'none', lifecycle: 'active',
    availability: 'available', clearance: 'cleared' } as AvatarRow;
  f.state.mediaRows.set(work, image);
  let attempts = 0;
  const page = await workRead(f.deps, f.request, {}, async session => {
    attempts++; const summaries = await session.summaries([work]);
    if (attempts === 1) f.state.mediaRows.set(work, { ...image, selection: id(44).slice(-36) });
    return summaries;
  });
  expect(attempts).toBe(2);
  expect(page[0]?.status === 'available' && page[0].avatar.kind === 'image' && page[0].avatar.selection)
    .toBe(id(44).slice(-36));
  attempts = 0;
  await workRead(f.deps, f.request, {}, async session => {
    attempts++; await session.summaries([work]);
    f.state.mediaRows.set(realm, image); f.state.mediaSequence++;
  });
  expect(attempts).toBe(1);
});

test('Realm membership, policy, principal revocation and recovery close every attempt', async () => {
  const f = fixture();
  const request = new Request(f.request.url, { headers: { authorization: 'Bearer reader' } });
  await expect(workRead(f.deps, request, { actingSubject: actor }, async session => {
    await session.realm(realm); f.state.membership = '';
  })).rejects.toBeInstanceOf(WorkReadMissing);
  f.state.membership = 'proof';
  let attempts = 0;
  await workRead(f.deps, request, { actingSubject: actor }, async session => {
    attempts++; await session.realm(realm);
    if (attempts === 1) f.state.realmVisibility = 'public';
  });
  expect(attempts).toBe(2);
  attempts = 0;
  await expect(workRead(f.deps, request, { actingSubject: actor }, async session => {
    attempts++; await session.query(selected, 1); f.state.head = id(99); f.state.active = false;
  })).rejects.toBeInstanceOf(AccountAssertionDenied);
  expect(attempts).toBe(1);
  f.state.active = true;
  await expect(workRead(f.deps, f.request, {}, async session => {
    await session.query(selected, 1); f.state.recovery = false;
  })).rejects.toBeInstanceOf(WorkReadUnavailable);
});

test('nested presentation sessions contribute their selected dependency fences to the enclosing read', async () => {
  const f = fixture(); let attempts = 0;
  const row = await workRead(f.deps, f.request, {}, async parent => {
    attempts++;
    const child = new WorkReadSession(f.deps, new Request(f.request.url), {}, parent.position);
    const [read] = await child.query(selected, 1);
    if (attempts === 1) f.state.structure = id(55);
    return read;
  });
  expect(attempts).toBe(2); expect(row?.structure?.value).toBe(id(55));
});

test('restore epoch movement remains fenced and moving inventories retain stale semantics', async () => {
  const f = fixture();
  await expect(workRead(f.deps, f.request, {}, async () => { f.state.epoch = 'restored'; }))
    .rejects.toBeInstanceOf(WorkReadUnavailable);
  f.state.epoch = 'epoch';
  const stale = await workRead(f.deps, f.request, { movingGraph: true }, async () => { f.state.sequence++; return false; },
    (_value, session) => session.stale);
  expect(stale).toBe(true);
});

test('dependency tokens include Map and Set contents instead of silently hashing empty objects', () => {
  expect(readDependencyToken(new Map([[work, 'old']]))).not.toBe(readDependencyToken(new Map([[work, 'new']])));
  expect(readDependencyToken(new Set([work]))).not.toBe(readDependencyToken(new Set([realm])));
  expect(readDependencyToken(new Map([[work, 1], [realm, 2]])))
    .toBe(readDependencyToken(new Map([[realm, 2], [work, 1]])));
});

test('the next attempt requires the previous measured HTTP call and byte cost, preserving movement as the cause', async () => {
  for (const dimension of ['calls', 'bytes'] as const) {
    let calls = 0, attempts = 0;
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => {
      calls++; return Response.json(result([{ epoch: term('epoch'), sequence: term('1') }]));
    } });
    const f = fixture();
    f.deps.environment.fuseki = new FusekiClient(`http://127.0.0.1:${server.port}/rezics`);
    const outer = { signal: AbortSignal.timeout(5_000), callsLeft: dimension === 'calls' ? 5 : 100,
      bytesLeft: dimension === 'bytes' ? 450 : 100_000 };
    try {
      const failure = await fusekiReadBudget.run(outer, () => workRead(f.deps, f.request, {}, async () => {
        attempts++;
        await f.deps.environment.fuseki.query('SELECT ?x WHERE {}', WORK_READ_COST.queryBytes);
        await f.deps.environment.fuseki.query('SELECT ?y WHERE {}', WORK_READ_COST.queryBytes);
        throw new WorkReadMoved('Selected publication changed');
      })).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(WorkReadUnavailable);
      expect((failure as Error).cause).toBeInstanceOf(WorkReadMoved);
      expect(attempts).toBe(1); expect(calls).toBe(3);
    } finally { await server.stop(true); }
  }
});

test('selected statistics survive unrelated stream lag; genuinely absent statistics remain incomplete', async () => {
  for (const present of [true, false]) {
    const f = selectedSerialFixture();
    f.state.relayHead = '32'; f.state.projected = present;
    expect((await f.projection.batch([work])).get(work)).toEqual(present
      ? { chapterCount: 2, wordCount: 480, lastUpdatedAt: '2026-10-01T00:00:00.000Z' } : undefined);
  }
});

test('search selected-unit hydration ignores unrelated dataset writes while exact matching cuts remain fenced', async () => {
  const generation = 'urn:rezics:text-index-generation:00000000-0000-4000-8000-000000000001';
  for (const basis of ['selected-units', 'matching-cut'] as const) {
    const f = fixture();
    f.graph.commandHealth = async () => ({ instanceId: '00000000-0000-4000-8000-000000000001',
      publicSearchWriteEpoch: '0', publicSearchWriteActive: false, publicSearchDeltaAvailable: false } as never);
    f.graph.query = async () => result([{ epoch: term('epoch'), sequence: term(String(f.state.sequence)),
      generation: term(generation), population: term('0') }]);
    const read = withSearchGraphSnapshot(f.deps.environment, async () => { f.state.sequence++; return 'shown'; }, basis);
    if (basis === 'selected-units') expect(await read).toBe('shown');
    else await expect(read).rejects.toBeInstanceOf(SearchSnapshotMoved);
  }
});

for (const changed of ['process', 'index-generation', 'uncertainty'] as const) {
  test(`selected search hydration retains its ${changed} fence`, async () => {
    const f = fixture(); let moved = false;
    const generation = 'urn:rezics:text-index-generation:00000000-0000-4000-8000-000000000001';
    f.graph.commandHealth = async () => ({ instanceId: moved && changed === 'process'
      ? '00000000-0000-4000-8000-000000000002' : '00000000-0000-4000-8000-000000000001',
      publicSearchWriteEpoch: '0', publicSearchWriteActive: false, publicSearchDeltaAvailable: false,
      textIndexUncertain: moved && changed === 'uncertainty' } as never);
    f.graph.query = async () => result([{ epoch: term('epoch'), sequence: term(String(f.state.sequence)),
      generation: term(moved && changed === 'index-generation' ? generation + '-fresh' : generation), population: term('0') }]);
    await expect(withSearchGraphSnapshot(f.deps.environment, async () => { moved = true; }, 'selected-units'))
      .rejects.toBeInstanceOf(changed === 'index-generation' ? SearchSnapshotMoved : SearchIndexUnavailable);
  });
}


/** Real aggregate verifier over stubbed graph/Access owners and immutable manifests. */
function ratingFixture() {
  const f = fixture();
  f.state.sequence = 10;
  const directory = resolve('.temp', `work-rating-fences-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  f.deps.environment.objectDirectory = directory;
  const context = id(80), contextRevision = id(81), observation = id(82), slot = 'urn:rezics:rating-slot:' + 'a'.repeat(64);
  const question = 'Selected Work quality', time = '2026-10-01T00:00:00.000Z';
  const contextManifest = prepareComponent(directory, context, { context, populationOwner: GLOBAL_RATING_POPULATION_OWNER,
    question, state: 'active', targetGrain: 'MainVersion', scaleMin: 1, scaleMax: 5,
    cadence: RATING_STANDING_CADENCE, populationPolicy: GLOBAL_RATING_POPULATION,
    aggregationPolicy: RATING_LATEST_MEAN_POLICY }, GLOBAL_CONTEXT_PROFILE);
  const inventory: RatingAggregateInventory = { realm: GLOBAL_RATING_POPULATION_OWNER,
    contextRevision, policyRevision: contextRevision, contextReceipt: 'urn:rezics:receipt:selected-context',
    contextDataEpoch: 'epoch', contextSequence: '1', recoveryGeneration: 'rating-recovery', heads: [] };
  const state = { value: 3, revision: id(83), predecessor: null as string | null, manifest: '',
    digest: '', sequence: '2', graphEpoch: 'epoch', ownerOpen: true, advanceOnAggregate: 0,
    duplicateEvidence: false, inventoryReads: 0, recoveryChecks: 0 };
  const seal = () => {
    state.digest = globalRatingDigest({ context, work, mainVersion: f.state.main, value: state.value,
      expectedRevisionHead: state.predecessor, actingSubject: actor });
    state.manifest = prepareComponent(directory, observation, { observation, slot, context, contextRevision,
      populationOwner: GLOBAL_RATING_POPULATION_OWNER, work, mainVersion: f.state.main,
      revision: state.revision, predecessor: state.predecessor, availability: 'available', value: state.value,
      evaluatedAt: time, submittedAt: time, originalSubmissionAt: time, revisedAt: time }, GLOBAL_OBSERVATION_PROFILE);
    inventory.heads = [{ slot, work, mainVersion: f.state.main, observation, revision: state.revision,
      raterKey: 'selected-rater', evaluatedAt: time, submittedAt: time, actingSubject: actor,
      requestDigest: state.digest, receipt: 'urn:rezics:receipt:selected-observation', dataEpoch: 'epoch', sequence: state.sequence }];
  };
  seal();
  f.deps.access.readRatingAggregateInventory = async () => { state.inventoryReads++; return structuredClone(inventory); };
  f.deps.access.checkRatingAggregateFence = async generation => {
    state.recoveryChecks++; return state.ownerOpen && generation === inventory.recoveryGeneration;
  };
  const query = f.graph.query.bind(f.graph);
  f.graph.query = async sparql => {
    const control = () => ({ epoch: term(f.state.epoch), sequence: term(String(f.state.sequence)) });
    if (sparql.includes('SELECT ?kind ?component ?epoch ?sequence')) {
      f.state.calls++; f.state.sequence += state.advanceOnAggregate;
      const position = { epoch: term(state.graphEpoch), sequence: term(String(f.state.sequence)) };
      const root: ReadRow = { ...position, kind: term('context'), component: term('global'),
        scaleMin: term('1'), scaleMax: term('5'), scaleStep: term('1'),
        owner: term(GLOBAL_RATING_POPULATION_OWNER, 'uri'), contextRevision: term(contextRevision, 'uri'),
        contextManifest: term('urn:rezics:sha256:' + contextManifest, 'uri'),
        question: { ...term(question), 'xml:lang': 'en' }, contextEpoch: term('epoch'), contextSequence: term('1'),
        receipt: term(inventory.contextReceipt, 'uri') };
      const head = inventory.heads[0]!;
      const evidence: ReadRow = { ...position, kind: term('observation'), component: term('global'),
        observation: term(observation, 'uri'), slot: term(slot, 'uri'), head: term(state.revision, 'uri'),
        availability: term(RV + 'Available', 'uri'), value: term(String(state.value)),
        manifest: term('urn:rezics:sha256:' + state.manifest, 'uri'), evaluatedAt: term(time),
        submittedAt: term(time), originalSubmissionAt: term(time), revisedAt: term(time),
        revisionEpoch: term('epoch'), revisionSequence: term(state.sequence), receipt: term(head.receipt, 'uri'),
        digest: term(state.digest), ...(state.predecessor ? { predecessor: term(state.predecessor, 'uri') } : {}) };
      const rows = [root, evidence, ...(state.duplicateEvidence ? [evidence] : [])];
      return result(sparql.includes('SELECT * WHERE')
        ? rows.map(row => ({ ...row, targetWork: term(work, 'uri') })) : rows);
    }
    if (sparql.includes('SELECT ?context WHERE')) {
      f.state.calls++; return result([{ context: term(context, 'uri') }]);
    }
    if (sparql.includes('SELECT ?context ?question')) {
      f.state.calls++; return result([{ context: term(context, 'uri'), question: { ...term(question), 'xml:lang': 'en' } }]);
    }
    if (sparql.includes('SELECT ?main WHERE')) { f.state.calls++; return result([{ main: term(f.state.main, 'uri') }]); }
    if (sparql.includes('SELECT ?epoch ?sequence ?r ?revision')) {
      f.state.calls++; return result([{ ...control(), r: term(work, 'uri'), revision: term(f.state.head, 'uri'),
        type: term('https://schema.org/CreativeWork', 'uri') }]);
    }
    return query(sparql);
  };
  return { ...f, context, rating: state, setValue(value: number) {
    state.predecessor = state.revision; state.revision = id(84); state.value = value;
    state.sequence = String(++f.state.sequence); seal();
  }, close: () => rmSync(directory, { recursive: true, force: true }) };
}

test('selected Work ratings ignore 0, 8 and 32 unrelated writes during aggregate hydration at constant cost', async () => {
  const costs: number[] = [];
  for (const count of [0, 8, 32]) {
    const f = ratingFixture(); f.rating.advanceOnAggregate = count; let attempts = 0;
    try {
      const page = await workRead(f.deps, f.request, {}, session => {
        attempts++; return readWorkRating(session, work, f.context);
      });
      expect(page).toMatchObject({ status: 'available', count: 1, mean: 3,
        sourcePosition: { dataEpoch: 'epoch', sequence: '10' } });
      expect(attempts).toBe(1); expect(f.rating.inventoryReads).toBe(2); expect(f.rating.recoveryChecks).toBe(2);
      costs.push(f.state.calls);
    } finally { f.close(); }
  }
  expect(new Set(costs).size).toBe(1);
});

test('a selected aggregate change replays the Work rating and returns fresh sealed evidence', async () => {
  const f = ratingFixture(); let attempts = 0;
  try {
    const page = await workRead(f.deps, f.request, {}, async session => {
      attempts++; const page = await readWorkRating(session, work, f.context);
      if (attempts === 1) f.setValue(5);
      return page;
    });
    expect(attempts).toBe(2); expect(page).toMatchObject({ count: 1, mean: 5 });
  } finally { f.close(); }
});

for (const failure of ['owner-recovery', 'duplicate-evidence'] as const) {
  test(`a selected rating ${failure} failure refuses the hydrated Work result`, async () => {
    const f = ratingFixture();
    try {
      await expect(workRead(f.deps, f.request, {}, async session => {
        const page = await readWorkRating(session, work, f.context);
        if (failure === 'owner-recovery') f.rating.ownerOpen = false;
        else f.rating.duplicateEvidence = true;
        return page;
      })).rejects.toBeInstanceOf(RatingAggregateUnavailable);
    } finally { f.close(); }
  });
}

test('the selected rating adapter retains its source recovery epoch fence', async () => {
  const f = ratingFixture(); f.rating.graphEpoch = 'foreign-epoch';
  try {
    await expect(workRead(f.deps, f.request, {}, session => readWorkRating(session, work, f.context)))
      .rejects.toBeInstanceOf(WorkReadUnavailable);
  } finally { f.close(); }
});

test('selected rating previews ignore unrelated writes during batch hydration at constant cost', async () => {
  const costs: number[] = [];
  for (const count of [0, 8, 32]) {
    const f = ratingFixture(); f.rating.advanceOnAggregate = count; let attempts = 0;
    try {
      const page = await workRead(f.deps, f.request, {}, async session => {
        attempts++;
        return { ...await searchPageRatings(session, [{ work, mainVersion: f.state.main }]),
          sourcePosition: session.position };
      });
      expect(attempts).toBe(1); expect(page.values.get(work)).toMatchObject({ count: 1, mean: 3 });
      expect(page.unavailable.size).toBe(0); expect(page.sourcePosition.sequence).toBe('10');
      expect(f.rating.inventoryReads).toBe(2); expect(f.rating.recoveryChecks).toBe(2);
      costs.push(f.state.calls);
    } finally { f.close(); }
  }
  expect(new Set(costs).size).toBe(1);
});

test('a selected rating preview change replays its page and returns the fresh aggregate', async () => {
  const f = ratingFixture(); let attempts = 0;
  try {
    const page = await workRead(f.deps, f.request, {}, async session => {
      attempts++; const page = await searchPageRatings(session, [{ work, mainVersion: f.state.main }]);
      if (attempts === 1) f.setValue(5);
      return page;
    });
    expect(attempts).toBe(2); expect(page.values.get(work)).toMatchObject({ count: 1, mean: 5 });
  } finally { f.close(); }
});

for (const available of [true, false]) {
  test(`rating preview availability becoming ${available} participates in the selected batch fence`, async () => {
    const f = ratingFixture(); f.rating.duplicateEvidence = available; let attempts = 0;
    try {
      const page = await workRead(f.deps, f.request, {}, async session => {
        attempts++; const page = await searchPageRatings(session, [{ work, mainVersion: f.state.main }]);
        if (attempts === 1) f.rating.duplicateEvidence = !available;
        return page;
      });
      expect(attempts).toBe(2); expect(page.values.has(work)).toBe(available);
      expect(page.unavailable.has(work)).toBe(!available);
    } finally { f.close(); }
  });
}

function authorMuteFixture() {
  const f = fixture();
  const contribution = id(90), muted = id(91);
  const state = { author: id(92) };
  const generation = 'urn:rezics:text-index-generation:00000000-0000-4000-8000-000000000001';
  f.graph.commandHealth = async () => ({ instanceId: '00000000-0000-4000-8000-000000000001',
    publicSearchWriteEpoch: '0', publicSearchWriteActive: false, publicSearchDeltaAvailable: false } as never);
  const query = f.graph.query.bind(f.graph);
  f.graph.query = async sparql => {
    const control = { epoch: term(f.state.epoch), sequence: term(String(f.state.sequence)) };
    if (sparql.includes('SELECT ?epoch ?sequence ?contribution ?author')) {
      f.state.calls++; return result([{ ...control, contribution: term(contribution, 'uri'), author: term(state.author, 'uri') }]);
    }
    if (sparql.includes('SELECT ?epoch ?sequence ?generation')) {
      f.state.calls++; return result([{ ...control, generation: term(generation), population: term('1') }]);
    }
    return query(sparql);
  };
  const relation = { results: [{ contribution }], total: 1, context: 'main-version-default' as const,
    sourcePosition: { dataEpoch: 'epoch', sequence: '1' } };
  const mutes = [{ targetKind: 'agent' as const, target: muted, match: 'author' as const }];
  const present = () => applyWorkSearchMutes(f.deps.environment, relation, mutes, async () => new Map<string, string[]>());
  return { ...f, author: state, muted, present, relation, mutes };
}

test('selected author mute hydration ignores unrelated dataset writes without replaying its page', async () => {
  const costs: number[] = [];
  for (const count of [0, 8, 32]) {
    const f = authorMuteFixture(); let attempts = 0;
    const page = await withSearchGraphSnapshot(f.deps.environment, () => workRead(f.deps, f.request, {}, async session => {
      attempts++; f.state.sequence += count;
      const visible = await f.present();
      session.observeDependency('selected-author-mutes', visible, f.present);
      return visible;
    }), 'selected-units');
    expect(page.results).toHaveLength(1); expect(attempts).toBe(1);
    expect(page.sourcePosition.sequence).toBe('1'); costs.push(f.state.calls);
  }
  expect(new Set(costs).size).toBe(1);
});

test('a changed selected author that becomes muted replays presentation and withholds the result', async () => {
  const f = authorMuteFixture(); let attempts = 0;
  const page = await withSearchGraphSnapshot(f.deps.environment, () => workRead(f.deps, f.request, {}, async session => {
    attempts++; const visible = await f.present();
    session.observeDependency('selected-author-mutes', visible, f.present);
    if (attempts === 1) { f.author.author = f.muted; f.state.sequence++; }
    return visible;
  }), 'selected-units');
  expect(attempts).toBe(2); expect(page.results).toEqual([]); expect(page.total).toBe(0);
});

test('exact matching cuts retain author hydration sequence admission', async () => {
  const f = authorMuteFixture();
  await expect(withSearchGraphSnapshot(f.deps.environment, async () => {
    f.state.sequence++; return f.present();
  }, 'matching-cut')).rejects.toThrow('search author hydration crossed graph positions');
});

test('selected mute hydration relaxation is confined to its qualified graph lineage', async () => {
  const f = authorMuteFixture();
  await expect(withSearchGraphSnapshot(f.deps.environment, async () => {
    f.state.sequence++;
    const environment = { ...f.deps.environment,
      lineage: { ...f.deps.environment.lineage, routingEpoch: 'foreign-routing' } };
    return applyWorkSearchMutes(environment, f.relation, f.mutes, async () => new Map<string, string[]>());
  }, 'selected-units')).rejects.toThrow('search author hydration crossed graph positions');
});
