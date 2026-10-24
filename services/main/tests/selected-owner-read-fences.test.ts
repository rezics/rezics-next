import { configureDisclosure } from '../src/modules/disclosure/read.ts';
import { configureFixtureDisclosureAncestry, fixtureDisclosureReader } from './support/disclosure-ancestry.ts';
import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { Parser } from 'n3';
import { FusekiClient, fusekiReadBudget, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { WorkReadMoved, WorkReadSession, WorkReadUnavailable, workRead, type ReadRow }
  from '../src/modules/work/read-session.ts';
import { readFollowTarget } from '../src/modules/follows/read.ts';
import { resolveClassifications } from '../src/modules/classification/resolve.ts';
import { CLASSIFICATION_INHERIT_POLICY, GLOBAL_CLASSIFICATION_CONTEXT } from '../src/modules/classification/context.ts';
import { readSearchDecisionSupports } from '../src/modules/work/search-supports.ts';
import { readWorkClassificationBatch } from '../src/modules/work/read-classifications.ts';
import { CLASSIFIED_AS, statementMeaningKey } from '../src/modules/statement/schema.ts';
import { CLASSIFICATION_PROPOSITION_PROFILE } from '../src/modules/classification/proposition.ts';
import { readRecipePreviewGrant, readRecipePreviewStructure } from '../src/modules/recipe/work-page.ts';
import { boundedReadingPositionRead } from '../src/modules/reading-position/read.ts';
import { AccountAssertionDenied } from '../src/modules/account/verify-assertion.ts';
import { ReadingBoundary } from '../src/modules/reading-position/boundary.ts';
import { readWikiHistory } from '../src/modules/wiki/history-read.ts';
import { readMergedIdentity } from '../src/modules/identity-merge/resolution.ts';
import { prepareComponent, RV } from '../src/modules/work/activate.ts';
import { ownedTriples, type DefinitionState } from '../src/modules/semantic/change.ts';
import { PROFILES, definitionKindIri } from '../src/modules/semantic/schema.ts';
import { COLLECTION_PURPOSE_NOTATION } from '../src/modules/statement/qualification.ts';
import { readResourceRelations } from '../src/modules/relation/traversal.ts';
import type { ResourceSummary } from '../src/modules/media/summary.ts';
import { readPageRelationSummaries } from '../src/modules/entity-page/relations.ts';
import { queryRatingRollup, type RollupReader } from '../src/modules/rating/rollup-read.ts';
import { TARGET_CONTEXT_PROFILE } from '../src/modules/rating/target.ts';
import { RATING_ACCOUNT_POPULATION, RATING_LATEST_MEAN_POLICY, RATING_STANDING_CADENCE }
  from '../src/modules/rating/context.ts';
import type { TargetRatingInventoryStore } from '../src/modules/rating/target-inventory.ts';
import type { TargetRatingComponents } from '../src/modules/rating/aggregate-inventory.ts';

const directory = mkdtempSync('.temp/selected-owner-read-fences-');
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const work = id(1), main = id(2), sense = id(3), realm = id(4), space = id(5), agent = id(6);
const term = (value: string, type = 'literal') => ({ type, value });
const result = (bindings: ReadRow[]): SparqlResult => ({ results: { bindings } });
const principal = { issuer: 'account', subject: 'reader', emailVerified: true };

function ownerFixture(read: (query: string) => SparqlResult | undefined) {
  const state = { sequence: 1, epoch: 'epoch', calls: 0, hold: false, active: true, recovery: true };
  const heads = new Map<string, string>();
  const graph = new FusekiClient('http://graph.invalid/selected-owners');
  graph.query = async query => {
    state.calls++;
    if (query.includes('ASK')) return { boolean: !state.hold };
    const selected = read(query);
    if (selected) {
      for (const row of selected.results?.bindings ?? [])
        if (row.work && row.head) heads.set(row.work.value, row.head.value);
      return selected;
    }
    if (query.includes('SELECT ?resource ?head') || query.includes('SELECT ?work ?head')) {
      const variable = query.includes('SELECT ?resource ?head') ? 'resource' : 'work';
      const refs = [...(/VALUES \?\w+ \{([^}]*)\}/.exec(query)?.[1] ?? '').matchAll(/<([^>]+)>/g)]
        .map(match => match[1]!);
      return result(refs.map(resource => ({ [variable]: term(resource, 'uri'),
        head: term(heads.get(resource) ?? id(10), 'uri') })));
    }
    if (query.includes('SELECT ?epoch ?sequence')) return result(state.hold ? [] : [{
      epoch: term(state.epoch), sequence: term(String(state.sequence)),
    }]);
    throw new Error(`Unexpected owner query: ${query}`);
  };
  const deps = { environment: { fuseki: graph, lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' },
    objectDirectory: '.temp/selected-owner-read-fences' },
    access: { activePrincipalId: async () => state.active ? 'reader' : null,
      assertRecoveryOpen: async () => { if (!state.recovery) throw new WorkReadUnavailable('Recovery hold'); } },
  } as unknown as MainWorkDependencies;
  configureFixtureDisclosureAncestry(deps.environment, target => {
    if (!target.work) return undefined;
    const head = heads.get(target.work) ?? target.workRevision ?? id(10);
    heads.set(target.work, head);
    return { resource: target.work, head, protectedRevision: target.workRevision };
  });
  configureDisclosure(deps.environment, fixtureDisclosureReader(async targets => targets.map(() => 'visible')));
  const request = new Request('http://main.test/v1/selected-owners');
  return { state, graph, deps, request,
    session: () => new WorkReadSession(deps, request, {}, { dataEpoch: 'epoch', sequence: '1' }) };
}

