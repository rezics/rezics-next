import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startMediaStack, type MediaStack } from '../../../tests/qa/integration/media-support.ts';
import { grantFixtureAuthority, registerFixtureIdentity } from '../src/modules/access/fixture-authority.ts';
import type { VerifiedPrincipal } from '../src/modules/access/admission.ts';
import { backfillCatalogueNames } from '../src/modules/search/names.ts';
import { iri, lit } from '../src/modules/work/activate.ts';
import { DEFAULT_MEDIA_CONTEXT } from '../src/modules/media/store.ts';
import { PUBLIC_SEARCH_GRAPH } from '../src/modules/work/select-main.ts';
import { automaticDiscovery } from '../src/modules/discovery/automation.ts';
import { projectDiscoveryBatch } from '../src/modules/discovery/source.ts';
import { workRead } from '../src/modules/work/read-session.ts';
import { digest } from '../src/modules/recommendation/derived-generation.ts';

type Member = Awaited<ReturnType<typeof fixtureMember>>;
let stack: MediaStack;
let closing: Member;
let reader: Member;
let person: string;
let similar: string;
let work: string;
const marker = randomUUID().replaceAll('-', '');
const name = `Ended${marker} Author Person`;
const alias = `alias${marker.slice(0, 20)}`;
const similarName = `Ended${marker} Authorship`;
const absent = `Absent${marker}`;
type EntityPage = { result: { items: Array<{ id: string }>; count: { value: number } } };

const bearers = new Map<string, VerifiedPrincipal>();

