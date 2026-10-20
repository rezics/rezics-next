import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { FusekiClient, fusekiReadBudget, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import type { ImmutableObjects } from '../src/infrastructure/immutable-objects.ts';
import { canReadCompositionWork, compositionTargetBatchReader,
  compositionTargetDisclosureBatchReader } from '../src/modules/composition/disclosure-read.ts';
import { readWorkParts, readWorkWholes } from '../src/modules/composition/read.ts';
import { compositionWorkBatchReader } from '../src/modules/composition/visible-targets.ts';
import { configureDisclosure } from '../src/modules/disclosure/read.ts';
import { configureFixtureDisclosureAncestry, fixtureDisclosureReader } from './support/disclosure-ancestry.ts';
import { checkedComponentState } from '../src/modules/semantic/change.ts';
import { PROFILES } from '../src/modules/semantic/schema.ts';
import { orderTree, recordTree } from '../src/modules/structure/change.ts';
import { STRUCTURE_MANIFEST_FORMAT, STRUCTURE_PAGE_FORMAT, STRUCTURE_PROFILE,
  type OccurrenceRecord, type StructureManifest } from '../src/modules/structure/format.ts';
import { derivedId, orderTreeKey } from '../src/modules/structure/graph.ts';
import { structureProfileFor } from '../src/modules/structure/profiles.ts';
import { newCost } from '../src/modules/structure/tree.ts';
import { WorkReadMoved, WorkReadSession, WorkReadUnavailable } from '../src/modules/work/read-session.ts';
import { WORK_READ_COST } from '../src/modules/work/read-contract.ts';
import { prepareWorkComponent } from '../src/modules/work/activate.ts';
import { PublishedStructureSourceUnavailable, type PublishedStructuredWorkSource }
  from '../src/modules/work/public-patterns.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { structuredWorkPublicationAnswer, structuredWorkSourceRow } from './structured-work-publication-fixture.ts';

const literal = (value: string) => ({ type: 'literal' as const, value });
const uri = (value: string) => ({ type: 'uri' as const, value });
type Target = { resource: string; base?: 'work' | 'realization' | 'release' | 'occurrence' | 'resource';
  private?: boolean; granted?: boolean; erased?: boolean; hidden?: boolean; missingRevision?: boolean;
  types?: string[]; semanticHead?: string };
const targets = (count: number): Target[] => Array.from({ length: count }, (_, index) =>
  ({ resource: derivedId(`composition-batch-target-${index}`) }));

/** Simulate owner responses, while using the real summary, disclosure and exact
 * target resolver. Query and owner batches are observed independently of output size. */
function fixture(input: Target[], signedIn = false) {
  const indexed = new Map(input.map(target => [target.resource, target]));
  const revision = derivedId('composition-batch-revision');
  const graph = new FusekiClient('http://graph.invalid');
  const queries: string[] = [], hydration: string[][] = [], disclosure: string[][] = [], grants: string[] = [];
  const semanticBatches: string[][] = [], semanticManifests = new Map<string, string>();
  const stored = new Map<string, Uint8Array>();
  const objects: ImmutableObjects = { async put(bytes) {
    const digest = createHash('sha256').update(bytes).digest('hex');
    stored.set(digest, bytes); return digest;
  }, async get(digest) {
    const bytes = stored.get(digest);
    if (!bytes) throw new Error('Missing semantic fixture object');
    return bytes;
  } };
  let sequence = '1', graphEpoch = 'epoch', ambiguous = false, failOwner = false;
  let graphBytes = 0;
  graph.query = async query => {
    queries.push(query);
    if (query.includes('SELECT ?target WHERE') || query.includes('SELECT DISTINCT ?target ?head')) {
      const resources = [...new Set([...query.matchAll(/VALUES \?target \{([^}]+)\}/g)].flatMap(match =>
        [...match[1]!.matchAll(/<([^>]+)>/g)].map(value => value[1]!)))];
      // Exercise the real registered guard builder, including its exact base
      // exclusions. This transport fixture is not a native SPARQL proof.
      expect(query).toContain('rv:semanticHead');
      const checksProfile = query.includes('https://schema.org/TVEpisode');
      if (checksProfile) expect(query).toContain('rv:FixedRelease');
      else expect(query).toContain('OPTIONAL { GRAPH');
      const valid = (resource: string) => {
        const target = indexed.get(resource);
        return target?.base === 'resource' && !target.missingRevision
          && target.types?.includes('https://schema.org/TVEpisode');
      };
      return { results: { bindings: query.includes('SELECT ?target WHERE')
        ? resources.filter(resource => !valid(resource)).slice(0, 1).map(resource => ({ target: uri(resource) }))
        : resources.filter(resource => !checksProfile || valid(resource)).map(resource => ({ target: uri(resource),
          ...(indexed.get(resource)?.base === 'resource' && !indexed.get(resource)?.missingRevision
            || indexed.get(resource)?.semanticHead
            ? { head: uri(indexed.get(resource)?.semanticHead ?? revision) } : {}) })) } };
    }
    if (query.includes('SELECT ?resource ?head')) {
      const resources = [...query.matchAll(/VALUES \?resource \{([^}]+)\}/g)].flatMap(match =>
        [...match[1]!.matchAll(/<([^>]+)>/g)].map(value => value[1]!));
      return { results: { bindings: resources.map(resource => ({ resource: uri(resource), head: uri(revision) })) } };
    }
    const publication = structuredWorkPublicationAnswer(query);
    if (publication) {
      graphBytes += Buffer.byteLength(JSON.stringify(publication));
      return publication;
    }
    if (query.includes('SELECT ?work ?head ?owningWork ?owningHead')) {
      const resources = [...new Set([...query.matchAll(/VALUES \?work \{([^}]+)\}/g)].flatMap(match =>
        [...match[1]!.matchAll(/<([^>]+)>/g)].map(iri => iri[1]!)))];
      const result = { results: { bindings: resources.map(resource => {
        const base = indexed.get(resource)?.base ?? 'work';
        return { work: uri(resource), ...(base !== 'resource' ? { head: uri(revision),
          owningWork: uri(base !== 'work' ? derivedId('composition-target-parent') : resource),
          owningHead: uri(revision) } : {}) };
      }) } };
      graphBytes += Buffer.byteLength(JSON.stringify(result));
      return result;
    }
    if (query.includes('SELECT ?resource ?manifest')) {
      const resources = [...query.matchAll(/VALUES \?resource \{([^}]+)\}/g)].flatMap(match =>
        [...match[1]!.matchAll(/<([^>]+)>/g)].map(iri => iri[1]!));
      const result = { results: { bindings: resources.flatMap(resource => semanticManifests.has(resource)
        ? [{ resource: uri(resource), manifest: uri(semanticManifests.get(resource)!) }] : []) } };
      graphBytes += Buffer.byteLength(JSON.stringify(result));
      return result;
    }
    const resources = [...query.matchAll(/VALUES \?r \{([^}]+)\}/g)].flatMap(match =>
      [...match[1]!.matchAll(/<([^>]+)>/g)].map(iri => iri[1]!));
    const bindings: NonNullable<SparqlResult['results']>['bindings'] = [];
    for (const resource of resources) {
      const target = indexed.get(resource);
      if (!target) continue;
      if (query.includes('SELECT ?epoch ?sequence ?hold')) {
        const base = target.base ?? 'work';
        bindings.push({ epoch: literal(graphEpoch), sequence: literal(sequence), r: uri(resource),
          type: literal(base), ...(base !== 'resource' ? {
            work: uri(base === 'work' ? resource : derivedId('composition-target-parent')), head: uri(revision),
            label: { ...literal('Work target'), 'xml:lang': 'en' } } : {}),
          public: literal(String(!target.private)), erased: literal(String(!!target.erased)) });
      } else if (query.includes('SELECT ?epoch ?sequence ?r ?revision')) {
        if (target.missingRevision) continue;
        const base = target.base ?? 'work';
        const types = target.types ?? (base === 'work' ? ['https://schema.org/Book', 'https://schema.org/CreativeWork']
          : base === 'resource' ? ['https://schema.org/Episode']
            : base === 'occurrence' ? ['https://schema.org/ListItem']
              : [`https://rezics.com/vocab/${base === 'realization' ? 'Realization' : 'Release'}`]);
        for (const type of types) bindings.push({ epoch: literal(graphEpoch), sequence: literal(sequence), r: uri(resource),
          revision: uri(revision), type: uri(type) });
        if (ambiguous) bindings.push({ ...bindings.at(-1)!, revision: uri(derivedId('composition-other-revision')) });
      } else throw new Error(`Unexpected target query: ${query}`);
    }
    if (!bindings.length) bindings.push({ epoch: literal(graphEpoch), sequence: literal(sequence) });
    const result = { results: { bindings } };
    graphBytes += Buffer.byteLength(JSON.stringify(result));
    return result;
  };
  const environment = { fuseki: graph, workObjects: objects, objectDirectory: '.temp/composition-target-batches',
    lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' } };
  configureFixtureDisclosureAncestry(environment, target => target.work
    ? { resource: target.work, head: revision, protectedRevision: target.workRevision } : undefined);
  configureDisclosure(environment, fixtureDisclosureReader(async resources => {
    disclosure.push(resources.map(target => target.resource));
    return resources.map(target => indexed.get(target.resource)?.hidden ? 'tombstone' : 'visible');
  }));
  const canReadSemantic = (principal: unknown, resource: string) => {
    const target = indexed.get(resource);
    return !!target && (!target.private || !!principal && !!target.granted);
  };
  const deps = { environment, access: { assertRecoveryOpen: async () => undefined,
    activePrincipalId: async () => 'reader',
    canReadWork: async (_principal: unknown, _actor: string, work: string) => {
    grants.push(work); return indexed.get(work)?.granted ?? false;
  }, canReadSemanticResource: async (principal: unknown, _actor: string | null, resource: string) =>
    canReadSemantic(principal, resource) }, mediaAccess: {
    canReadWorks: async (_principal: unknown, _actor: string, works: readonly string[]) => {
      grants.push(...works);
      return new Set(works.filter(work => indexed.get(work)?.granted));
    },
    canReadSemantics: async (principal: unknown, _actor: string | null, resources: readonly string[]) => {
      semanticBatches.push([...resources]);
      return { public: new Set(resources.filter(resource => indexed.has(resource) && !indexed.get(resource)!.private)),
        granted: new Set(resources.filter(resource => !!principal && !!indexed.get(resource)?.granted)) };
    },
  }, media: { store: { avatarRows: async (resources: string[]) => {
    if (failOwner) throw new Error('Media owner unavailable');
    hydration.push([...resources]);
    return { rows: new Map(), generation: { dataEpoch: 'media', sequence: '1' } };
  } } } } as unknown as MainWorkDependencies;
  const session = () => {
    const read = new WorkReadSession(deps, new Request('http://main.test/v1/compositions'),
      signedIn ? { actingSubject: derivedId('composition-reader') } : {},
      { dataEpoch: 'epoch', sequence: '1' });
    if (signedIn) read.principal = { issuer: 'account', subject: 'reader' };
    return read;
  };
  return { deps, input, graph, revision, session, queries, hydration, disclosure, grants, objects, semanticManifests, semanticBatches,
    graphBytes: () => graphBytes, move: () => { graphEpoch = 'recovered'; }, moveSequence: () => { sequence = '2'; },
    ambiguous: () => { ambiguous = true; }, failOwner: () => { failOwner = true; } };
}

