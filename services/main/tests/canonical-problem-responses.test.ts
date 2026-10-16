import { beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { TSchema } from 'typebox';
import { Value } from 'typebox/value';
import { buildMainOpenApi } from '../../../scripts/api/generate.ts';
import { FusekiClient, type CommandHealth, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import { StaleContributionDraftHead } from '../src/modules/contribution/edit.ts';
import { AgentProfileStale } from '../src/modules/agent/profile.ts';
import { RealmProfileStale } from '../src/modules/realm-profile/schema.ts';
import { StaleSemanticHead, UnavailableSemanticReference } from '../src/modules/semantic/command.ts';
import { StaleRatingObservation } from '../src/modules/rating/observation.ts';
import { EditorialBlocked, type Blocker } from '../src/modules/editorial-review/contract.ts';
import { StaleSession, type SessionState } from '../src/modules/session/contract.ts';
import { StaleEditionPreference, type EditionPreference } from '../src/modules/session/preference-contract.ts';
import { AccountAssertionDenied, AccountAssertionUnavailable } from '../src/modules/account/verify-assertion.ts';
import { operationTools, type CapabilityDocument } from '../src/modules/mcp/capabilities.ts';
import type { OwnerOutcome, ProtectionRejection } from '../src/modules/protection/content-store.ts';
import { contentRoutes } from '../src/routes/content.ts';
import { contributionRoutes } from '../src/routes/contributions.ts';
import { agentRoutes } from '../src/routes/agents.ts';
import { realmProfileRoutes } from '../src/routes/realm-profile.ts';
import { semanticRoutes } from '../src/routes/semantic.ts';
import { globalRatingRoutes } from '../src/routes/rating-global.ts';
import { ratingRoutes } from '../src/routes/ratings.ts';
import { mediaRoutes } from '../src/routes/media.ts';
import { resourceRoutes } from '../src/routes/resources.ts';
import { compositionRoutes } from '../src/routes/compositions.ts';
import { contextRoutes } from '../src/routes/contexts.ts';
import { structureProfileFor } from '../src/modules/structure/profiles.ts';
import { recordTree, orderTree } from '../src/modules/structure/change.ts';
import { newCost } from '../src/modules/structure/tree.ts';
import { sourceCorrespondence } from '../src/modules/structure/refresh.ts';
import { STRUCTURE_MANIFEST_FORMAT, STRUCTURE_PAGE_FORMAT, STRUCTURE_PROFILE,
  type StructureManifest, type OccurrenceRecord } from '../src/modules/structure/format.ts';
import type { ImmutableObjects } from '../src/infrastructure/immutable-objects.ts';
import { configureDisclosure } from '../src/modules/disclosure/read.ts';
import { configureFixtureDisclosureAncestry, fixtureDisclosureReader } from './support/disclosure-ancestry.ts';
import { sessionsRoutes } from '../src/routes/sessions.ts';
import { editorialProposalRoutes } from '../src/routes/editorial-proposals.ts';
import { protectionRoutes } from '../src/routes/protection.ts';
import { progressSummariesRoutes } from '../src/routes/progress-summaries.ts';
import { mcpRoutes } from '../src/routes/mcp.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const id = (n: number) => `https://rezics.com/id/${uuid(n)}`;
const principal = { issuer: 'https://account.test', subject: 'writer' };
const position = { datasetId: 'product', dataEpoch: 'epoch', sequence: '42' };
type Document = { paths: Record<string, Record<string, { responses: Record<string, {
  content: Record<string, { schema: TSchema }> }>; operationId: string }>> };
let declaration: Document;
beforeAll(async () => { declaration = JSON.parse(await buildMainOpenApi()) as Document; });

class Graph extends FusekiClient {
  constructor(readonly answer: (sparql: string) => SparqlResult = () => ({ boolean: true, results: { bindings: [] } })) {
    super('http://unused.test/rezics');
  }
  override async query(sparql: string): Promise<SparqlResult> { return this.answer(sparql); }
}
function dependencies(graph: Graph, extra: Record<string, unknown> = {}): MainWorkDependencies {
  return { environment: { fuseki: graph, objectDirectory: '.temp/canonical-problem-responses',
    lineage: { dataEpoch: 'epoch', routingEpoch: '0' } }, account: { verify: async () => principal },
    access: { canReadAsBaselineMember: async () => true, assertRecoveryOpen: async () => {} },
    ...extra } as unknown as MainWorkDependencies;
}
const throwingAccount = (error: Error) => ({ verify: async () => { throw error; } });
function request(path: string, body: unknown, method = 'POST') {
  return new Request(`http://main.test${path}`, { method,
    headers: { 'content-type': 'application/json', 'idempotency-key': 'contract-refusal', authorization: 'Bearer writer' },
    body: JSON.stringify(body) });
}
async function conforms(response: Response, path: string, method: string, status: number, body: unknown) {
  expect(response.status).toBe(status);
  expect(response.headers.get('content-type')?.split(';')[0]).toBe('application/problem+json');
  expect(response.headers.get('cache-control')).toContain('no-store');
  const actual = await response.json();
  expect(actual).toEqual(body);
  const operation = declaration.paths[path]![method]!;
  const content = operation.responses[String(status)]!.content;
  expect(content['application/json']).toBeUndefined();
  expect(content['application/problem+json']).toBeDefined();
  expect(Value.Check(content['application/problem+json']!.schema, actual)).toBe(true);
  expect(Value.Check(content['application/problem+json']!.schema, { ...actual, undeclaredDetail: true })).toBe(false);
}
const problemBody = (status: number, code: string, title: string, details = {}) => ({
  type: `https://rezics.com/problems/${code}`, title, status, code, ...details,
});

const protectionCalls = [
  { path: '/v1/editorial-protections', declaration: '/v1/editorial-protections',
    profile: 'content-draft-protection-v1', family: 'content-protection-change', fields: { action: 'tighten' } },
  { path: '/v1/corrections', declaration: '/v1/corrections',
    profile: 'content-draft-correction-v1', family: 'content-correction-propose', fields: { predecessor: null, body: 'Correction' } },
  { path: `/v1/corrections/${uuid(7)}/decisions`, declaration: '/v1/corrections/{proposalRevision}/decisions',
    profile: 'content-draft-correction-decision-v1', family: 'content-correction-decide',
    fields: { outcome: 'approved', expectedCandidateDigest: 'a'.repeat(64), expectedDecisionHead: null } },
] as const;
for (const call of protectionCalls) for (const [status, code] of [
  [403, 'reviewer_not_independent'], [403, 'cancelled'], [404, 'target_unavailable'], [409, 'stale_content'],
] as const) test(`Protected ${call.path} preserves ${status} ${code} and Content owner position`, async () => {
  const ownerPosition = { owner: 'content', dataEpoch: 'content-epoch', sequence: '9007199254740993' } as const;
  const operation = `${call.family}:${uuid(5)}`;
  let recorded: unknown;
  const reject = async (command: { operationId: string }): Promise<OwnerOutcome<unknown>> => {
    expect(command.operationId).toBe(operation);
    return { operationId: command.operationId, outcome: 'rejected', code: code as ProtectionRejection,
      value: null, position: ownerPosition, replayed: true };
  };
  const work = dependencies(new Graph(), {
    access: {
      register: async (input: { action: string; scope: string; requestDigest: string }) => ({ ...input,
        id: uuid(5), state: 'claimed', authorityEpoch: '1', principalId: 'writer', replayed: true }),
      claim: async () => {}, recordGraphOutcome: async (_id: string, proof: unknown) => { recorded = proof; },
    },
    editorialProtection: { changeProtection: reject, proposeCorrection: reject, decideCorrection: reject,
      readCorrection: async () => ({ proposal: { resourceId: id(1) } }) },
  });
  const response = await protectionRoutes(work).handle(request(call.path, {
    profile: call.profile, resourceId: id(1), variantId: `urn:rezics:variant:${uuid(2)}`,
    actingSubject: id(3), expectedContentHead: uuid(9), expectedProtectionHead: null,
    expectedRuleRevision: 'urn:rezics:protection-rule:independent-human-review-v1', reason: 'Retained basis',
    evidence: [], ...call.fields,
    // Decisions identify the target through the proposal, rather than through body fields.
    ...(call.family === 'content-correction-decide' ? { resourceId: undefined, variantId: undefined } : {}),
  }));
  await conforms(response, call.declaration, 'post', status,
    problemBody(status, code, 'Protected command was not applied', { operation, position: ownerPosition }));
  expect(recorded).toMatchObject({ outcome: 'cancelled', dataEpoch: ownerPosition.dataEpoch, sequence: ownerPosition.sequence });
  const schema = declaration.paths[call.declaration]!.post!.responses[String(status)]!.content['application/problem+json']!.schema;
  expect(Value.Check(schema, problemBody(status, code, 'Protected command was not applied',
    { operation, position: { ...ownerPosition, unexpected: true } }))).toBe(false);
});

const editionPreferences: (EditionPreference | null)[] = [null,
  { work: id(1), language: 'en', edition: null, version: 2 },
  ...(['realization', 'release'] as const).map(kind => ({ work: id(1), language: 'en',
    edition: { kind, resource: id(2), revision: id(9) }, version: 2 })),
];
for (const current of editionPreferences) test(`Edition preference conflict retains ${JSON.stringify(current)}`, async () => {
  const work = dependencies(new Graph(), { editionPreferences: {}, account: throwingAccount(new StaleEditionPreference(current)) });
  const response = await progressSummariesRoutes(work).handle(request(`/v1/me/edition-preferences/${uuid(1)}`,
    { actingSubject: id(3), expectedVersion: 1, language: 'en', edition: null }, 'PUT'));
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  const path = '/v1/me/edition-preferences/{work}';
  await conforms(response, path, 'put', 409,
    problemBody(409, 'stale_edition_preference', 'Edition preference changed', { current }));
  const schema = declaration.paths[path]!.put!.responses['409']!.content['application/problem+json']!.schema;
  expect(Value.Check(schema, problemBody(409, 'stale_edition_preference', 'Edition preference changed', { current: uuid(9) }))).toBe(false);
});

function mcpRequest() {
  return new Request('http://main.test/mcp', { method: 'POST',
    headers: { authorization: 'Bearer writer', 'content-type': 'application/json',
      accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/list' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientInfo': { name: 'contract-refusal', version: '1' },
      'io.modelcontextprotocol/clientCapabilities': {},
    } } }),
  });
}
function mcpContract() { return declaration as unknown as CapabilityDocument; }
function mcpScopes() {
  return [...new Set(operationTools(mcpContract()).flatMap(tool => tool.operation['x-rezics-capability']!.mcp!.scopes))].sort();
}
for (const [status, error, code] of [
  [401, new AccountAssertionDenied('expired'), 'invalid_account_assertion'],
  [503, new AccountAssertionUnavailable('unavailable'), 'account_unavailable'],
] as const) test(`Hidden MCP transport preserves ${status} about:blank authority answer and header`, async () => {
  const app = mcpRoutes({ account: throwingAccount(error),
    mcp: { issuer: 'https://account.test', resource: 'http://main.test/mcp' } },
  async () => { throw new Error('unexpected dispatch'); }, mcpContract);
  const response = await app.handle(mcpRequest());
  expect(response.status).toBe(status);
  expect(response.headers.get('content-type')?.split(';')[0]).toBe('application/problem+json');
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('www-authenticate')).toBe(status === 401
    ? `Bearer resource_metadata="http://main.test/.well-known/oauth-protected-resource/mcp", scope="${mcpScopes().join(' ')}"` : null);
  expect(response.headers.get('retry-after')).toBe(status === 503 ? '5' : null);
  expect(await response.json()).toEqual({ type: 'about:blank', title: 'Account authorization unavailable', status, code });
  expect(declaration.paths['/mcp']).toBeUndefined();
});
test('Hidden MCP preserves bodyless origin refusal, successful metadata and JSON-RPC', async () => {
  let verifies = 0;
  const app = mcpRoutes({ account: { verify: async () => { verifies++; return principal; } },
    mcp: { issuer: 'https://account.test', resource: 'http://main.test/mcp' } },
  async () => { throw new Error('unexpected dispatch'); }, mcpContract);
  const hostile = mcpRequest();
  hostile.headers.set('origin', 'https://hostile.test');
  const refused = await app.handle(hostile);
  expect(refused.status).toBe(403);
  expect(await refused.text()).toBe('');
  expect(verifies).toBe(0);
  for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    const metadata = await app.handle(new Request(`http://main.test${path}`));
    expect(metadata.status).toBe(200);
    expect(metadata.headers.get('content-type')?.split(';')[0]).toBe('application/json');
    expect(metadata.headers.get('cache-control')).toBe('no-store');
    expect(await metadata.json()).toEqual({ resource: 'http://main.test/mcp', authorization_servers: ['https://account.test'],
      scopes_supported: mcpScopes(), bearer_methods_supported: ['header'] });
    expect(declaration.paths[path]).toBeUndefined();
  }
  expect(verifies).toBe(0);
  const response = await app.handle(mcpRequest());
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')?.split(';')[0]).toBe('application/json');
  const body = await response.json() as { jsonrpc: string; id: number; result: { tools: { name: string }[] } };
  expect(body.jsonrpc).toBe('2.0');
  expect(body.id).toBe(1);
  expect(body.result.tools.map(tool => tool.name)).toEqual(operationTools(mcpContract())
    .filter(tool => tool.operation['x-rezics-exposure'] === 'public').map(tool => tool.name));
  expect(verifies).toBe(2);
});

