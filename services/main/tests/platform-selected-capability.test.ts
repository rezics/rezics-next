import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { FusekiClient, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import { AdmissionDenied } from '../src/modules/access/admission.ts';
import { exposureAllows, PlatformClosed, type Exposure } from '../src/modules/access/exposure.ts';
import { compileQuery, compiledQueryCapabilities } from '../src/modules/query/compile.ts';
import { WORK_SEMANTIC_TYPES } from '../src/modules/work/activate.ts';
import { resolveFacet } from '../src/modules/facets/registry.ts';
import { openApiOperations as rightsOperations } from '../src/routes/rights.ts';
import { openApiOperations as workOperations } from '../src/routes/works.ts';
import { openApiOperations as commerceOperations } from '../src/routes/commerce.ts';
import { admittedRelationChange, admittedSemanticChange, resolvedSemanticCapabilities } from '../src/modules/semantic/admitted.ts';
import { admittedSemanticBulkChange } from '../src/modules/semantic/staging.ts';
import { prepareComponent } from '../src/modules/work/activate.ts';
import { PROFILES } from '../src/modules/semantic/schema.ts';
import { exportProfileExposure } from '../src/modules/export/readers.ts';
import { readAuthorizedExport, type ExportDependencies } from '../src/modules/export/operations.ts';
import { ContentPrivateConnection, contentPrivateProblem } from '../src/modules/search-disclosure/content-socket.ts';
import { privateSearchProblem } from '../src/modules/contribution/private-search-socket.ts';
import { queryRoutes } from '../src/routes/query.ts';
import { searchRoutes } from '../src/routes/search.ts';
import { compiledType, installRegisteredTypes } from '../src/modules/types/registry.ts';
import { semanticRoutes, semanticError } from '../src/routes/semantic.ts';
import { graphQueryRoutes } from '../src/routes/graph-queries.ts';
import { contentRoutes } from '../src/routes/content.ts';
import { contentPrivateSearchRoutes } from '../src/routes/content-private-search.ts';
import { commandError } from '../src/routes/problems.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const principal = { issuer: 'https://account.test', subject: 'reader' };
const event = 'https://schema.org/Event';
const state = (types = [event]) => ({ component: 'resource', types, properties: [], lifecycle: 'active' });
const call = (path: string, body: unknown) => new Request(`http://main.test${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer reader', 'idempotency-key': 'selected-test' },
  body: JSON.stringify(body),
});
function platform(groups: string[] = [], operations: string[] = []) {
  const calls: Array<{ exposure: Exposure | undefined; operationId: string }> = [];
  const owner = { require: async (verified: unknown, exposure: Exposure | undefined, operationId: string) => {
    expect(verified).toEqual(principal);
    calls.push({ exposure, operationId });
    if (!exposureAllows(exposure, operationId, { groups, operations, generation: 'test' })) throw new PlatformClosed();
  } };
  return { owner, calls };
}
class SelectedGraph extends FusekiClient {
  reads = 0;
  types: string[] = [];
  manifest?: string;
  occurrenceManifest?: string;
  typeResource?: string;
  override async query(query: string): Promise<SparqlResult> {
    this.reads++;
    if (query.includes('ASK')) return { boolean: true };
    if (query.includes('SELECT ?type WHERE')) return { results: { bindings:
      !this.typeResource || query.includes(`<${this.typeResource}>`)
        ? this.types.map(value => ({ type: { type: 'uri', value } })) : [] } };
    if (query.includes('SELECT ?manifest ?predecessor ?epoch ?sequence') && this.occurrenceManifest)
      return { results: { bindings: [{ manifest: { type: 'uri', value: `urn:rezics:sha256:${this.occurrenceManifest}` },
        epoch: { type: 'literal', value: 'epoch' }, sequence: { type: 'literal', value: '1' } }] } };
    if (query.includes('SELECT ?definition ?manifest') && this.manifest) return { results: { bindings: [{
      definition: { type: 'uri', value: id(20) }, manifest: { type: 'uri', value: `urn:rezics:sha256:${this.manifest}` },
    }] } };
    throw new Error('Resource owner reached');
  }
}
function fixture(groups: string[] = [], operations: string[] = []) {
  const gate = platform(groups, operations), graph = new SelectedGraph('http://localhost:1/rezics');
  let admissions = 0;
  const work = {
    environment: { fuseki: graph, lineage: { dataEpoch: 'epoch', routingEpoch: '0' }, objectDirectory: '.temp' },
    account: { verify: async () => principal }, platformAccess: gate.owner,
    access: { register: async () => { admissions++; throw new AdmissionDenied('resource grant missing'); },
      canReadSemanticResource: async () => false, canReadWork: async () => false, canReadReferences: async () => new Set(),
      assertRecoveryOpen: async () => undefined },
    semanticStages: {}, contentPrivateSearch: { settlement: { sweep: async () => undefined } },
  } as unknown as MainWorkDependencies;
  return { work, graph, ...gate, admissions: () => admissions };
}
const resourceQuery = { profile: 'resource-list-v1', context: 'global', scope: { kind: 'all' }, sort: 'newest',
  filter: { all: [{ facet: 'type', any: [event] }] } };

const releaseBrowse = (scope: { kind: 'all' } | { kind: 'realm'; realm: string },
  type?: { any?: string[]; all?: string[]; none?: string[] }) => ({
  context: scope.kind === 'realm' ? { realm: scope.realm } : 'global' as const,
  scope, sort: 'newest' as const, page: { size: 20 },
  filter: { all: [
    { facet: 'release', where: { all: [
      { facet: 'releaseLanguage', any: ['en'] },
      { facet: 'releasePlatform', any: ['Windows'] },
      { facet: 'releaseCompleteness', any: ['complete'] },
    ] } },
    ...type ? [{ facet: 'type', ...type }] : [],
  ] },
});
function emptyReleaseCatalogue(graph: SelectedGraph) {
  graph.query = async (query: string) => {
    graph.reads++;
    if (query.includes('SELECT ?epoch ?sequence')) return { results: { bindings: [
      { epoch: { type: 'literal', value: 'epoch' }, sequence: { type: 'literal', value: '1' } }] } };
    if (query.includes('a rv:Realm')) return { results: { bindings: [{
      space: { type: 'uri', value: id(9) }, realmRevision: { type: 'uri', value: id(8) },
      disclosure: { type: 'uri', value: 'https://rezics.com/vocab/Public' } }] } };
    if (query.includes('RestoreCutover') || query.includes('schema:CreativeWork')) return { results: { bindings: [] } };
    throw new Error(`unexpected release query: ${query.slice(0, 240)}`);
  };
}

test('Query selects Event exposure from admitted type conditions, and public release browse from the compiled plan', async () => {
  const f = fixture();
  const app = queryRoutes(f.graph, f.work);
  const denied = await app.handle(call('/v1/query', resourceQuery));
  expect(denied.status).toBe(403);
  expect(await denied.json()).toMatchObject({ code: 'platform_closed' });
  expect(f.graph.reads).toBe(0);
  const release = compileQuery(releaseBrowse({ kind: 'all' }));
  expect(compiledQueryCapabilities(release)).toEqual(['public']);
  const publicPlan = compileQuery({ ...resourceQuery, filter: { all: [{ facet: 'type', none: [event] }] } } as Parameters<typeof compileQuery>[0]);
  expect(compiledQueryCapabilities(publicPlan)).toEqual(['public']);
});

test('Public release browse in all and Realm scope succeeds without a commerce grant', async () => {
  for (const scope of [{ kind: 'all' } as const, { kind: 'realm' as const, realm: id(1) }]) {
    const f = fixture();
    emptyReleaseCatalogue(f.graph);
    const body = releaseBrowse(scope);
    expect(compiledQueryCapabilities(compileQuery(body))).toEqual(['public']);
    const response = await queryRoutes(f.graph, f.work).handle(call('/v1/query', body));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ profile: 'query-v1', template: 'release-works-v1',
      result: { profile: 'release-works-v1', items: [] } });
    expect(f.calls).toEqual([]);
    expect(f.graph.reads).toBeGreaterThan(0);
  }
});

test('A positive closed semantic type on a release plan stays denied without its grant', async () => {
  const product = 'https://schema.org/Product';
  installRegisteredTypes([{ definition: { ...compiledType('https://schema.org/Book')!, type: product },
    revision: '1', lifecycle: 'active' }]);
  // Release discovery admits only Work types. Event is a resource type; admit it
  // for this assertion so the compiled plan reaches the existing events gate.
  const eventAdded = !WORK_SEMANTIC_TYPES.includes(event);
  if (eventAdded) WORK_SEMANTIC_TYPES.push(event);
  try {
    for (const [type, operator, exposure] of [
      [product, 'any', 'platform:commerce'], [product, 'all', 'platform:commerce'],
      [event, 'any', 'platform:events'], [event, 'all', 'platform:events'],
    ] as const) {
      const f = fixture();
      const body = releaseBrowse({ kind: 'all' }, { [operator]: [type] });
      expect(compiledQueryCapabilities(compileQuery(body))).toEqual([exposure]);
      const response = await queryRoutes(f.graph, f.work).handle(call('/v1/query', body));
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: 'platform_closed' });
      expect(f.graph.reads).toBe(0);
      expect(f.calls).toEqual([{ exposure, operationId: 'postV1Query' }]);
    }
    const byId = releaseBrowse({ kind: 'all' }, { any: [product] });
    byId.filter.all[1] = { facet: resolveFacet('type')!.id, any: [product] };
    expect(compiledQueryCapabilities(compileQuery(byId))).toEqual(['platform:commerce']);
  } finally {
    const index = WORK_SEMANTIC_TYPES.indexOf(event);
    if (eventAdded && index >= 0) WORK_SEMANTIC_TYPES.splice(index, 1);
    installRegisteredTypes([]);
  }
});

test('A negative-only type filter on a release plan does not request a grant', async () => {
  const product = 'https://schema.org/Product';
  installRegisteredTypes([{ definition: { ...compiledType('https://schema.org/Book')!, type: product },
    revision: '1', lifecycle: 'active' }]);
  const eventAdded = !WORK_SEMANTIC_TYPES.includes(event);
  if (eventAdded) WORK_SEMANTIC_TYPES.push(event);
  try {
    for (const type of ['https://schema.org/Book', product, event]) {
      const f = fixture();
      emptyReleaseCatalogue(f.graph);
      const body = releaseBrowse({ kind: 'all' }, { none: [type] });
      expect(compiledQueryCapabilities(compileQuery(body))).toEqual(['public']);
      const response = await queryRoutes(f.graph, f.work).handle(call('/v1/query', body));
      expect(response.status).toBe(200);
      expect(f.calls).toEqual([]);
    }
  } finally {
    const index = WORK_SEMANTIC_TYPES.indexOf(event);
    if (eventAdded && index >= 0) WORK_SEMANTIC_TYPES.splice(index, 1);
    installRegisteredTypes([]);
  }
});

test('Offerings, sales and fixed-release commands stay commerce gated', () => {
  expect(rightsOperations['/v1/rights/offerings'].post.exposure).toBe('platform:commerce');
  expect(rightsOperations['/v1/rights/offerings/{offering}/changes'].post.exposure).toBe('platform:commerce');
  expect(workOperations['/v1/fixed-releases'].post.exposure).toBe('platform:commerce');
  expect(workOperations['/v1/fixed-releases/{release}'].get.exposure).toBe('platform:commerce');
  for (const path of ['/v1/subscriptions/changes', '/v1/subscriptions/gifts', '/v1/subscriptions/quotes',
    '/v1/subscriptions/reconciliations', '/v1/subscriptions/settlements'] as const) {
    expect(commerceOperations[path].post.exposure).toBe('platform:commerce');
  }
});

test('An operation grant opens only its selected query operation; public queries require no platform read', async () => {
  const wrong = fixture([], ['postV1Queries']);
  expect((await queryRoutes(wrong.graph, wrong.work).handle(call('/v1/query', resourceQuery))).status).toBe(403);
  const allowed = fixture([], ['postV1Query']);
  const response = await queryRoutes(allowed.graph, allowed.work).handle(call('/v1/query', resourceQuery));
  expect((await response.json() as { code: string }).code).not.toBe('platform_closed');
  expect(allowed.graph.reads).toBeGreaterThan(0);
  const publicRead = fixture();
  await queryRoutes(publicRead.graph, publicRead.work).handle(call('/v1/query', { ...resourceQuery, filter: { all: [] } }));
  expect(publicRead.calls).toHaveLength(0);
});

test('Validated keyword profiles cannot open a closed admitted Work type through complete search or pagination', async () => {
  installRegisteredTypes([{ definition: { ...compiledType('https://schema.org/Book')!, type: 'https://schema.org/Product' },
    revision: '1', lifecycle: 'active' }]);
  try {
    const f = fixture(); const app = searchRoutes(f.graph, f.work);
    for (const [path, profile] of [['/v1/queries', 'public-main-phrase-v1'],
      ['/v1/queries/page', 'public-main-phrase-page-v1']]) {
      const response = await app.handle(call(path!, { profile, phrase: 'public description', language: null,
        includeTypes: ['https://schema.org/Product'], ...(path!.endsWith('/page') ? { pageSize: 20 } : {}) }));
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: 'platform_closed' });
    }
    expect(f.graph.reads).toBe(0);
  } finally { installRegisteredTypes([]); }
});

for (const [types, capability] of [[[event], 'events'], [['https://schema.org/Offer'], 'commerce']] as const) {
  test(`Generic semantic ${capability} creation refuses before resource admission and preserves 403`, async () => {
    const denied = fixture();
    const response = await semanticRoutes(denied.graph, denied.work).handle(call('/v1/semantic/changes', {
      profile: 'semantic-change-v1', expectedHead: null, actingSubject: id(1), state: state([...types]),
    }));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'platform_closed' });
    expect(denied.admissions()).toBe(0);
    const allowed = fixture([capability]);
    const failure = await admittedSemanticChange(allowed.work.environment, allowed.work.account, allowed.work.access,
      call('/v1/semantic/changes', {}), { expectedHead: null, actingSubject: id(1), state: state([...types]), idempotencyKey: 'allowed' }, allowed.owner)
      .then(() => null, error => error);
    expect(failure).toBeInstanceOf(AdmissionDenied);
    expect(allowed.admissions()).toBe(1);
  });
}

test('Removing a retained Event type cannot open an edit, including metadata-only Work edits', async () => {
  const f = fixture(); f.graph.types = [event];
  const rejected = await admittedSemanticChange(f.work.environment, f.work.account, f.work.access,
    call('/v1/semantic/changes', {}), { target: id(2), expectedHead: id(3), actingSubject: id(1),
      state: state(['https://schema.org/Thing']), idempotencyKey: 'remove' }, f.owner).then(() => null, error => error);
  expect(rejected).toBeInstanceOf(PlatformClosed);
  const response = await contentRoutes(f.graph, f.work).handle(call('/v1/content-edits', {
    profile: 'metadata-only-v1', work: id(2), expectedHead: id(3), title: 'Public description', actingSubject: id(1),
  }));
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ code: 'platform_closed' });
  expect(f.admissions()).toBe(0);
});

test('Bulk admission checks every validated item before staging, including mixed closed capabilities', async () => {
  const f = fixture(['events']);
  const failure = await admittedSemanticBulkChange({ env: f.work.environment, account: f.work.account, access: f.work.access,
    platformAccess: f.owner, store: f.work.semanticStages!, request: call('/v1/semantic/changes/bulk', {}), actingSubject: id(1),
    idempotencyKey: 'bulk', states: [state(['https://schema.org/Thing']), state(), state(['https://schema.org/Product'])] })
    .then(() => null, error => error);
  expect(failure).toBeInstanceOf(PlatformClosed);
  expect(f.calls.map(item => item.exposure)).toEqual(['platform:events', 'platform:commerce']);
  expect(f.admissions()).toBe(0);
});

test('Relation changes bind exposure to the retained definition and canonical participants', async () => {
  const f = fixture(); f.graph.types = [event];
  const directory = mkdtempSync(resolve('.temp/selected-relation-'));
  try {
    f.work.environment.objectDirectory = directory;
    f.graph.manifest = prepareComponent(directory, id(20), { component: 'definition', kind: 'relation', lifecycle: 'active',
      successor: null, roles: [{ key: 'member', minParticipants: 1, maxParticipants: 1, ordered: false }] }, PROFILES.definition);
    await expect(admittedRelationChange(f.work.environment, f.work.account, f.work.access,
      call('/v1/relations/changes', {}), { expectedHead: null, actingSubject: id(1), idempotencyKey: 'relation',
        input: { definition: id(21), participations: [{ role: 'member', participant: { kind: 'resource', ref: id(2) } }] } }, f.owner))
      .rejects.toBeInstanceOf(PlatformClosed);
    expect(f.admissions()).toBe(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Removing a closed participant retains its capability from the exact previous relation revision', async () => {
  const f = fixture(); f.graph.types = [event]; f.graph.typeResource = id(2);
  const directory = mkdtempSync(resolve('.temp/selected-relation-'));
  try {
    f.work.environment.objectDirectory = directory;
    f.graph.manifest = prepareComponent(directory, id(20), { component: 'definition', kind: 'relation', lifecycle: 'active',
      successor: null, roles: [{ key: 'member', minParticipants: 1, maxParticipants: 1, ordered: false }] }, PROFILES.definition);
    f.graph.occurrenceManifest = prepareComponent(directory, id(30), { definition: id(21), lifecycle: 'active', applicability: [],
      participations: [{ iri: id(40), role: `${id(20)}/role/member`, participant: { kind: 'resource', ref: id(2) } }] }, PROFILES.relation);
    await expect(admittedRelationChange(f.work.environment, f.work.account, f.work.access,
      call('/v1/relations/changes', {}), { occurrence: id(30), expectedHead: id(31), actingSubject: id(1), idempotencyKey: 'remove-member',
        input: { definition: id(21), participations: [{ role: 'member', participant: { kind: 'resource', ref: id(3) } }] } }, f.owner))
      .rejects.toBeInstanceOf(PlatformClosed);
    expect(f.admissions()).toBe(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Graph profile admission retains both direct one-hop reads and rejects unadmitted SPARQL shapes', async () => {
  const f = fixture(); const app = graphQueryRoutes(f.work);
  for (const body of [{ profile: 'statement-graph-v1', anchor: id(2), direction: 'outgoing', actingSubject: id(1) },
    { profile: 'relation-graph-v1', anchor: { kind: 'resource', id: id(2) }, definition: id(3), fromRole: 'from', toRole: 'to',
      direction: 'outgoing', roleBindings: [], actingSubject: id(1) }]) {
    const response = await app.handle(call('/v1/graph/queries', body));
    expect((await response.json() as { code: string }).code).not.toBe('platform_closed');
  }
  expect(f.calls).toHaveLength(0);
  expect((await app.handle(call('/v1/graph/queries', { profile: 'sparql', query: 'SELECT * WHERE {?s ?p ?o}' }))).status).toBe(422);
});

test('Private Content HTTP and WebSocket bind Event exposure to the server resource before any lease or match', async () => {
  const f = fixture(); f.graph.types = [event];
  const body = { profile: 'private-content-phrase-v1', resource: id(2), variant: `urn:rezics:variant:${id(3).split('/').at(-1)}`,
    actingSubject: id(1), phrase: 'public description' };
  const response = await contentPrivateSearchRoutes(f.work).handle(call('/v1/private-content-queries', body));
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ code: 'platform_closed' });
  const frames: string[] = [], closes: number[] = [];
  const connection = new ContentPrivateConnection(f.work.environment, f.work.contentPrivateSearch!, principal,
    { send: frame => { frames.push(frame); return 1; }, close: code => { closes.push(code); }, terminate: () => undefined }, f.owner);
  await connection.message({ type: 'private-content-query-v1', ...body });
  expect(frames.map(frame => JSON.parse(frame))).toEqual([expect.objectContaining({ status: 403, code: 'platform_closed' })]);
  expect(closes).toEqual([4403]);
  await connection.closed();
});

test('Private export download uses the stored target profile and its own operation grant before source hydration', async () => {
  for (const grants of [[], ['postV1Exports']]) {
    const f = fixture([], grants);
    const deps = { account: f.work.account, access: { activePrincipalId: async () => 'principal' },
      readers: { env: f.work.environment, platformAccess: f.owner }, store: { read: async () => ({
        plan: { targetProfile: 'rezics-semantic-values-v1', members: [] } }) } } as unknown as ExportDependencies;
    await expect(readAuthorizedExport(deps, new Request('http://main.test/v1/exports/test'), 'test')).rejects.toBeInstanceOf(PlatformClosed);
    expect(f.calls).toEqual([{ exposure: 'platform:dataset-dumps', operationId: 'getV1ExportsByExport' }]);
  }
  expect(exportProfileExposure('rezics-main-version-v1')).toBe('platform:dataset-dumps');
  expect(exportProfileExposure('future-whole-dataset-v1')).toBe('platform:dataset-dumps');
  expect(exportProfileExposure('rezics-wiki-v1')).toBe('public');
});

test('Owner problem adapters retain the platform refusal without translating it to an availability failure', async () => {
  for (const adapter of [commandError, semanticError]) {
    const response = adapter(new PlatformClosed());
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'platform_closed' });
  }
  for (const adapter of [privateSearchProblem, contentPrivateProblem]) expect(adapter(new PlatformClosed())).toMatchObject({ status: 403, code: 'platform_closed' });
  const f = fixture();
  const resolved = await resolvedSemanticCapabilities(f.work.environment, []);
  expect(resolved).toEqual(['public']); expect(f.graph.reads).toBe(0);
});