async function episodeFixture(input: Target[], signedIn = false) {
  const f = fixture(input, signedIn);
  for (const target of input) {
    if (target.base !== 'resource') continue;
    const state = checkedComponentState({ component: 'resource',
      types: target.types ?? ['https://schema.org/TVEpisode'], lifecycle: 'active',
      properties: [{ predicate: 'https://schema.org/name',
        value: { kind: 'language-string', lexical: 'Episode target', language: 'en' } }] });
    const digest = await prepareWorkComponent(f.objects, target.resource, state, PROFILES.resource);
    f.semanticManifests.set(target.resource, `urn:rezics:sha256:${digest}`);
  }
  return f;
}

test('Composition profile batches hydrate 100 distinct Work identities in two bounded owner passes', async () => {
  for (const profile of ['work-composition', 'collection-membership']) {
    const f = fixture(targets(100));
    const read = compositionTargetBatchReader(f.session(), structureProfileFor(profile))!;
    const visible = await read(f.input.map(target => target.resource));
    expect([...visible]).toEqual(f.input.map(target => target.resource));
    // Two resolver probes and two owner-parent head statements per batch.
    expect(f.queries).toHaveLength(8);
    expect(f.hydration.map(batch => batch.length)).toEqual([64, 36]);
    expect(f.hydration.flat()).toEqual([...visible]);
    expect(f.disclosure.map(batch => batch.length)).toEqual([64, 64, 36, 36]);
    expect(f.graphBytes()).toBeLessThan(4 * 1024 * 1024);
    expect(f.grants).toEqual([]);
  }
});