test('land review 7: ordinary classification resolution ignores dataset drift and fences the selected decision', async () => {
  let decision = id(10), outcome = `${RV}Accepted`, f: ReturnType<typeof ownerFixture>;
  f = ownerFixture(query => {
    const control = { epoch: term(f.state.epoch), sequence: term(String(f.state.sequence)) };
    if (query.includes('SELECT ?work ?main ?sense')) {
      f.state.sequence++;
      return result([{ ...control, work: term(work, 'uri'), main: term(main, 'uri'), sense: term(sense, 'uri'),
        context: term(GLOBAL_CLASSIFICATION_CONTEXT, 'uri'), senseRevision: term(id(11), 'uri'), concept: term(id(12), 'uri') }]);
    }
    if (query.includes('SELECT ?index ?epoch')) return result([{ ...control, index: term('0'),
      globalApplication: term(id(13), 'uri'), globalDecision: term(decision, 'uri'), globalOutcome: term(outcome, 'uri') }]);
  });
  let attempts = 0;
  const page = await workRead(f.deps, f.request, {}, async session => {
    attempts++;
    return resolveClassifications(f.deps.environment, [{ work, mainVersion: main, sense, context: { kind: 'global' } }],
      session.position, session);
  });
  expect(attempts).toBe(1);
  expect(page[0]).toMatchObject({ state: 'accepted', decision, sourcePosition: { dataEpoch: 'epoch', sequence: '1' } });
  const session = f.session();
  await resolveClassifications(f.deps.environment, [{ work, mainVersion: main, sense, context: { kind: 'global' } }], session.position, session);
  decision = id(14); outcome = `${RV}Rejected`;
  await expect(session.fenceDependencies()).rejects.toBeInstanceOf(WorkReadMoved);
});

test('land review 7: selected classification supports retain Statement head fences without a dataset cut', async () => {
  const support = id(15), decision = id(16), meaningKey = 'urn:rezics:meaning:fixture'; let head = id(17);
  let f: ReturnType<typeof ownerFixture>;
  f = ownerFixture(query => {
    const control = { epoch: term('epoch'), sequence: term(String(f.state.sequence)) };
    if (query.includes('SELECT ?epoch ?sequence ?main ?decision')) {
      f.state.sequence++;
      return result([{ ...control, main: term(main, 'uri'), decision: term(decision, 'uri'), support: term(support, 'uri') }]);
    }
    if (query.includes('GROUP_CONCAT') && query.includes('?statement')) return result([{ ...control,
      statement: term(support, 'uri'), subject: term(main, 'uri'), predicate: term(`${RV}classifiedAs`, 'uri'),
      object: term(id(18), 'uri'), relation: term('https://rezics.com/definition/classification-proposition-v1', 'uri'),
      speaker: term(agent, 'uri'), key: term(meaningKey, 'uri'), head: term(head, 'uri') }]);
  });
  const candidates = [{ mainVersion: main, meaningKey, decision, sourceContext: GLOBAL_CLASSIFICATION_CONTEXT }];
  let attempts = 0;
  const supports = await workRead(f.deps, f.request, {}, async session => {
    attempts++; return readSearchDecisionSupports(f.deps.environment, session.position, candidates, session);
  });
  expect(attempts).toBe(1); expect(supports.get(`${main}\0${decision}`)).toEqual([support]);
  const session = f.session(); await readSearchDecisionSupports(f.deps.environment, session.position, candidates, session);
  head = id(19);
  await expect(session.fenceDependencies()).rejects.toBeInstanceOf(WorkReadMoved);
});