// These are route conformance tests at dependency boundaries, not population outcomes.
for (const head of [uuid(9), null]) test(`Content superseded expectedHead retains exact current head ${head}`, async () => {
  const graph = new Graph(sparql => sparql.includes('SELECT DISTINCT ?type')
    ? { results: { bindings: [{ type: { type: 'uri', value: 'https://schema.org/CreativeWork' } }] } }
    : { boolean: true, results: { bindings: [] } });
  const admission = { id: uuid(5), state: 'claimed', authorityEpoch: '1', scope: `content:draft:${id(1)}`,
    requestDigest: 'digest', replayed: false };
  let submitted: unknown;
  const work = dependencies(graph, {
    access: { register: async () => admission, claim: async () => admission, recordGraphOutcome: async () => {} },
    contentAuthoring: {
      saveDraft: async (command: { expectedHead: string | null }) => {
        submitted = command.expectedHead;
        return { outcome: 'stale_head', revisionId: null, position: { dataEpoch: 'epoch', sequence: '42' }, replayed: false };
      }, readDraftHead: async () => head === null ? null : { revisionId: head },
    },
  });
  const response = await contentRoutes(graph, work).handle(request('/v1/content-drafts', {
    profile: 'content-text-v1', resourceId: id(1), variantId: `urn:rezics:variant:${uuid(2)}`,
    language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr',
    expectedHead: uuid(8), actingSubject: id(3), body: 'A draft edit',
  }));
  await conforms(response, '/v1/content-drafts', 'post', 409,
    problemBody(409, 'stale_head', 'Content draft head changed', { currentHead: head }));
  expect(submitted).toBe(uuid(8));
});