test('Composition batches retain 100 admitted Episode resource grains with bounded semantic owner probes', async () => {
  const input = targets(100).map(target => ({ ...target, base: 'resource' as const }));
  const f = fixture(input);
  for (const [index, target] of input.entries()) {
    const state = checkedComponentState({ component: 'resource', types: ['https://schema.org/Episode'], lifecycle: 'active',
      properties: [{ predicate: 'https://schema.org/name',
        value: { kind: 'language-string', lexical: `Episode ${index + 1}`, language: 'en' } }] });
    const digest = await prepareWorkComponent(f.objects, target.resource, state, PROFILES.resource);
    f.semanticManifests.set(target.resource, `urn:rezics:sha256:${digest}`);
  }
  const resources = input.map(target => target.resource);
  expect([...await compositionTargetBatchReader(f.session(), structureProfileFor('work-composition'))!(resources)])
    .toEqual(resources);
  expect(f.semanticBatches.map(batch => batch.length)).toEqual([64, 36]);
  expect(f.hydration.map(batch => batch.length)).toEqual([64, 36]);
  expect(f.disclosure.map(batch => batch.length)).toEqual([64, 64, 36, 36]);
  expect(f.queries).toHaveLength(6);
  expect(f.graphBytes()).toBeLessThan(4 * 1024 * 1024);
  expect([...await compositionWorkBatchReader(f.session())(resources)]).toEqual([]);
  expect(f.semanticBatches.map(batch => batch.length)).toEqual([64, 36, 64, 36]);
});