for (const changed of ['lookahead', 'protection'] as const) {
  test(`land review 7: classification pages fence selected Judgment protection and ignore a ${changed === 'lookahead' ? 'lookahead payload edit' : 'hidden result payload'}`, async () => {
    const concept = id(60), senseRevision = id(61), decision = id(62), support = id(63);
    const meaning = statementMeaningKey({ subject: main, predicate: CLASSIFIED_AS,
      relationDefinition: CLASSIFICATION_PROPOSITION_PROFILE, interpretationDefinitions: [senseRevision],
      value: { kind: 'resource', iri: concept }, applicability: [] });
    let lookaheadRevision = id(64), protection = 'show-all', f: ReturnType<typeof ownerFixture>;
    f = ownerFixture(query => {
      const control = { epoch: term('epoch'), sequence: term(String(f.state.sequence)) };
      if (query.includes('SELECT ?work ?sense ?revision')) return result([
        { work: term(work, 'uri'), sense: term(sense, 'uri'), revision: term(senseRevision, 'uri'), concept: term(concept, 'uri') },
        { work: term(work, 'uri'), sense: term(id(65), 'uri'), revision: term(lookaheadRevision, 'uri'), concept: term(id(66), 'uri') },
      ]);
      if (query.includes('SELECT ?work ?main ?sense')) return result([{ ...control, work: term(work, 'uri'),
        main: term(main, 'uri'), sense: term(sense, 'uri'), context: term(GLOBAL_CLASSIFICATION_CONTEXT, 'uri'),
        senseRevision: term(senseRevision, 'uri'), concept: term(concept, 'uri') }]);
      if (query.includes('SELECT ?index ?epoch')) return result([{ ...control, index: term('0'),
        globalApplication: term(id(67), 'uri'), globalDecision: term(decision, 'uri'), globalOutcome: term(`${RV}Accepted`, 'uri') }]);
      if (query.includes('SELECT ?epoch ?sequence ?main ?decision')) return result([{ ...control,
        main: term(main, 'uri'), decision: term(decision, 'uri'), support: term(support, 'uri') }]);
      if (query.includes('GROUP_CONCAT') && query.includes('?statement')) return result([{ ...control,
        statement: term(support, 'uri'), subject: term(main, 'uri'), predicate: term(CLASSIFIED_AS, 'uri'),
        object: term(concept, 'uri'), relation: term(CLASSIFICATION_PROPOSITION_PROFILE, 'uri'), speaker: term(agent, 'uri'),
        key: term(meaning, 'uri'), head: term(id(68), 'uri') }]);
      if (query.includes('SELECT ?epoch ?sequence ?hold ?r')) return result([{ ...control,
        r: term(concept, 'uri'), type: term('concept'), public: term('true'),
        label: { ...term('Selected classification'), 'xml:lang': 'en' } }]);
    });
    f.deps.judgments = { protectionChecks: async () => [{ protection }] } as unknown as MainWorkDependencies['judgments'];
    let attempts = 0;
    const page = await workRead(f.deps, f.request, { limit: 1 }, async session => {
      attempts++;
      const result = await readWorkClassificationBatch(session, [{ work, mainVersion: main }]);
      if (attempts === 1) {
        if (changed === 'lookahead') lookaheadRevision = id(69); else protection = 'hide-any';
      }
      return result;
    });
    expect(attempts).toBe(changed === 'lookahead' ? 1 : 2);
    expect(page.get(work)?.items.length).toBe(changed === 'lookahead' ? 1 : 0);
    expect(page.get(work)?.after).toBe(sense);
  });
}

for (const changed of ['mapping', 'head'] as const) {
  test(`land review 12: private recipe previews replay a changed Structure ${changed}`, async () => {
    let structure = id(20), head = id(21);
    const f = ownerFixture(query => {
      if (query.includes('SELECT ?structure WHERE')) return result([{ structure: term(structure, 'uri') }]);
      if (query.includes('SELECT ?component ?profile ?head')) return result([{
        component: term(main, 'uri'), profile: term(`${RV}RecipeComposition`, 'uri'), head: term(head, 'uri'),
        generation: term(id(22), 'uri'), count: term('0'), manifest: term(`urn:rezics:sha256:${'a'.repeat(64)}`, 'uri'),
      }]);
      if (query.includes('SELECT ?owner WHERE')) return result([{ owner: term(work, 'uri') }]);
    });
    let attempts = 0;
    const selected = await workRead(f.deps, f.request, {}, async session => {
      attempts++;
      const selected = await readRecipePreviewStructure(session, main);
      if (attempts === 1) {
        if (changed === 'mapping') structure = id(23); else head = id(24);
      }
      return selected;
    });
    expect(attempts).toBe(2);
    expect(selected?.structure).toBe(structure);
    expect(selected?.header?.head).toBe(head);
  });
}