for (const head of [id(9), null]) test(`Contribution conflict retains currentHead ${head}`, async () => {
  const graph = new Graph(sparql => sparql.includes('SELECT')
    ? { results: { bindings: head ? [{ draft: { type: 'uri', value: head }, work: { type: 'uri', value: id(2) },
      language: { type: 'literal', value: 'en' }, author: { type: 'uri', value: id(3) } }] : [] } }
    : { boolean: true });
  const work = dependencies(graph, { account: throwingAccount(new StaleContributionDraftHead('stale')) });
  // Writer construction now requires the Content fence pool even when Account
  // refuses before admission. No database operation belongs to this scenario.
  const unusedFence = async () => { throw new Error('Unexpected Content fence query'); };
  work.environment.referenceFencePool = { query: unusedFence, connect: unusedFence } as never;
  await conforms(await contributionRoutes(graph, work).handle(request('/v1/contribution-edits', {
    profile: 'text-contribution-v1', contribution: id(1), expectedHead: id(8), actingSubject: id(3), body: 'Edit',
  })), '/v1/contribution-edits', 'post', 409,
  problemBody(409, 'stale_head', 'Expected Contribution draft revision is stale', { currentHead: head }));
});

test('Agent profile conflict retains its exact currentHead', async () => {
  const graph = new Graph();
  const work = dependencies(graph, { agentProfiles: {}, account: throwingAccount(new AgentProfileStale(id(9))) });
  await conforms(await agentRoutes(work).handle(request(`/v1/agents/${uuid(1)}/profile`, {
    profile: 'agent-public-profile-v1', expectedHead: id(8), displayName: 'Writer', avatarSelection: null, bio: null,
  }, 'PUT')), '/v1/agents/{id}/profile', 'put', 409,
  problemBody(409, 'stale_agent_profile', 'Agent profile changed', { currentHead: id(9) }));
});