test('Composition batching deduplicates targets and accepts empty candidate sets without owner work', async () => {
  const f = fixture(targets(1));
  const read = compositionTargetBatchReader(f.session(), structureProfileFor('work-composition'))!;
  expect([...await read([])]).toEqual([]);
  expect(f.queries).toEqual([]);
  expect([...await read(Array(100).fill(f.input[0]!.resource))]).toEqual([f.input[0]!.resource]);
  expect(f.queries).toHaveLength(4);
  expect(f.hydration).toEqual([[f.input[0]!.resource]]);
});

test('Composition profile batching preserves catalog targets and leaves other profile authorities in charge', async () => {
  const f = fixture(targets(1));
  const read = compositionTargetBatchReader(f.session(), structureProfileFor('collection-membership'))!;
  const catalog = ['https://schema.org/Book', 'https://schema.org/DigitalDocument'];
  expect(new Set(await read([...catalog, f.input[0]!.resource]))).toEqual(new Set([...catalog, f.input[0]!.resource]));
  expect(f.hydration).toEqual([[f.input[0]!.resource]]);
  for (const profile of ['book-composition', 'recipe-composition', 'zone-navigation']) {
    const readTargets = compositionTargetBatchReader(f.session(), structureProfileFor(profile));
    expect(await readTargets([f.input[0]!.resource])).toEqual(new Set(
      profile === 'book-composition' ? [f.input[0]!.resource] : []));
  }
});

test('Episode profile reads admit only current native TVEpisode resources for public and granted readers', async () => {
  for (const signedIn of [false, true]) {
    const input: Target[] = targets(13).map(target => ({ ...target, base: 'resource',
      types: ['https://schema.org/TVEpisode'] }));
    input[1]!.types = ['https://schema.org/MusicComposition'];
    input[2]!.base = 'work';
    input[3]!.private = input[3]!.granted = true;
    input[4]!.private = input[4]!.granted = true;
    input[4]!.types = ['https://schema.org/MusicComposition'];
    input[5]!.types = ['https://schema.org/Episode'];
    input[6]!.erased = true;
    input[7]!.hidden = true;
    input[8]!.missingRevision = true;
    input[9]!.base = 'realization';
    input[10]!.base = 'release';
    input[11]!.base = 'occurrence';
    input[12]!.private = true;
    const f = await episodeFixture(input, signedIn);
    f.deps.access.canReadWork = async () => { throw new Error('Episode resources need no Work target grant'); };
    const session = f.session();
    const result = await compositionTargetBatchReader(session, structureProfileFor('episode-list-v1'))(
      input.flatMap(target => [target.resource, target.resource]));
    expect(result).toEqual(new Set([input[0]!.resource, ...(signedIn ? [input[3]!.resource] : [])]));
    expect(session.principal).toEqual(signedIn ? { issuer: 'account', subject: 'reader' } : null);
    expect(f.grants).toEqual([]);
    expect(f.queries.filter(query => query.includes('SELECT ?target WHERE'))).toHaveLength(1);
    expect(f.queries.filter(query => query.includes('SELECT DISTINCT ?target ?head'))).toHaveLength(1);
    await session.fenceDependencies();
  }
});

test('Episode disclosure reads preserve visible profile mismatches for native classification', async () => {
  const profile = structureProfileFor('episode-list-v1');
  for (const signedIn of [false, true]) {
    const input: Target[] = targets(7).map(target => ({ ...target, base: 'resource',
      types: ['https://schema.org/Movie'] }));
    input[0]!.types = ['https://schema.org/TVEpisode'];
    input[2]!.base = 'work';
    input[3]!.private = input[3]!.granted = true;
    input[4]!.private = true;
    input[5]!.erased = true;
    input[6]!.hidden = true;
    const f = await episodeFixture(input, signedIn), session = f.session();
    const read = compositionTargetDisclosureBatchReader(session, profile);
    expect(await read([])).toEqual(new Set());
    expect(f.queries).toEqual([]);
    const resources = input.flatMap(target => [target.resource, target.resource]);
    const disclosed = new Set([input[0]!.resource, input[1]!.resource, input[2]!.resource,
      ...(signedIn ? [input[3]!.resource] : [])]);
    expect(await read(resources)).toEqual(disclosed);
    // Pure disclosure consumes no native guard diagnostic, including for the
    // private invalid target. The native owner checks validity after admission.
    expect(f.queries.filter(query => query.includes('SELECT ?target WHERE'))).toHaveLength(0);
    const selections = f.queries.filter(query => query.includes('SELECT DISTINCT ?target ?head'));
    expect(selections).toHaveLength(1);
    for (const target of input) expect(selections[0]!.includes(`<${target.resource}>`))
      .toBe(disclosed.has(target.resource));
    await session.fenceDependencies();
    // Public projections still withhold the readable Movie and wrong grain.
    const projection = f.session();
    expect(await compositionTargetBatchReader(projection, profile)(resources)).toEqual(new Set([input[0]!.resource]));
    await projection.fenceDependencies();
  }
});