test('land review 12: unrelated writes do not change the private preview selection or its bounded cost', async () => {
  const calls: number[] = [];
  for (const drift of [0, 10, 100]) {
    const f = ownerFixture(query => {
      if (query.includes('SELECT ?structure WHERE')) return result([{ structure: term(id(20), 'uri') }]);
      if (query.includes('SELECT ?component ?profile ?head')) return result([{ component: term(main, 'uri'),
        profile: term(`${RV}RecipeComposition`, 'uri'), head: term(id(21), 'uri'), generation: term(id(22), 'uri'),
        count: term('0'), manifest: term(`urn:rezics:sha256:${'a'.repeat(64)}`, 'uri') }]);
      if (query.includes('SELECT ?owner WHERE')) return result([{ owner: term(work, 'uri') }]);
    });
    let attempts = 0;
    await workRead(f.deps, f.request, {}, async session => {
      attempts++; const selected = await readRecipePreviewStructure(session, main);
      f.state.sequence += drift; return selected;
    });
    expect(attempts).toBe(1); calls.push(f.state.calls);
  }
  expect(new Set(calls).size).toBe(1);
});

test('land review 12: a public Work cannot retain private Recipe preview authority after its grant is revoked', async () => {
  const f = ownerFixture(() => undefined); let allowed = true;
  f.deps.access.canPreviewWork = async () => allowed;
  const session = new WorkReadSession(f.deps, f.request, { actingSubject: agent }, { dataEpoch: 'epoch', sequence: '1' });
  session.principal = principal;
  expect(await readRecipePreviewGrant(session, work)).toBe(true);
  allowed = false;
  await expect(session.fenceDependencies()).rejects.toBeInstanceOf(WorkReadMoved);
  const fresh = new WorkReadSession(f.deps, f.request, { actingSubject: agent }, { dataEpoch: 'epoch', sequence: '1' });
  fresh.principal = principal;
  expect(await readRecipePreviewGrant(fresh, work)).toBe(false);
});

test('land review 9: the independent reading-position envelope ignores unrelated writes and retries selected rows', async () => {
  let head = id(30);
  const f = ownerFixture(query => query.includes('# selected-reading-row') ? result([{ head: term(head, 'uri') }]) : undefined);
  let attempts = 0;
  const value = await boundedReadingPositionRead(f.deps, f.request, null, undefined, async boundary => {
    attempts++;
    const [row] = await boundary.session.query('SELECT ?head WHERE { # selected-reading-row\n }', 1);
    f.state.sequence += 10;
    if (attempts === 1) head = id(31);
    return row!.head!.value;
  });
  expect(attempts).toBe(2); expect(value).toBe(id(31));
});

for (const revoked of ['principal', 'recovery'] as const) {
  test(`land review 9: independent reading-position delivery closes ${revoked} authority even on movement`, async () => {
    let head = id(30);
    const f = ownerFixture(query => query.includes('# selected-reading-row') ? result([{ head: term(head, 'uri') }]) : undefined);
    let attempts = 0;
    const read = boundedReadingPositionRead(f.deps, f.request, principal, agent, async boundary => {
      attempts++; await boundary.session.query('SELECT ?head WHERE { # selected-reading-row\n }', 1);
      head = id(31);
      if (revoked === 'principal') f.state.active = false; else f.state.recovery = false;
      return 'stale';
    });
    await expect(read).rejects.toBeInstanceOf(revoked === 'principal' ? AccountAssertionDenied : WorkReadUnavailable);
    expect(attempts).toBe(1);
  });
}

test('land review 9: an independent reading-position read refuses an opening restore hold', async () => {
  const f = ownerFixture(() => undefined); f.state.hold = true; let called = false;
  await expect(boundedReadingPositionRead(f.deps, f.request, null, undefined, async () => { called = true; }))
    .rejects.toBeInstanceOf(WorkReadUnavailable);
  expect(called).toBe(false);
});

for (const exhausted of ['calls', 'bytes'] as const) {
  test(`land review 9: a reading-position retry requires room for its measured ${exhausted}`, async () => {
    let head = id(30), attempts = 0;
    const server = Bun.serve({ port: 0, fetch: async request => {
      const body = await request.text();
      return Response.json(result(body.includes('selected-reading-row')
        ? [{ head: term(head, 'uri'), payload: term(exhausted === 'bytes' ? 'x'.repeat(300_000) : '') }]
        : [{ epoch: term('epoch'), sequence: term('1') }]));
    } });
    const f = ownerFixture(() => undefined);
    f.deps.environment.fuseki = new FusekiClient(`http://127.0.0.1:${server.port}/graph`);
    try {
      await expect(fusekiReadBudget.run({ signal: AbortSignal.timeout(10_000), callsLeft: exhausted === 'calls' ? 80 : 160,
        bytesLeft: exhausted === 'bytes' ? 700_000 : 4 * 1024 * 1024 }, () =>
        boundedReadingPositionRead(f.deps, f.request, null, undefined, async boundary => {
          attempts++;
          for (let i = 0; i < (exhausted === 'calls' ? 41 : 1); i++)
            await boundary.session.query('SELECT ?head ?payload WHERE { # selected-reading-row\n }', 1);
          head = id(31);
          return 'stale';
        }))).rejects.toBeInstanceOf(WorkReadUnavailable);
      expect(attempts).toBe(1);
    } finally { await server.stop(true); }
  });
}

