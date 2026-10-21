import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { Value } from 'typebox/value';
import { FusekiClient, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import { configureDisclosure } from '../src/modules/disclosure/read.ts';
import { PROFILES } from '../src/modules/semantic/schema.ts';
import { resourceCard, type ResourceListPlan } from '../src/modules/query/resource-contract.ts';
import { resourceCards, readResourceList } from '../src/modules/query/resources.ts';
import { resourceTypeKinds } from '../src/modules/query/work-drive.ts';
import { searchGraphSnapshot } from '../src/modules/search/snapshot-state.ts';
import { ANONYMOUS_VIEWER } from '../src/modules/suitability/policy.ts';
import { WorkReadInvalid, WorkReadUnavailable, type WorkReadSession } from '../src/modules/work/read-session.ts';
import { configureFixtureDisclosureAncestry, fixtureDisclosureReader } from './support/disclosure-ancestry.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const uri = (value: string) => ({ type: 'uri' as const, value });
const literal = (value: string) => ({ type: 'literal' as const, value });
const semanticType = 'https://example.org/CelestialBody';
const plan: ResourceListPlan = { input: { profile: 'resource-list-v1', context: 'global',
  scope: { kind: 'all' }, sort: 'newest', limit: 20 }, conditions: [] };

/** Actual query continuation and immutable-manifest summary reader, with
 * controlled native/Access/Disclosure ports. This is not live public proof. */
function fixture() {
  const entries = Array.from({ length: 100 }, (_, n) => ({ id: id(n + 1), summary: id(n + 1),
    kind: n % 3 ? 'resource' as const : 'post' as const, order: String(1000 - n),
    types: n % 3 ? [semanticType] : ['https://rezics.com/vocab/Post'] }));
  const state = { private: false, grantedOnly: false, withheld: false, deliveryHidden: false };
  const objects = new Map<string, Buffer>(), manifests = new Map<string, string>();
  const store = (value: object) => {
    const bytes = Buffer.from(JSON.stringify(value));
    const digest = createHash('sha256').update(bytes).digest('hex');
    objects.set(digest, bytes); return { digest, bytes: bytes.length };
  };
  for (const entry of entries.filter(entry => entry.kind === 'resource')) {
    const payload = store({ format: 'rezics-component-v1', component: entry.id, state: {
      component: 'resource', lifecycle: 'active', types: entry.types,
      properties: [{ predicate: 'https://schema.org/name', value: { kind: 'language-string',
        lexical: `Named body ${entry.id.slice(-12)}`, language: 'en' } }],
    } });
    const manifest = store({ format: 'rezics-manifest-v1', component: entry.id,
      model: PROFILES.resource, shape: PROFILES.resource, mediaType: 'application/json',
      payload: `sha256:${payload.digest}`, payloadBytes: payload.bytes });
    manifests.set(entry.id, `urn:rezics:sha256:${manifest.digest}`);
  }
  const directoryLimits: number[] = [], authorities: unknown[][] = [];
  const graph = new FusekiClient('http://public-name-owner-inputs.invalid');
  const refs = (body: string, variable: string) => [...(new RegExp(`VALUES \\?${variable} \\{([^}]+)\\}`)
    .exec(body)?.[1] ?? '').matchAll(/<([^>]+)>/g)].map(match => match[1]!);
  graph.query = async (body): Promise<SparqlResult> => {
    const control = { epoch: literal('epoch'), sequence: literal('7') };
    if (body.includes('SELECT ?page WHERE')) {
      const args = body.match(/"(?:\\.|[^"\\])*"/g)!.map(value => JSON.parse(value) as string);
      const after = args[1] ? JSON.parse(args[1]) as { id: string } : undefined;
      const scope = JSON.parse(args[2]!) as { names: string; directory: string };
      const limit = Number(/rv:publicTitle, "(?:\\.|[^"\\])*", (\d+)/.exec(body)![1]);
      directoryLimits.push(limit);
      const candidates = entries.filter(entry => entry.kind === scope.names).map(entry => ({
        id: `urn:rezics:search:directory:${entry.kind}:${scope.directory}:${String(10n ** 40n - 1n - BigInt(entry.order)).padStart(40, '0')}:${entry.id.split('/').at(-1)}`,
        key: entry.id, score: '0',
      })).filter(entry => !after || entry.id > after.id);
      return { results: { bindings: [{ page: literal(JSON.stringify({ hits: candidates.slice(0, limit),
        more: candidates.length > limit, commit: '1' })) }] } };
    }
    if (body.includes('SELECT DISTINCT ?r ?kind ?summary')) return { results: { bindings:
      entries.filter(entry => refs(body, 'r').includes(entry.id) && !state.private).map(entry => ({
        r: uri(entry.id), summary: uri(entry.id), kind: literal(entry.kind), resourceType: uri(entry.types[0]!),
      })) } };
    if (body.includes('SELECT ?epoch ?sequence ?hold ?r')) return { results: { bindings: [control,
      ...entries.filter(entry => refs(body, 'r').includes(entry.id)).map(entry => ({ ...control,
        r: uri(entry.id), type: literal('resource'), head: uri(id(900)), public: literal(String(!state.private)),
        ...(entry.kind === 'post' ? { post: literal('true'), label: { ...literal('Discussion title'), 'xml:lang': 'en' } } : {}),
      }))] } };
    if (body.includes('SELECT ?resource ?manifest')) return { results: { bindings:
      refs(body, 'resource').filter(reference => manifests.has(reference)).map(resource => ({
        resource: uri(resource), manifest: uri(manifests.get(resource)!),
      })) } };
    throw new Error(`Unexpected public-name fixture query: ${body.slice(0, 180)}`);
  };
  const environment = { fuseki: graph, lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' },
    objectDirectory: '.temp/unused-public-name-objects', workObjects: {
      put: async (bytes: Uint8Array) => {
        const digest = createHash('sha256').update(bytes).digest('hex');
        objects.set(digest, Buffer.from(bytes)); return digest;
      },
      get: async (digest: string, maximum?: number) => {
        const bytes = objects.get(digest);
        if (!bytes || (maximum !== undefined && bytes.byteLength > maximum)) throw new Error('Missing or oversized fixture object');
        return Buffer.from(bytes);
      },
    } };
  configureFixtureDisclosureAncestry(environment, () => undefined);
  configureDisclosure(environment, fixtureDisclosureReader(async targets => targets.map(() =>
    state.withheld ? 'hidden' : 'visible')));
  const observed = new Map<string, { token: unknown; read: () => Promise<unknown> }>();
  const session = { request: new Request('http://main.test/v1/query'), viewer: ANONYMOUS_VIEWER,
    principal: { issuer: 'account', subject: 'editor' }, options: {}, displayLanguages: ['en'],
    position: { dataEpoch: 'epoch', sequence: '7' }, fencesSelectedUnits: true,
    query: async (body: string) => (await graph.query(body)).results?.bindings ?? [],
    disclosure: async (targets: readonly unknown[]) => targets.map(() => state.deliveryHidden ? 'hidden' : 'visible'),
    observeDependency: (key: string, token: unknown, read: () => Promise<unknown>) => { observed.set(key, { token, read }); return ''; },
    deps: { environment, mediaAccess: { canReadSemantics: async (...args: unknown[]) => {
      authorities.push(args);
      return { public: new Set(state.private || state.grantedOnly ? [] : args[2] as string[]),
        granted: new Set(state.grantedOnly ? args[2] as string[] : []) };
    } }, discovery: { active: async () => ({ generation_id: 'generation', stale: false }),
      resourcePage: async () => [], conceptPage: async () => [], conceptCounts: async () => [],
    }, access: { realmDirectory: { page: async () => ({ rows: [], next: null, position: 'directory',
      sourcePosition: { dataEpoch: 'epoch', sequence: '7' } }), fence: async () => {} } } },
  } as unknown as WorkReadSession;
  const read = (input = plan) => {
    directoryLimits.length = 0;
    return searchGraphSnapshot.run({ clients: new Set([graph]), lineage: environment.lineage,
      position: { dataEpoch: 'epoch', sequence: '7', generation: 'generation', population: entries.length,
        serverInstanceId: 'instance', publicSearchWriteEpoch: '0' } }, () => readResourceList(session, input));
  };
  return { session, entries, state, read, directoryLimits, authorities, observed };
}