test('Episode disclosure reads fence selected heads and authority without hiding owner failures', async () => {
  const profile = structureProfileFor('episode-list-v1');
  for (const change of ['head', 'grant', 'erasure', 'disclosure', 'owner'] as const) {
    const input: Target[] = [{ ...targets(1)[0]!, base: 'resource', types: ['https://schema.org/Movie'],
      private: true, granted: true }];
    const f = await episodeFixture(input, true), session = f.session();
    expect(await compositionTargetDisclosureBatchReader(session, profile)([input[0]!.resource]))
      .toEqual(new Set([input[0]!.resource]));
    await session.fenceDependencies();
    if (change === 'head') input[0]!.semanticHead = derivedId('moved-disclosed-semantic-head');
    else if (change === 'grant') input[0]!.granted = false;
    else if (change === 'erasure') input[0]!.erased = true;
    else if (change === 'disclosure') input[0]!.hidden = true;
    else f.failOwner();
    if (change === 'owner') await expect(session.fenceDependencies()).rejects.toThrow('Media owner unavailable');
    else await expect(session.fenceDependencies()).rejects.toBeInstanceOf(WorkReadMoved);
  }
});

test('Episode profile reads keep a full public page within the existing request allocation', async () => {
  const input: Target[] = targets(100).map(target => ({ ...target, base: 'resource',
    types: ['https://schema.org/TVEpisode'] }));
  const f = await episodeFixture(input);
  const session = f.session();
  await fusekiReadBudget.run({ signal: new AbortController().signal,
    callsLeft: WORK_READ_COST.graphCalls, bytesLeft: WORK_READ_COST.graphBytes }, async () => {
    const read = compositionTargetBatchReader(session, structureProfileFor('episode-list-v1'));
    expect(await read([])).toEqual(new Set());
    expect(f.queries).toEqual([]);
    expect(await read(input.flatMap(target => [target.resource, target.resource])))
      .toEqual(new Set(input.map(target => target.resource)));
    expect(f.semanticBatches.map(batch => batch.length)).toEqual([64, 36]);
    expect(f.hydration.map(batch => batch.length)).toEqual([64, 36]);
    expect(f.queries.filter(query => query.includes('SELECT ?target WHERE'))).toHaveLength(2);
    expect(f.queries.filter(query => query.includes('SELECT DISTINCT ?target ?head'))).toHaveLength(2);
    expect(f.queries.length).toBeLessThanOrEqual(10);
    await session.fenceDependencies();
    expect(f.queries.filter(query => query.includes('SELECT DISTINCT ?target ?head'))).toHaveLength(4);
    expect(f.queries.length).toBeLessThanOrEqual(20);
  });
});

test('Episode profile final fences refuse type, grain and head movement after selection', async () => {
  for (const signedIn of [false, true]) for (const move of ['type', 'grain', 'head'] as const) {
    const input: Target[] = targets(2).map(target => ({ ...target, base: 'resource',
      types: ['https://schema.org/TVEpisode'], private: signedIn, granted: signedIn }));
    const f = await episodeFixture(input, signedIn), session = f.session();
    const resources = input.map(target => target.resource);
    const read = compositionTargetBatchReader(session, structureProfileFor('episode-list-v1'));
    expect(await read(resources)).toEqual(new Set(resources));
    if (move === 'type') input[0]!.types = ['https://schema.org/MusicComposition'];
    else if (move === 'grain') input[0]!.base = 'work';
    else input[0]!.semanticHead = derivedId('moved-episode-semantic-head');
    await expect(session.fenceDependencies()).rejects.toBeInstanceOf(WorkReadMoved);
    // Old display/Structure evidence cannot re-admit a target after an
    // independent native edit; an unchanged neighbour stays readable.
    const retry = f.session();
    expect(await compositionTargetBatchReader(retry, structureProfileFor('episode-list-v1'))(resources))
      .toEqual(new Set(move === 'head' ? resources : [input[1]!.resource]));
    await retry.fenceDependencies();
  }
});