test('land review 8: selected relation pages ignore dataset drift and fence delivered counterparts', async () => {
  const collection = id(40); let name = 'Selected collection';
  const definition = id(70), revision = id(71);
  const state: DefinitionState = { component: 'definition', kind: 'property', lifecycle: 'active',
    successor: null, roles: [], notation: COLLECTION_PURPOSE_NOTATION };
  const manifest = `urn:rezics:sha256:${prepareComponent(directory, definition, state, PROFILES.definition)}`;
  // Supply the actual purpose owner's read prerequisites, without replacing
  // its current authority, canonical Structure or bounded absence checks.
  const f = ownerFixture(query => {
    if (query.includes('SELECT DISTINCT ?relation ?kind ?key')) return result([{ relation: term(collection, 'uri'),
      kind: term('collection'), key: term(`collection:${collection}`) }]);
    if (query.includes('SELECT ?epoch ?sequence ?hold ?r')) return result([{
      epoch: term('epoch'), sequence: term(String(f.state.sequence)), r: term(collection, 'uri'),
      type: term('collection'), public: term('true'), label: { ...term(name), 'xml:lang': 'en' },
    }]);
    if (query.includes('SELECT ?structure WHERE')) return result([{ structure: term(id(72), 'uri') }]);
    if (query.includes('SELECT ?component ?profile ?head ?generation ?count ?manifest')) return result([{
      component: term(collection, 'uri'), profile: term(`${RV}CollectionMembership`, 'uri'), head: term(id(73), 'uri'),
      generation: term(id(74), 'uri'), count: term('1'), manifest: term(`urn:rezics:sha256:${'a'.repeat(64)}`, 'uri'),
    }]);
    if (query.includes('SELECT ?owner WHERE')) return result([{ owner: term(collection, 'uri') }]);
    if (query.includes('SELECT ?definition ?head')) return result([{ definition: term(definition, 'uri'), head: term(revision, 'uri') }]);
    if (query.includes('SELECT ?definition ?manifest ?kind')) return result([{
      definition: term(definition, 'uri'), manifest: term(manifest, 'uri'), kind: term(definitionKindIri('property'), 'uri'),
    }]);
    if (query.includes('SELECT ?head ?manifest')) return result([{ head: term(revision, 'uri'), manifest: term(manifest, 'uri') }]);
    if (query.includes('SELECT ?p ?o')) return result(new Parser()
      .parse(ownedTriples(definition, state, revision).map(triple => `<${definition}> ${triple} .`).join('\n'))
      .map(quad => ({ p: term(quad.predicate.value, 'uri'), o: term(quad.object.value, 'uri') })));
    if (query.includes('SELECT ?policy ?realm')) return result([{ policy: term(CLASSIFICATION_INHERIT_POLICY, 'uri') }]);
    if (query.includes('?neighbourScore') && query.includes(`rdf:subject <${collection}>`)
      && query.includes(`FILTER(?predicate = <${definition}>)`)) return result([]);
  });
  f.deps.environment.objectDirectory = directory;
  f.deps.access.canReadSemanticResource = async (_principal, _actor, resource) =>
    resource === collection || resource === definition;
  f.deps.statementSeek = {
    coverage: async () => ({ complete: true, through_sequence: '0' }),
  } as MainWorkDependencies['statementSeek'];
  const summarize = async (): Promise<ResourceSummary[]> => [{ reference: collection, status: 'available',
    type: 'collection', base: null, work: null, disclosure: 'public', name: { value: name, language: 'en', direction: 'ltr', basis: 'fallback' },
    avatar: { kind: 'fallback', policy: 'avatar-fallback-v1', key: collection, resourceType: 'collection' },
    address: { key: collection.slice(-36), prefix: '/e/', suffixSource: name } }, {
      reference: work, status: 'available', type: 'work', base: 'work', work, disclosure: 'public',
      name: { value: 'Root Work', language: 'en', direction: 'ltr', basis: 'fallback' },
      avatar: { kind: 'fallback', policy: 'avatar-fallback-v1', key: work, resourceType: 'work' },
      address: { prefix: '/w/', key: work.slice(-36), suffixSource: 'Root Work' },
    }];
  const input = { resource: work, languages: ['en'], limit: 10, canRead: async () => true,
    canReadOccurrence: async () => true, disclose: async (resources: readonly string[]) => new Set(resources),
    summarize: async () => { f.state.sequence += 10; return summarize(); } };
  let attempts = 0;
  const page = await workRead(f.deps, f.request, {}, async session => {
    attempts++; return readResourceRelations(f.deps.environment, input, session);
  });
  expect(attempts).toBe(1); expect(page.items[0]?.counterparts[0]).toMatchObject({ name: { value: name } });
  expect(page.sourcePosition).toMatchObject({ dataEpoch: 'epoch', sequence: '1' });
  const session = f.session(); await readResourceRelations(f.deps.environment, input, session);
  name = 'Changed collection';
  await expect(session.fenceDependencies()).rejects.toBeInstanceOf(WorkReadMoved);
});