test('generic Resource/Post pages share the bounded All seek, round-trip every cursor and finish without loss', async () => {
  const f = fixture(), seen: string[] = [];
  let cursor: string | undefined;
  for (let n = 0; n < 12; n++) {
    const page = await f.read({ ...plan, input: { ...plan.input, ...(cursor ? { cursor } : {}) } });
    expect(f.directoryLimits.reduce((sum, limit) => sum + limit, 0)).toBeLessThanOrEqual(512);
    expect(page.items.every(item => Value.Check(resourceCard, item))).toBe(true);
    seen.push(...page.items.map(item => item.id));
    expect(new Set(seen).size).toBe(seen.length);
    expect(page.count).toEqual({ value: seen.length, kind: page.complete ? 'exact' : 'at-least' });
    if (page.complete) { expect(seen).toEqual(f.entries.map(entry => entry.id)); break; }
    expect(page.nextCursor).not.toBeNull();
    expect(page.nextCursor!.length).toBeLessThanOrEqual(2048);
    cursor = page.nextCursor!;
  }
  expect(seen).toHaveLength(100);
  expect(f.authorities.length).toBeGreaterThan(0);
  expect(f.authorities.every(args => args[0] === null && args[1] === null)).toBe(true);
});

test('generic cards use exact semantic manifests, preserve Post identity and require current public Access', async () => {
  const f = fixture(), candidates = f.entries.slice(0, 2);
  const cards = await resourceCards(f.session, candidates);
  expect(cards).toMatchObject([{ id: id(1), kind: 'post', name: { value: 'Discussion title' } },
    { id: id(2), kind: 'resource', types: [semanticType], name: { value: 'Named body 000000000002' } }]);
  f.state.grantedOnly = true;
  expect((await resourceCards(f.session, candidates)).map(card => card.id)).toEqual([id(1)]);
  f.state.private = true;
  expect(await resourceCards(f.session, candidates)).toEqual([]);
  delete f.session.deps.mediaAccess;
  await expect(resourceCards(f.session, candidates)).rejects.toBeInstanceOf(WorkReadUnavailable);
});