for (const head of [id(9), null]) test(`Realm profile conflict retains currentHead ${head}`, async () => {
  const graph = new Graph();
  const work = dependencies(graph, { account: throwingAccount(new RealmProfileStale('Realm profile head changed', head)) });
  await conforms(await realmProfileRoutes(work).handle(request(`/v1/realms/${uuid(1)}/profile`, {
    profile: 'realm-public-profile-v2', expectedHead: id(8), actingSubject: id(3), publication: {
      name: { original: 'en', labels: { en: 'Realm' } }, description: { original: 'en', labels: { en: 'Description' } },
      iconSelection: null, bannerSelection: null, count: { kind: 'unknown', value: null }, moderators: [],
    },
  }, 'PUT')), '/v1/realms/{realm}/profile', 'put', 409,
  problemBody(409, 'stale_realm_profile', 'Realm profile head changed', { currentHead: head }));
});

for (const head of [id(9), null]) test(`Realm moderator choice conflict retains currentHead ${head}`, async () => {
  const graph = new Graph();
  const work = dependencies(graph, { account: throwingAccount(new RealmProfileStale('Moderator choice head changed', head)) });
  await conforms(await realmProfileRoutes(work).handle(request(`/v1/realms/${uuid(1)}/moderators/${uuid(3)}/public-choice`, {
    profile: 'realm-public-moderator-choice-v1', expectedHead: id(8), actingSubject: id(3), public: true,
  }, 'PUT')), '/v1/realms/{realm}/moderators/{agent}/public-choice', 'put', 409,
  problemBody(409, 'stale_realm_profile', 'Moderator choice head changed', { currentHead: head }));
});

for (const path of ['/v1/semantic/changes', '/v1/semantic/changes/bulk']) test(`Semantic stale answer retains the head on ${path}`, async () => {
  const graph = new Graph();
  const work = dependencies(graph, { semanticStages: {}, account: throwingAccount(new StaleSemanticHead('stale', id(9))) });
  const state = { component: 'resource', types: ['https://schema.org/Thing'], properties: [], lifecycle: 'active' };
  await conforms(await semanticRoutes(graph, work).handle(request(path, path.endsWith('/bulk') ? {
    profile: 'semantic-change-bulk-v1', items: [{ state, target: id(1), expectedHead: id(8) }], actingSubject: id(3),
  } : {
    profile: 'semantic-change-v1', target: id(1), expectedHead: id(8), actingSubject: id(3),
    state,
  })), path, 'post', 409,
  problemBody(409, 'stale_head', 'Expected semantic revision is stale', { currentHead: id(9) }));
});