test('land review 8: selected counterpart media restores fence even when avatar rows stay identical', async () => {
  let mediaEpoch = 'media', mediaSequence = 1;
  const target = id(41);
  const f = ownerFixture(query => query.includes('SELECT ?epoch ?sequence ?hold ?r') ? result([{ epoch: term('epoch'),
    sequence: term('1'), r: term(target, 'uri'), type: term('release'), head: term(id(42), 'uri'),
    work: term(work, 'uri'), public: term('true'), label: { ...term('Counterpart'), 'xml:lang': 'en' } }]) : undefined);
  f.deps.media = { store: { avatarRows: async () => ({ rows: new Map(),
    generation: { dataEpoch: mediaEpoch, sequence: String(mediaSequence) } }) } } as unknown as MainWorkDependencies['media'];
  const session = f.session();
  expect((await readPageRelationSummaries(session, [target], {}))[0]).toMatchObject({ status: 'available' });
  mediaSequence++;
  await session.fenceDependencies();
  mediaEpoch = 'restored-media';
  await expect(session.fenceDependencies()).rejects.toBeInstanceOf(WorkReadMoved);
});

test('reading traversal admission ignores unshown labels and avatars but closes private grants', async () => {
  let label = 'Unshown title', mediaEpoch = 'media', granted = true;
  const f = ownerFixture(query => query.includes('SELECT ?epoch ?sequence ?hold ?r') ? result([{ epoch: term('epoch'),
    sequence: term('1'), r: term(work, 'uri'), type: term('work'), head: term(id(70), 'uri'),
    work: term(work, 'uri'), public: term('false'), label: { ...term(label), 'xml:lang': 'en' } }]) : undefined);
  f.deps.access.canReadWork = async () => granted;
  f.deps.media = { store: { avatarRows: async () => ({ rows: new Map(),
    generation: { dataEpoch: mediaEpoch, sequence: '1' } }) } } as unknown as MainWorkDependencies['media'];
  const session = new WorkReadSession(f.deps, f.request, { actingSubject: agent }, { dataEpoch: 'epoch', sequence: '1' });
  session.principal = principal;
  const boundary = new ReadingBoundary(session, 'all');
  await boundary.traversalFor(work).requireWork(work);
  label = 'Changed unshown title'; mediaEpoch = 'restored-media';
  await session.fenceDependencies();
  granted = false;
  await expect(session.fenceDependencies()).rejects.toBeInstanceOf(WorkReadMoved);
});

test('selected identity chains ignore dataset drift and fence a changed redirect edge', async () => {
  let destination: string | null = id(72), f: ReturnType<typeof ownerFixture>;
  f = ownerFixture(query => {
    if (query.includes('SELECT ?sequence ?mergedInto')) {
      expect(query).not.toContain('FILTER(STR(?sequence)');
      const redirected = query.includes(`<${work}> rv:mergedInto`) ? destination : null;
      return result([{ sequence: term(String(f.state.sequence)), ...(redirected ? { mergedInto: term(redirected, 'uri') } : {}) }]);
    }
  });
  const session = f.session();
  const value = await readMergedIdentity(f.deps.environment, work, async () => { f.state.sequence++; return true; }, { session });
  expect(value).toMatchObject({ source: work, survivor: destination, hops: 1 });
  await session.fenceDependencies();
  destination = id(73);
  await expect(session.fenceDependencies()).rejects.toBeInstanceOf(WorkReadMoved);
});