async function fixtureMember(subject: string) {
  const principal = { issuer: 'https://qa-person-disclosure.test', subject, emailVerified: true };
  const principalId = randomUUID();
  const actor = `https://rezics.com/id/${randomUUID()}`;
  const token = randomUUID();
  const client = await stack.accessPool.connect();
  try {
    await client.query('BEGIN');
    await registerFixtureIdentity(client, { principalId, ...principal, actor });
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  bearers.set(token, principal);
  const grant = async (scope: string, action: string) => {
    const client = await stack.accessPool.connect();
    try {
      await client.query('BEGIN');
      const lifetime = action === 'agent.control' ? 'infinity' : '8 hours';
      await grantFixtureAuthority(client, { scope, requireDispatch: true,
        representations: [{ principalId, actor, action, lifetime }],
        grant: { actor, action, lifetime } });
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  };
  const send = (method: string, path: string, body?: unknown) =>
    stack.call(method, path, { token, body, key: randomUUID() });
  return { principal, principalId, actor, token, grant, send };
}

async function json<T>(response: Response, status = 200): Promise<T> {
  const body = await response.text();
  expect(response.status, body).toBe(status);
  return JSON.parse(body) as T;
}

async function provision(member: Member, displayName: string): Promise<string> {
  return (await json<{ agent: string }>(await member.send('POST', '/v1/agents', {
    profile: 'agent-provision-v1', kind: 'person', displayName,
  }), 201)).agent;
}

function entities(q: string, token?: string) {
  return stack.call('POST', '/v1/query', { token, body: {
    profile: 'resource-list-v1', context: 'global', scope: { kind: 'all' },
    sort: 'relevance', q, limit: 64,
    filter: { all: [{ facet: 'type', any: ['https://rezics.com/vocab/Agent'] }] },
  } });
}

function handle(token?: string) {
  return stack.call('GET', `/v1/handles/${alias}`
    + (token ? `?actingSubject=${encodeURIComponent(similar)}` : ''), { token });
}

function address(token?: string) {
  return stack.call('POST', '/v1/addresses/resolutions', { token, body: {
    lookups: [{ scope: 'agent', key: alias }], ...(token ? { actingSubject: similar } : {}),
  } });
}

function fields(phrase: string, token?: string, resource = person) {
  return stack.call('POST', '/v1/queries', { token, body: {
    profile: 'public-disclosed-fields-phrase-v1', phrase, resources: [resource],
    contexts: [], statements: [], mediaContext: DEFAULT_MEDIA_CONTEXT, language: null,
  } });
}

function phraseSearch(phrase: string, token?: string) {
  return stack.call('POST', '/v1/queries', { token, body: {
    profile: 'public-main-phrase-v1', phrase, language: null,
  } });
}

beforeAll(async () => {
  stack = await startMediaStack('person-ended-name-search');
  // Replace only the Account bearer table; Access owns every fixture identity.
  stack.composition.dependencies.account.verify = async request => {
    const principal = bearers.get(request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '');
    if (!principal) throw new Error('unknown fixture bearer');
    return { ...principal, currentAssertion: async () => principal };
  };
  closing = await fixtureMember(`closing-${marker}`);
  reader = await fixtureMember(`reader-${marker}`);
  person = await provision(closing, name);
  similar = await provision(reader, similarName);
  await json(await closing.send('POST', '/v1/addresses/claims', {
    profile: 'alias-write-v1', operation: 'claim', scope: 'agent', holder: person,
    actingSubject: person, alias, expectedRevision: null,
  }), 201);
  work = (await stack.publicWork(reader.actor, ['en'], `Surviving${marker} Work`)).work;
  await reader.grant(`work:edit:${work}`, 'work.edit');
  const path = `/v1/works/${work.slice(-36)}`;
  const head = await json<{ revision: string }>(await stack.call('GET', path));
  await json(await reader.send('POST', `${path}/agent-credits`, {
    profile: 'native-agent-credit-v1', credit: `https://rezics.com/id/${randomUUID()}`,
    agent: person, role: 'author', expectedWorkHead: head.revision, actingSubject: reader.actor,
  }), 201);
  // Resource Query requires a qualified discovery generation even when the
  // selected name population contains only Agents. Use its real projector.
  const deps = stack.composition.dependencies;
  const projection = deps.discovery!;
  await workRead(deps, new Request('http://main.internal/name-search-fixture'), {}, async session => {
    const operator = automaticDiscovery(null);
    const basis = { scope: 'global' as const, realm: null, context: null };
    const generation = await projection.register(operator, basis, session.position,
      { idempotencyKey: randomUUID(), requestDigest: digest(basis) });
    const step = await projection.beginStep(operator, generation.generation_id, '');
    const result = await projectDiscoveryBatch(session, basis, '', { works: [work] });
    expect(result.complete).toBe(true);
    await projection.commitBatch(operator, generation.generation_id, step.lease, '', result, session.position);
    expect((await projection.activate(operator, generation.generation_id, generation.active_head, session.position,
      { idempotencyKey: randomUUID(), requestDigest: digest({ generation: generation.generation_id }) })).outcome)
      .toBe('succeeded');
  });
}, 180_000);

afterAll(async () => { await stack?.stop(); });

test('name, alias, phrase and entity search find the live Person before Account deletion', async () => {
  for (const token of [undefined, reader.token]) {
    const results = await json<EntityPage>(await entities(name, token));
    expect(results.result.items.map(item => item.id)).toContain(person);
    expect(await json(await handle(token)))
      .toMatchObject({ id: person, displayName: name });
    expect(await json(await address(token)))
      .toMatchObject({ results: [{ status: 'resolved', holder: person }] });
    expect(await json(await fields(name, token))).toMatchObject({ total: 1, facets: { names: 1 } });
    expect(await json(await phraseSearch(name, token))).toMatchObject({ results: [expect.objectContaining({ work })] });
  }
}, 60_000);

test('Account deletion with consent ends the Person without removing indexed names', async () => {
  expect((await stack.access.strongDeactivateAccountSubject(closing.principal.issuer,
    closing.principal.subject, { leaveOwnedAgentsStanding: true }))?.principalId).toBe(closing.principalId);
  expect((await stack.accessPool.query('SELECT active FROM access.authority_subject WHERE id = $1', [person])).rows)
    .toEqual([{ active: false }]);
  expect((await stack.fuseki.query(`ASK { GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
    ?unit <https://rezics.com/vocab/resource> ${iri(person)} ;
      <https://rezics.com/vocab/publicTitle> ${lit(name)} } }`)).boolean).toBe(true);
}, 60_000);

for (const phase of ['retained', 'refreshed'] as const) {
  test(`${phase} name index keeps the ended Person absent from phrase and entity searches without hiding a similar live Person`, async () => {
    if (phase === 'refreshed') expect(await backfillCatalogueNames(stack.env)).toBeGreaterThan(0);
    for (const token of [undefined, reader.token]) {
      const never = await json<EntityPage>(await entities(absent, token));
      expect(never.result.items).toEqual([]);
      for (const q of [name, alias, `agent-${person.slice(-36)}`, person]) {
        const result = await json<EntityPage>(await entities(q, token));
        expect(result.result.items).toEqual(never.result.items);
        expect(result.result.count.value).toBe(0);
        expect(JSON.stringify(result.result.items)).not.toContain(person);
      }
      for (const q of [name, alias]) {
        expect(await json(await fields(q, token))).toMatchObject({ total: 0, results: [],
          facets: { names: 0 } });
        expect(await json(await phraseSearch(q, token))).toMatchObject({ total: 0, results: [] });
        const catalogue = await json<{ results: unknown[]; count: { value: number } }>(await stack.call('GET',
          `/v1/search/catalogue?q=${encodeURIComponent(q)}`, { token }));
        expect(catalogue.results).toEqual([]);
        expect(catalogue.count.value).toBe(0);
      }
      expect(await json(await handle(token), 404))
        .toMatchObject({ status: 404 });
      expect(await json<{ results: Array<{ scope: string; key: string; status: string }> }>(await address(token)))
        .toEqual({ results: [{ scope: 'agent', key: alias, status: 'unavailable' }] });
      const live = await json<EntityPage>(await entities(`Ended${marker}`, token));
      expect(live.result.items.map(item => item.id)).toEqual([similar]);
      expect(await json(await fields(similarName, token, similar))).toMatchObject({ total: 1 });
    }
  }, 90_000);
}