for (const path of ['/v1/semantic/changes', '/v1/semantic/changes/bulk']) test(`Semantic reference diagnostics conform on ${path}`, async () => {
  const graph = new Graph();
  const work = dependencies(graph, { semanticStages: {},
    account: throwingAccount(new UnavailableSemanticReference(0, '/properties/0/value/ref', id(7))) });
  const state = { component: 'resource', types: ['https://schema.org/Thing'], properties: [], lifecycle: 'active' };
  await conforms(await semanticRoutes(graph, work).handle(request(path, path.endsWith('/bulk') ? {
    profile: 'semantic-change-bulk-v1', items: [{ state, expectedHead: null }], actingSubject: id(3),
  } : { profile: 'semantic-change-v1', state, expectedHead: null, actingSubject: id(3) })), path, 'post', 422,
  problemBody(422, 'unavailable_reference', 'Semantic change is not admitted', {
    itemIndex: 0, pointer: '/properties/0/value/ref', reference: id(7),
  }));
});

test('Editorial semantic refusal retains caller reference diagnostics', async () => {
  const graph = new Graph();
  const work = dependencies(graph, { account: throwingAccount(new UnavailableSemanticReference(0, '/properties/0/value/ref', id(7))) });
  await conforms(await editorialProposalRoutes(work).handle(request('/v1/editorial/proposals', {
    profile: 'editorial-proposal-create-v1', kind: 'semantic-change', target: {
      resource: id(1), revision: id(8), context: 'urn:rezics:context:global' }, candidate: {},
    baseHeads: [{ component: id(1), head: null }], evidence: [], actingSubject: id(3),
  })), '/v1/editorial/proposals', 'post', 422,
  problemBody(422, 'unavailable_reference', 'Semantic change is not admitted', {
    itemIndex: 0, pointer: '/properties/0/value/ref', reference: id(7),
  }));
});

for (const head of [id(9), null]) test(`Global rating stale answer retains head and nullable position ${head}`, async () => {
  const graph = new Graph(sparql => sparql.includes('SELECT')
    ? { results: { bindings: head ? [{ head: { type: 'uri', value: head }, dataEpoch: { type: 'literal', value: 'epoch' },
      sequence: { type: 'literal', value: '42' }, epoch: { type: 'literal', value: 'epoch' } }] : [] } }
    : { boolean: true });
  let calls = 0;
  const work = dependencies(graph, { account: { verify: async () => {
    if (++calls === 1) throw new StaleRatingObservation('stale');
    return principal;
  } }, access: { activePrincipalId: async () => uuid(3), canReadAsBaselineMember: async () => true } });
  await conforms(await globalRatingRoutes(work).handle(request('/v1/global-rating-observations', {
    profile: 'global-rating-standing-observation-v1', context: id(1), work: id(2), mainVersion: id(4),
    expectedRevisionHead: id(8), value: 4, actingSubject: id(3),
  })), '/v1/global-rating-observations', 'post', 409,
  problemBody(409, 'stale_head', 'Expected standing rating revision is stale', {
    currentHead: head, sourcePosition: head ? position : null,
  }));
});

for (const head of [id(9), null]) test(`Target rating stale answer retains currentHead ${head}`, async () => {
  const graph = new Graph(sparql => {
    if (!sparql.includes('SELECT ?observation ?head')) throw new StaleRatingObservation('stale');
    return { results: { bindings: head ? [{ observation: { type: 'uri', value: id(5) },
      head: { type: 'uri', value: head }, availability: { type: 'uri', value: 'https://rezics.com/vocab/Available' },
      value: { type: 'literal', value: '4' } }] : [] } };
  });
  const work = dependencies(graph, { access: { activePrincipalId: async () => uuid(3),
    assertRecoveryOpen: async () => {} } });
  await conforms(await ratingRoutes(graph, work).handle(request('/v1/rating-observations', {
    profile: 'realm-target-rating-observation-v1', context: id(1), target: id(2),
    expectedRevisionHead: id(8), value: 4, actingSubject: id(3),
  })), '/v1/rating-observations', 'post', 409,
  problemBody(409, 'stale_head', 'Expected standing rating revision is stale', { currentHead: head }));
});

for (const head of [uuid(9), null]) test(`Media state conflict retains current and replayed ${head}`, async () => {
  const graph = new Graph();
  const work = dependencies(graph, { access: {
    register: async (input: { requestDigest: string }) => ({ id: uuid(5), state: 'claimed',
      requestDigest: input.requestDigest, action: 'media.manage', replayed: false }),
    claim: async () => {}, recordGraphOutcome: async () => {},
  }, media: { store: { changeState: async () => ({ outcome: 'stale_head', predecessor: head,
    position: { dataEpoch: 'epoch', sequence: '42' }, replayed: true }) } } });
  await conforms(await mediaRoutes(graph, work).handle(request(`/v1/media/assets/${uuid(1)}/state`, {
    profile: 'media-asset-state-v1', expectedState: uuid(8), disclosure: 'public', lifecycle: 'active', actingSubject: id(3),
  })), '/v1/media/assets/{asset}/state', 'post', 409,
  problemBody(409, 'stale_head', 'Asset state changed', { current: head, replayed: true }));
});