test('current summary withdrawal and the final delivery fence remove projected names', async () => {
  const f = fixture(), candidates = f.entries.slice(0, 2);
  await resourceCards(f.session, candidates);
  const dependency = [...f.observed].find(([key]) => key.startsWith('resource-cards:'))![1];
  f.state.withheld = true;
  expect(await dependency.read()).not.toEqual(dependency.token);
  expect(await resourceCards(f.session, candidates)).toEqual([]);
  f.state.withheld = false; f.state.deliveryHidden = true;
  expect(await resourceCards(f.session, candidates)).toEqual([]);
});

test('Resource types retain every compatible owner and cursors cannot cross selections', async () => {
  expect(resourceTypeKinds([{ facet: 'type', operator: 'any', values: [semanticType] }],
    [{ type: semanticType, base: 'resource' }])).toContain('resource');
  expect(resourceTypeKinds([{ facet: 'type', operator: 'any', values: [semanticType] }],
    [{ type: semanticType, base: 'resource' }])).toContain('work');
  expect(resourceTypeKinds([{ facet: 'type', operator: 'any', values: ['https://rezics.com/vocab/Post'] }], [])).toEqual(['post']);
  const f = fixture(), page = await f.read();
  await expect(f.read({ ...plan, input: { ...plan.input, limit: 10, cursor: page.nextCursor! } }))
    .rejects.toBeInstanceOf(WorkReadInvalid);
});