for (const changed of ['unrelated', 'erasure'] as const) {
  test(`retained wiki history ${changed === 'unrelated' ? 'ignores unrelated writes' : 'fences selected historical pin erasure'}`, async () => {
    const entity = id(74), revision = id(75), proposal = '00000000-0000-4000-8000-000000000076';
    let erased = false, quoteReads = 0, f: ReturnType<typeof ownerFixture>;
    f = ownerFixture(query => {
      if (query.includes('SELECT ?epoch ?sequence ?hold ?r')) return result([{ epoch: term('epoch'),
        sequence: term(String(f.state.sequence)), r: term(entity, 'uri'), type: term('concept'), public: term('true'),
        label: { ...term('Current identity'), 'xml:lang': 'en' } }]);
      if (query.includes('SELECT ?main ?public')) return result([{ main: term(main, 'uri'), public: term('true') }]);
      if (query.includes('SELECT ?work ?main ?structuredDecision')) return result([]);
      if (query.includes('SELECT ?revision ?epoch ?sequence ?erased')) return result([{ revision: term(revision, 'uri'),
        epoch: term('epoch'), sequence: term('2'), erased: term(String(erased)) }]);
      if (query.includes('SELECT ?sequence ?mergedInto')) return result([{ sequence: term(String(f.state.sequence)) }]);
    });
    f.deps.access.canReadWork = async () => true;
    f.deps.editorialReview = { appliedReceipts: async () => ({ through: proposal, nextCursor: null, receipts: [{
      receipt: 'urn:wiki:receipt', proposal, revision: 1, candidateDigest: 'a'.repeat(64), operationKey: 'operation',
      beforeHeads: [], afterHeads: [], before: {}, owner: {}, candidate: { profile: 'wiki-extraction-v1', target: work,
        zone: realm, continuity: work, source: { representationSha256: 'a'.repeat(64), mediaType: 'text/plain', language: 'en',
          rightsBasis: 'public_domain', method: { agent: 'Fixture', model: 'local', inference: 'local' } },
        units: [{ id: 'chapter1', ordinal: 1, label: 'Chapter 1', occurrence: null }], claims: [],
        entities: [{ id: 'entity1', type: `${RV}Character`, names: [{ value: 'Pinned name', language: 'en', kind: 'primary', revealedAt: 'chapter1' }] }],
      }, commands: [{ key: `wiki:${proposal}:1:entity:entity1`, outcome: 'applied', receipt: 'urn:wiki:entity',
        result: { component: entity, revision } }],
    }] }) } as unknown as MainWorkDependencies['editorialReview'];
    f.deps.wikiEvidence = { withheld: async () => {
      quoteReads++; f.state.sequence += 10;
      if (changed === 'erasure' && quoteReads === 1) erased = true;
      return new Set<string>();
    } } as unknown as MainWorkDependencies['wikiEvidence'];
    const operation = readWikiHistory(f.deps, principal, agent, work, undefined,
      new Request('http://main.test/v1/wiki/history?position=all'));
    if (changed === 'erasure') await expect(operation).rejects.toBeInstanceOf(WorkReadMoved);
    else {
      const page = await operation;
      expect(page.entities).toMatchObject([{ entity, revision, names: [{ value: 'Pinned name' }] }]);
      expect(page.sourcePosition.sequence).toBe('2'); expect(quoteReads).toBe(2);
    }
  });
}

function rollupFixture() {
  const context = id(50), contextRevision = id(51), target = id(52), revision = id(53), receipt = id(54);
  const manifest = prepareComponent(directory, context, { context, realm, question: 'Judgment', language: 'en',
    targetGrain: 'release', state: 'active', scaleMin: 1, scaleMax: 10, cadence: RATING_STANDING_CADENCE,
    populationPolicy: RATING_ACCOUNT_POPULATION, aggregationPolicy: RATING_LATEST_MEAN_POLICY }, TARGET_CONTEXT_PROFILE);
  const members = new Map<string, TargetRatingComponents>();
  const visibility = { public: true };
  let f: ReturnType<typeof ownerFixture>;
  f = ownerFixture(query => {
    const control = { epoch: term('epoch'), sequence: term(String(f.state.sequence)) };
    if (query.includes('SELECT ?realm ?question ?grain')) return result([{ realm: term(realm, 'uri'),
      question: { ...term('Judgment'), 'xml:lang': 'en' }, grain: term(`${RV}Release`, 'uri'),
      contextRevision: term(contextRevision, 'uri'), manifest: term(`urn:rezics:sha256:${manifest}`, 'uri'),
      profile: term(TARGET_CONTEXT_PROFILE, 'uri') }]);
    if (query.includes('SELECT ?epoch ?sequence ?hold ?r')) return result([{ ...control, r: term(target, 'uri'),
      type: term('release'), head: term(revision, 'uri'), work: term(work, 'uri'), public: term(String(visibility.public)),
      label: { ...term('Selected release'), 'xml:lang': 'en' } }]);
    if (query.includes('SELECT ?epoch ?sequence ?r ?revision')) return result([{ ...control, r: term(target, 'uri'),
      revision: term(revision, 'uri'), type: term(`${RV}Release`, 'uri') }]);
    if (query.includes('SELECT ?r ?mergedInto')) return result([]);
    if (query.includes('SELECT ?epoch ?sequence ?contextReceipt')) return result([{ ...control,
      contextReceipt: term(receipt, 'uri'), contextEpoch: term('epoch'), contextSequence: term('1') }]);
    if (query.includes('SELECT ?target ?digest ?epoch')) return result([{ target: term(target, 'uri'), digest: term('digest'),
      epoch: term('epoch'), sequence: term('2') }]);
  });
  f.deps.environment.objectDirectory = directory;
  const store = { readMembers: async () => ({ contextRevision, realm, contextReceipt: receipt,
    contextDataEpoch: 'epoch', contextSequence: '1', recoveryGeneration: 'recovery', members: new Map(members), heads: null }),
    checkFence: async () => true } as unknown as TargetRatingInventoryStore;
  return { ...f, context, target, members, store, visibility,
    input: { context, targets: [target], formula: 'pooled' as const, rank: false } };
}