for (const selection of ['avatar', 'showcase/art', 'showcase/trailer']) {
  for (const head of [uuid(9), null]) test(`Resource ${selection} conflict retains current and replayed ${head}`, async () => {
    const uri = (value: string) => ({ type: 'uri', value });
    const term = (value: string) => ({ type: 'literal', value });
    const control = { epoch: term('epoch'), sequence: term('42') };
    const graph = new Graph(sparql => {
      if (sparql.includes('ASK')) return { boolean: true };
      if (sparql.includes('SELECT ?epoch ?sequence ?hold ?r')) return { results: { bindings: [control,
        { ...control, r: uri(id(1)), type: term('work'), head: uri(id(10)), public: term('true'),
          work: uri(id(1)), label: { ...term('Work title'), 'xml:lang': 'en' } }] } };
      if (sparql.includes('SELECT ?resource ?head')) return { results: { bindings: [{ resource: uri(id(1)), head: uri(id(10)) }] } };
      if (sparql.includes('SELECT ?epoch ?sequence')) return { results: { bindings: [control] } };
      return { results: { bindings: [] } };
    });
    const stale = () => ({ outcome: 'stale_head', predecessor: head, id: null,
      position: { dataEpoch: 'epoch', sequence: '42' }, replayed: true });
    const work = dependencies(graph, { access: {
      assertRecoveryOpen: async () => {},
      register: async (input: { requestDigest: string }) => ({ id: uuid(5), state: 'claimed',
        requestDigest: input.requestDigest, action: 'media.avatar', replayed: false }),
      claim: async () => {}, recordGraphOutcome: async () => {},
    }, media: { store: {
      avatarRows: async () => ({ rows: new Map(), generation: { dataEpoch: 'epoch', sequence: '42' } }),
      selectAvatar: async () => stale(), showcase: { select: async () => stale() },
    } } });
    configureFixtureDisclosureAncestry(work.environment, target => target.work
      ? { resource: target.work, head: id(10), protectedRevision: target.workRevision } : undefined);
    configureDisclosure(work.environment, fixtureDisclosureReader(async targets => targets.map(() => 'visible')));
    const body = selection === 'avatar' ? { profile: 'resource-avatar-selection-v1', expectedSelection: uuid(8), asset: null, actingSubject: id(3) }
      : selection === 'showcase/art' ? { profile: 'work-showcase-selection-v1', expectedSelection: uuid(8),
        role: 'background-landscape', asset: null, actingSubject: id(3) }
        : { profile: 'work-showcase-trailer-v1', expectedSelection: uuid(8), url: null, actingSubject: id(3) };
    const req = request(`/v1/resources/${uuid(1)}/${selection}`, body, 'PUT');
    req.headers.delete('authorization');
    await conforms(await resourceRoutes(graph, work).handle(req), `/v1/resources/{resource}/${selection}`, 'put', 409,
      problemBody(409, 'stale_head', selection === 'avatar' ? 'Avatar selection changed' : 'Showcase selection changed',
        { current: head, replayed: true }));
  });
}

test('Structure refresh conflict retains the complete correspondence diagnostics', async () => {
  const values = new Map<string, Uint8Array>();
  const objects: ImmutableObjects = {
    put: async bytes => { const digest = createHash('sha256').update(bytes).digest('hex'); values.set(digest, bytes); return digest; },
    get: async digest => { const bytes = values.get(digest); if (!bytes) throw new Error('Missing fixture object'); return bytes; },
  };
  const manifests = new Map<string, string>();
  for (const structure of [id(1), id(2)]) {
    const cost = newCost(), records = recordTree(objects), ordered = orderTree(objects);
    const entries: OccurrenceRecord[] = structure === id(1) ? [] : [4, 5].map(n => ({
      occurrence: id(n), state: 'active', parent: structure, segmentKey: 'a', orderKey: String(n),
      role: 'chapter', target: id(6), selection: { mode: 'fixed-revision', revision: `urn:rezics:content:revision:${uuid(7)}` },
      labels: [], introducedBy: id(8), sourceKey: 'duplicate',
    }));
    const manifest: StructureManifest = { format: STRUCTURE_MANIFEST_FORMAT, structure, structureOf: id(6),
      profile: 'book-composition', generation: id(7), pageFormat: STRUCTURE_PAGE_FORMAT,
      records: await records.apply(await records.empty(cost), new Map(entries.map(row => [row.occurrence, row])), cost),
      order: await ordered.empty(cost), topGroups: await ordered.empty(cost), placementCount: entries.length,
      measures: [], model: STRUCTURE_PROFILE, shape: STRUCTURE_PROFILE };
    manifests.set(structure, `urn:rezics:sha256:${await objects.put(new TextEncoder().encode(JSON.stringify(manifest)))}`);
  }
  const uri = (value: string) => ({ type: 'uri', value });
  const graph = new Graph(sparql => {
    if (sparql.includes('ASK')) return { boolean: true };
    if (sparql.includes('SELECT ?owner')) return { results: { bindings: [{ owner: uri(id(6)) }] } };
    const structure = sparql.includes(`<${id(1)}>` ) ? id(1) : id(2);
    const manifest = manifests.get(structure)!;
    if (sparql.includes('SELECT ?component ?profile')) return { results: { bindings: [{ component: uri(id(6)),
      profile: uri(structureProfileFor('book-composition').graphProfile), head: uri(id(8)), generation: uri(id(7)),
      count: { type: 'literal', value: structure === id(1) ? '0' : '2' }, manifest: uri(manifest) }] } };
    if (sparql.includes('SELECT ?manifest')) return { results: { bindings: [{ manifest: uri(manifest) }] } };
    throw new Error(`Unexpected Structure fixture query: ${sparql.slice(0, 120)}`);
  });
  let cancelled = false;
  const work = dependencies(graph, { access: { withWorkEditAuthority: async (_principal: unknown, _actor: string,
    _work: string, run: (proof: unknown) => unknown) => run({ principalId: uuid(3), scope: `structure:${id(1)}` }),
    canReadWork: async () => true }, structureStages: { create: async () => ({ id: uuid(10), status: 'staging', revision: id(9) }),
      cancel: async () => { cancelled = true; } } });
  Object.assign(work.environment, { structureObjects: objects });
  await conforms(await compositionRoutes(graph, work).handle(request(`/v1/compositions/${uuid(1)}/refreshes`, {
    expectedHead: id(8), sourceStructure: id(2), sourceRevision: id(8), actingSubject: id(3),
  })), '/v1/compositions/{id}/refreshes', 'post', 409,
  problemBody(409, 'structure_refresh_conflict', 'Source and local changes need a correspondence decision', {
    conflicts: [{ sourceKey: sourceCorrespondence(id(2), 'duplicate'), reason: 'ambiguous-key' }],
  }));
  expect(cancelled).toBe(true);
});