test('Episode profile final fences retain recipient, erasure and disclosure refusals', async () => {
  for (const change of ['grant', 'erasure', 'disclosure'] as const) {
    const input: Target[] = [{ ...targets(1)[0]!, base: 'resource', types: ['https://schema.org/TVEpisode'],
      private: true, granted: true }];
    const f = await episodeFixture(input, true), session = f.session();
    expect(await compositionTargetBatchReader(session, structureProfileFor('episode-list-v1'))(
      [input[0]!.resource])).toEqual(new Set([input[0]!.resource]));
    if (change === 'grant') input[0]!.granted = false;
    else if (change === 'erasure') input[0]!.erased = true;
    else input[0]!.hidden = true;
    await expect(session.fenceDependencies()).rejects.toBeInstanceOf(WorkReadMoved);
  }
});

test('Episode profile cancellation stops later target probes and permits a fresh retry', async () => {
  const input: Target[] = targets(100).map(target => ({ ...target, base: 'resource',
    types: ['https://schema.org/TVEpisode'] }));
  const f = await episodeFixture(input), abort = new AbortController();
  const queryTargets = f.graph.query.bind(f.graph);
  f.graph.query = async query => {
    const result = await queryTargets(query);
    if (query.includes('SELECT ?target WHERE')) abort.abort(new Error('Episode read cancelled'));
    return result;
  };
  await expect(fusekiReadBudget.run({ signal: abort.signal,
    callsLeft: WORK_READ_COST.graphCalls, bytesLeft: WORK_READ_COST.graphBytes },
    () => compositionTargetBatchReader(f.session(), structureProfileFor('episode-list-v1'))(
      input.map(target => target.resource)))).rejects.toThrow('Episode read cancelled');
  expect(f.queries.filter(query => query.includes('SELECT ?target WHERE'))).toHaveLength(1);
  expect(f.queries.filter(query => query.includes('SELECT DISTINCT ?target ?head'))).toHaveLength(0);
  expect(f.semanticBatches.map(batch => batch.length)).toEqual([64]);
  expect(f.hydration.map(batch => batch.length)).toEqual([64]);
  f.graph.query = queryTargets;
  const session = f.session();
  await fusekiReadBudget.run({ signal: new AbortController().signal,
    callsLeft: WORK_READ_COST.graphCalls, bytesLeft: WORK_READ_COST.graphBytes }, async () => {
    expect(await compositionTargetBatchReader(session, structureProfileFor('episode-list-v1'))(
      input.map(target => target.resource))).toEqual(new Set(input.map(target => target.resource)));
    await session.fenceDependencies();
  });
});

test('Composition batch disclosure withholds private, erased, hidden and revision-missing targets individually', async () => {
  const input = targets(6);
  input[1]!.private = true;
  input[2]!.erased = true;
  input[3]!.hidden = true;
  input[4]!.missingRevision = true;
  input[5]!.private = input[5]!.granted = true;
  const f = fixture(input, true);
  const visible = await compositionTargetBatchReader(f.session(), structureProfileFor('work-composition'))!(
    input.map(target => target.resource));
  expect([...visible]).toEqual([input[0]!.resource, input[5]!.resource]);
  expect(f.grants).toEqual([input[1]!.resource, input[5]!.resource]);
  expect(f.hydration.flat()).not.toContain(input[1]!.resource);
  expect(f.hydration.flat()).not.toContain(input[2]!.resource);
  expect(f.hydration.flat()).not.toContain(input[3]!.resource);
});

test('Work parts batching filters non-Work grains while generic Composition batches retain them', async () => {
  const input = targets(4);
  input[1]!.base = 'realization';
  input[2]!.base = 'release';
  input[3]!.base = 'occurrence';
  const f = fixture(input);
  const generic = compositionTargetBatchReader(f.session(), structureProfileFor('work-composition'))!;
  expect([...await generic(input.map(target => target.resource))]).toEqual(input.map(target => target.resource));
  expect([...await compositionWorkBatchReader(f.session())(input.map(target => target.resource))])
    .toEqual([input[0]!.resource]);
});

test('Composition batches fail closed on recovery epoch movement, ambiguous revisions and owner failures', async () => {
  for (const state of ['move', 'ambiguous', 'failOwner'] as const) {
    const f = fixture(targets(1));
    f[state]();
    const read = compositionTargetBatchReader(f.session(), structureProfileFor('work-composition'))!;
    const result = read(f.input.map(target => target.resource));
    if (state === 'move') await expect(result).rejects.toThrow('graph lineage is unavailable');
    else if (state === 'ambiguous') await expect(result).rejects.toBeInstanceOf(WorkReadUnavailable);
    else await expect(result).rejects.toThrow('Media owner unavailable');
  }
});