test('land review 16: ordinary rating rollups ignore unrelated writes at a constant selected fence cost', async () => {
  const calls: number[] = [];
  for (const drift of [0, 10, 100]) {
    const f = rollupFixture(); let attempts = 0;
    const read: RollupReader = operation => workRead(f.deps, f.request, {}, async session => {
      attempts++; const value = await operation(session); f.state.sequence += drift; return value;
    });
    const page = await queryRatingRollup(read, f.store, f.input);
    expect(attempts).toBe(4);
    expect(page.members).toMatchObject([{ target: f.target, status: 'available', meanDisplay: 'no-data' }]);
    calls.push(f.state.calls);
  }
  expect(new Set(calls).size).toBe(1);
});

test('land review 16: rating rollups replay a selected aggregate row written after assembly', async () => {
  const f = rollupFixture(); let assemblies = 0;
  const read: RollupReader = operation => workRead(f.deps, f.request, {}, async session => {
    const value = await operation(session);
    if (value && typeof value === 'object' && 'profile' in value && value.profile === 'rating-rollup-v1') {
      assemblies++;
      if (assemblies === 1) f.members.set(f.target, { slots: 1, unvalued: 0, count: 1, sum: 8,
        histogram: Array.from({ length: 10 }, (_, i) => i === 7 ? 1 : 0), last: {
          admissionId: 'admission', receipt: id(55), requestDigest: 'digest', dataEpoch: 'epoch', sequence: '2',
        } } as TargetRatingComponents);
    }
    return value;
  });
  const page = await queryRatingRollup(read, f.store, f.input);
  expect(assemblies).toBe(2);
  expect(page.members).toMatchObject([{ target: f.target, status: 'available', components: { population: 1, count: 1, sum: 8 } }]);
});

test('land review 16: final assembly cannot deliver an aggregate after target disclosure is revoked', async () => {
  const f = rollupFixture();
  const read: RollupReader = operation => workRead(f.deps, f.request, {}, async session => {
    const value = await operation(session);
    if (value && typeof value === 'object' && 'profile' in value && value.profile === 'rating-rollup-v1')
      f.visibility.public = false;
    return value;
  });
  await expect(queryRatingRollup(read, f.store, f.input)).rejects.toBeInstanceOf(WorkReadUnavailable);
});

for (const revoked of ['disclosure', 'membership'] as const) {
  test(`land review 1: followed Spaces cannot deliver a title after ${revoked} changes`, async () => {
    let isPublic = revoked === 'disclosure', proof: string | null = revoked === 'membership' ? 'proof' : null;
    let f: ReturnType<typeof ownerFixture>;
    f = ownerFixture(query => {
      if (query.includes('SELECT ?space ?realm ?zone')) return result([{ space: term(space, 'uri'), realm: term(realm, 'uri') }]);
      if (query.includes('SELECT ?epoch ?sequence ?hold ?r')) return result([{ epoch: term(f.state.epoch),
        sequence: term(String(f.state.sequence)), r: term(realm, 'uri'), type: term('realm'), public: term(String(isPublic)) }]);
      if (query.includes('SELECT ?realm ?name')) return result(isPublic || proof ? [{ realm: term(realm, 'uri'),
        name: { ...term('Selected Space title'), 'xml:lang': 'en' } }] : []);
      if (query.includes('SELECT ?realm ?payload')) return result([{ realm: term(realm, 'uri') }]);
    });
    f.deps.access.realmReadProof = async () => proof;
    const session = f.session();
    const reader = { principal, agent };
    const first = await readFollowTarget(session, space, 'space', undefined, reader);
    const second = await readFollowTarget(session, space, 'space', undefined, reader);
    expect(first.name.value).toBe('Selected Space title'); expect(second.name).toEqual(first.name);
    if (revoked === 'disclosure') isPublic = false; else proof = null;
    await expect(session.fenceDependencies()).rejects.toBeInstanceOf(WorkReadMoved);
  });
}