for (const state of ['unavailable', 'unresolved', 'disabled'] as const) {
  test(`Statement interpretation ${state} retains its diagnostics and dependency position`, async () => {
    const uri = (value: string) => ({ type: 'uri', value });
    const term = (value: string) => ({ type: 'literal', value });
    let sealed = false;
    let admission = { id: uuid(5), authorityEpoch: '1', scope: '', requestDigest: '',
      state: 'claimed', dispatchEligible: true, replayed: false };
    const graph = new Graph(sparql => {
      if (sparql.includes('ASK')) return { boolean: !sparql.includes('InvalidProfile') };
      if (sparql.includes('SELECT ?outcome ?reason ?digest')) return { results: { bindings: sealed ? [{
        outcome: uri('https://rezics.com/vocab/Cancelled'), reason: uri('https://rezics.com/vocab/Unavailable'),
        digest: term(admission.requestDigest), id: term(admission.id), epoch: term(admission.authorityEpoch),
        scope: term(admission.scope), dataEpoch: term('epoch'), sequence: term('42'),
      }] : [] } };
      if (sparql.includes('SELECT ?epoch ?sequence')) return { results: { bindings: [{ epoch: term('epoch'), sequence: term('42') }] } };
      if (sparql.includes('SELECT ?revision ?base ?depth')) return { results: { bindings: [{
        revision: uri(id(8)), context: uri(id(1)), depth: term('0'), disclosure: uri('https://rezics.com/vocab/Public'),
        contextHead: uri(id(8)), entry: uri(id(9)), state: uri(`https://rezics.com/vocab/${state === 'disabled' ? 'Disabled' : 'Unresolved'}`),
      }] } };
      throw new Error(`Unexpected interpretation query: ${sparql.slice(0, 160)}`);
    });
    graph.commandHealth = async (): Promise<CommandHealth> => ({ moduleVersion: 'fixture', instanceId: 'fixture',
      publicSearchWriteEpoch: '1', publicSearchWriteActive: false,
      profiles: state === 'unavailable' ? {} : { 'context-v1': 'digest' } });
    graph.commandWithReceipt = async () => { sealed = true; return { status: 'guard-unmatched' }; };
    const work = dependencies(graph, { access: {
      register: async (input: { scope: string; requestDigest: string }) => { admission = { ...admission, ...input }; return admission; },
      claim: async () => admission, recordGraphOutcome: async () => {},
    } });
    await conforms(await contextRoutes(graph, work).handle(request('/v1/statements', {
      profile: 'statement-v1', speaker: { kind: 'personal' }, subject: id(2), predicate: id(4), relationDefinition: id(6),
      value: { kind: 'resource', iri: id(7) }, applicability: [], evidence: [], actingSubject: id(3),
      interpretation: { kind: 'explicit', context: id(1), semanticRevision: id(8) },
    })), '/v1/statements', 'post', 409, problemBody(409, 'interpretation_unresolved', 'Interpretation is not resolved', {
      interpretation: state === 'unavailable' ? { state } : { state, basis: 'explicit', context: id(1),
        semanticRevision: id(8), entryRevision: id(8), selectionRevision: null,
        sourcePosition: { ...position, dependencyToken: expect.stringMatching(/^[a-f0-9]{64}$/) } },
    }));
  });
}