test('Composition selected-unit admission tolerates unrelated graph sequence movement', async () => {
  const f = fixture(targets(4));
  f.moveSequence();
  expect(await compositionTargetBatchReader(f.session(), structureProfileFor('work-composition'))(
    f.input.map(target => target.resource))).toEqual(new Set(f.input.map(target => target.resource)));
});

test('Composition Work admission checks exact sources in its existing probe and retains Structure disclosure', async () => {
  const f = fixture(targets(1)), work = f.input[0]!.resource;
  const source: PublishedStructuredWorkSource = { work, mainVersion: derivedId('composition-source-main'),
    decision: derivedId('composition-source-decision'), source: 'urn:rezics:work-source:composition',
    structure: derivedId('composition-source-structure'), structureProfile: 'https://rezics.com/vocab/WorkComposition',
    structureRevision: f.revision, selectedGeneration: derivedId('composition-source-generation'),
    sourceRoot: `urn:rezics:sha256:${'a'.repeat(64)}` };
  let visible = true, exact = true, duplicate = false;
  configureDisclosure(f.deps.environment, fixtureDisclosureReader(async targets => targets.map(target =>
    target.component === 'structure' && !visible ? 'hidden' : 'visible')));
  const queryTargets = f.graph.query.bind(f.graph);
  f.graph.query = async query => {
    if (query.includes('SELECT ?main ?public')) {
      f.queries.push(query);
      expect(query).toContain('rv:component ?structuredSourceMain');
      expect(query).toContain('FILTER(?structuredSourceMain = ?main)');
      const row = { main: uri(source.mainVersion), public: literal('true'), ...structuredWorkSourceRow(source),
        structuredExact: literal(String(exact)) };
      return { results: { bindings: duplicate ? [row, row] : [row] } };
    }
    if (query.includes('SELECT ?work ?parent')) {
      f.queries.push(query);
      return { results: { bindings: [{ work: uri(work) }] } };
    }
    return queryTargets(query);
  };
  expect(await canReadCompositionWork(f.session(), work)).toBe(true);
  visible = false;
  expect(await canReadCompositionWork(f.session(), work)).toBe(false);
  exact = false;
  await expect(canReadCompositionWork(f.session(), work)).rejects.toBeInstanceOf(PublishedStructureSourceUnavailable);
  duplicate = true;
  await expect(canReadCompositionWork(f.session(), work)).rejects.toBeInstanceOf(WorkReadUnavailable);
  expect(f.queries.filter(query => query.includes('SELECT ?main ?public'))).toHaveLength(4);
  expect(f.queries.filter(query => query.includes('SELECT ?work ?main ?structuredDecision'))).toHaveLength(0);
});

test('Composition batch cancellation stops before graph or owner hydration', async () => {
  const f = fixture(targets(100));
  const abort = new AbortController();
  abort.abort(new Error('Composition read cancelled'));
  const read = compositionTargetBatchReader(f.session(), structureProfileFor('work-composition'))!;
  await expect(fusekiReadBudget.run({ signal: abort.signal, callsLeft: 160, bytesLeft: 4 * 1024 * 1024 },
    () => read(f.input.map(target => target.resource)))).rejects.toThrow('Composition read cancelled');
  expect(f.queries).toEqual([]);
  expect(f.hydration).toEqual([]);
});