test('Session stale answer retains current state and the submitted edit', async () => {
  const graph = new Graph();
  const target = { resource: id(2), base: 'work' as const, types: ['https://schema.org/CreativeWork'],
    work: id(2), revision: id(9), disclosure: 'public' as const };
  const current: SessionState = { id: id(1), target, state: 'active',
    startedOn: null, finishedOn: null, selections: [{ target, language: null,
      format: null, progress: 'locator' }], locators: [], completedAt: null, version: 2,
    createdAt: '2026-10-13T00:00:00Z', changedAt: '2026-10-14T00:00:00Z' };
  const submitted = { expectedVersion: 1, state: 'paused' as const };
  const work = dependencies(graph, { sessions: { write: async () => { throw new StaleSession(current, submitted); } } });
  await conforms(await sessionsRoutes(work).handle(request(`/v1/me/sessions/${uuid(1)}`, {
    actingSubject: id(3), ...submitted,
  }, 'PATCH')), '/v1/me/sessions/{id}', 'patch', 409,
  problemBody(409, 'stale_session', 'Session changed on another device', { current, submitted }));
});

const blockers: Blocker[] = [
  { code: 'stale_revision', latestRevision: 2 },
  { code: 'stale_base', expectedHeads: [{ component: id(1), head: null }], actualHeads: [{ component: id(1), head: id(9) }] },
  { code: 'self_review' }, { code: 'review_authority_required' },
  { code: 'owner_authority_required', action: 'work.edit', scope: id(1) },
  { code: 'owner_command_refused', key: 'edit', reason: 'stale_head' },
  { code: 'required_approvals', required: 2, received: 1 }, { code: 'terminal_decision', outcome: 'rejected' },
  { code: 'owner_unavailable' }, { code: 'revision_required' }, { code: 'budget_exhausted' },
  { code: 'apply_pending', operationKey: 'apply' },
];
for (const blocker of blockers) test(`Editorial ${blocker.code} retains every blocker member`, async () => {
  const graph = new Graph();
  const work = dependencies(graph, { account: throwingAccount(new EditorialBlocked(blocker)) });
  const status = ['self_review', 'review_authority_required', 'owner_authority_required'].includes(blocker.code) ? 403
    : blocker.code === 'owner_unavailable' ? 503 : 409;
  await conforms(await editorialProposalRoutes(work).handle(request('/v1/editorial/proposals', {
    profile: 'editorial-proposal-create-v1', kind: 'work-title', target: {
      resource: id(1), revision: id(8), context: 'urn:rezics:context:global' }, candidate: {},
    baseHeads: [{ component: id(1), head: null }], evidence: [], actingSubject: id(3),
  })), '/v1/editorial/proposals', 'post', status,
  problemBody(status, `editorial_${blocker.code}`, blocker.code, { blocker }));
});

const editorialCalls = [
  { suffix: '/revisions', profile: 'editorial-proposal-revise-v1', fields: { revision: 1, candidate: {},
    baseHeads: [{ component: id(1), head: null }], evidence: [] } },
  { suffix: '/reviews', profile: 'editorial-proposal-review-v1', fields: { revision: 1, outcome: 'approve', message: '' } },
  { suffix: '/decisions', profile: 'editorial-proposal-decide-v1', fields: { revision: 1, outcome: 'applied', approve: true, message: '' } },
  { suffix: '/withdrawal', profile: 'editorial-proposal-withdraw-v1', fields: { revision: 1 } },
  { suffix: '/reversal', profile: 'editorial-proposal-revert-v1', fields: { evidence: [] } },
  { suffix: '/recovery', profile: 'editorial-proposal-recover-v1', fields: {} },
] as const;
for (const call of editorialCalls) {
  for (const blocker of [blockers[1]!, blockers[2]!, blockers[8]!]) test(`Editorial ${call.suffix} declares ${blocker.code} detail`, async () => {
    const graph = new Graph();
    const work = dependencies(graph, { account: throwingAccount(new EditorialBlocked(blocker)), editorialReview: {} });
    const status = blocker.code === 'self_review' ? 403 : blocker.code === 'owner_unavailable' ? 503 : 409;
    await conforms(await editorialProposalRoutes(work).handle(request(`/v1/editorial/proposals/${uuid(1)}${call.suffix}`, {
      profile: call.profile, ...call.fields, actingSubject: id(3),
    })), `/v1/editorial/proposals/{proposal}${call.suffix}`, 'post', status,
    problemBody(status, `editorial_${blocker.code}`, blocker.code, { blocker }));
  });
}
for (const suffix of ['', `/${uuid(1)}`]) test(`Editorial GET ${suffix || 'list'} declares its conflict detail`, async () => {
  const graph = new Graph(), blocker = blockers[1]!;
  const work = dependencies(graph, { account: throwingAccount(new EditorialBlocked(blocker)), editorialReview: {} });
  const response = await editorialProposalRoutes(work).handle(new Request(`http://main.test/v1/editorial/proposals${suffix}?${suffix ? '' : 'filter=mine&'}actingSubject=${id(3)}`,
    { headers: { authorization: 'Bearer writer' } }));
  await conforms(response, `/v1/editorial/proposals${suffix ? '/{proposal}' : ''}`, 'get', 409,
    problemBody(409, `editorial_${blocker.code}`, blocker.code, { blocker }));
});