test('Work parts disclose 100 distinct Work targets without scalar target probes', async () => {
  const f = fixture(targets(100));
  const stored = new Map<string, Uint8Array>();
  const objects: ImmutableObjects = { async put(bytes) {
    const digest = createHash('sha256').update(bytes).digest('hex');
    stored.set(digest, bytes); return digest;
  }, async get(digest) {
    const bytes = stored.get(digest);
    if (!bytes) throw new Error('Missing Structure fixture object');
    return bytes;
  } };
  const owner = derivedId('composition-batch-owner'), main = derivedId('composition-batch-main');
  const structure = derivedId('composition-batch-structure'), generation = derivedId('composition-batch-generation');
  const records: OccurrenceRecord[] = f.input.map((target, index) => ({
    occurrence: derivedId(`composition-batch-part-${index}`), parent: structure, state: 'active', role: 'part',
    segmentKey: 'i', orderKey: String(index).padStart(8, '0'), labels: [], introducedBy: f.revision,
    target: target.resource, qualifier: { type: 'work-part', displayLabel: `Part ${index + 1}`, inclusion: 'required' },
  }));
  const cost = newCost(), recordIndex = recordTree(objects), orderIndex = orderTree(objects);
  const manifest: StructureManifest = { format: STRUCTURE_MANIFEST_FORMAT, structure, structureOf: main,
    profile: 'work-composition', generation, pageFormat: STRUCTURE_PAGE_FORMAT,
    records: await recordIndex.apply(await recordIndex.empty(cost), new Map(records.map(row => [row.occurrence, row])), cost),
    order: await orderIndex.apply(await orderIndex.empty(cost), new Map(records.map(row =>
      [orderTreeKey({ parent: row.parent, segmentKey: row.segmentKey!, orderKey: row.orderKey! }),
        { occurrence: row.occurrence, parent: row.parent, segmentKey: row.segmentKey!, orderKey: row.orderKey! }])), cost),
    placementCount: records.length, measures: [], model: STRUCTURE_PROFILE, shape: STRUCTURE_PROFILE };
  const manifestRef = `urn:rezics:sha256:${await objects.put(new TextEncoder().encode(JSON.stringify(manifest)))}`;
  Object.assign(f.deps.environment, { structureObjects: objects });
  const targetQuery = f.graph.query.bind(f.graph);
  let scalarProbes = 0, missingMain = false;
  f.graph.query = async query => {
    let bindings: NonNullable<SparqlResult['results']>['bindings'];
    if (query.includes('SELECT ?main ?public')) {
      scalarProbes++;
      expect(query).toContain(`<${owner}>`);
      bindings = [{ main: uri(main), public: literal('true') }];
    } else if (query.includes('SELECT ?structure ?main')) bindings = [{ structure: uri(structure), main: uri(main) }];
    else if (query.includes('SELECT ?component ?profile')) bindings = [{ component: uri(main),
      profile: uri('https://rezics.com/vocab/WorkComposition'), head: uri(f.revision), generation: uri(generation),
      count: literal('100'), manifest: literal(manifestRef) }];
    else if (query.includes('SELECT ?owner')) bindings = [{ owner: uri(owner) }];
    else if (query.includes('SELECT ?manifest ?predecessor')) bindings = [{ manifest: literal(manifestRef),
      count: literal('100'), epoch: literal('epoch'), sequence: literal('1') }];
    else if (query.includes('SELECT ?target ?main')) bindings = (missingMain ? f.input.slice(1) : f.input).map(target =>
      ({ target: uri(target.resource), main: uri(derivedId(`main-for-${target.resource}`)) }));
    else return targetQuery(query);
    f.queries.push(query);
    return { results: { bindings } };
  };
  const result = await readWorkParts(f.session(), owner, { limit: 100 });
  expect(result.parts.map(part => part.work)).toEqual(f.input.map(target => target.resource));
  expect(result.parts.every(part => !!part.mainVersion)).toBe(true);
  expect(result.next).toBeNull();
  expect(scalarProbes).toBe(1);
  expect(f.hydration.map(batch => batch.length)).toEqual([64, 36]);
  expect(f.queries).toHaveLength(15);
  expect(f.queries.filter(query => query.includes('SELECT ?resource ?head'))).toHaveLength(5);
  missingMain = true;
  await expect(readWorkParts(f.session(), owner, { limit: 100 })).rejects.toBeInstanceOf(WorkReadUnavailable);
});

test('Work wholes skip a sparse range and hydrate repeated whole identities once per read', async () => {
  const input = targets(101);
  input[0]!.hidden = true;
  const f = fixture(input);
  const source = derivedId('composition-batch-contained-work');
  const projection = (target: Target, index: number) => ({ whole: uri(target.resource),
    main: uri(derivedId(`whole-main-${target.resource}`)), structure: uri(derivedId(`whole-structure-${target.resource}`)),
    occurrence: uri(derivedId(`whole-occurrence-${index}`)), segment: literal('i'), order: literal(String(index)) });
  const first = Array.from({ length: 101 }, (_, index) => projection(input[0]!, index));
  const second = input.slice(1).map((target, index) => projection(target, index + 101));
  const targetQuery = f.graph.query.bind(f.graph);
  let scalarProbes = 0, ranges = 0;
  f.graph.query = async query => {
    if (query.includes('SELECT ?main ?public')) {
      scalarProbes++;
      expect(query).toContain(`<${source}>`);
      f.queries.push(query);
      return { results: { bindings: [{ main: uri(derivedId('contained-main')), public: literal('true') }] } };
    }
    if (query.includes('SELECT ?whole ?main ?structure')) {
      f.queries.push(query);
      return { results: { bindings: ranges++ === 0 ? first : second } };
    }
    return targetQuery(query);
  };
  const result = await readWorkWholes(f.session(), source, { limit: 100 });
  expect(result.wholes.map(whole => whole.work)).toEqual(input.slice(1).map(target => target.resource));
  expect(result.next).toBeNull();
  expect(ranges).toBe(2);
  expect(scalarProbes).toBe(1);
  expect(f.hydration.map(batch => batch.length)).toEqual([64, 36]);
  // The first hidden whole still gets its initial exact parent-head statement.
  expect(f.queries).toHaveLength(14);
  expect(f.queries.filter(query => query.includes('SELECT ?resource ?head'))).toHaveLength(6);
});
