import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { FusekiClient, fusekiReadBudget, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import { fencedGraphQuery, noteGraphReadVersion } from '../src/infrastructure/graph-read-fence.ts';
import { configureDisclosure, DisclosureStore } from '../src/modules/disclosure/read.ts';
import { DEFAULT_MEDIA_CONTEXT, type AvatarRow } from '../src/modules/media/store.ts';
import { configureMediaVisibility } from '../src/modules/media/visibility.ts';
import { withResourceListBudget } from '../src/modules/query/budget.ts';
import { readResourceList } from '../src/modules/query/resources.ts';
import { publicWorkRead } from '../src/modules/work/read-session.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { fixtureDisclosureCut } from './support/disclosure-ancestry.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const uri = (value: string) => ({ type: 'uri' as const, value });
const literal = (value: string) => ({ type: 'literal' as const, value });
const refs = (body: string, variable: string) => [...(new RegExp(`VALUES \\?${variable} \\{([^}]+)\\}`)
  .exec(body)?.[1] ?? '').matchAll(/<([^>]+)>/g)].map(match => match[1]!);

/** Controlled transport/SQL ports, real Query, WorkReadSession, summary,
 * disclosure and recursive selected-image owners. No live stack or fixture writes. */
function fixture() {
  const realms = Array.from({ length: 65 }, (_, n) => id(n + 1));
  const calls: string[] = [];
  const graph = new FusekiClient('http://query-owner-budget.invalid');
  const control = { epoch: literal('epoch'), sequence: literal('7') };
  const generation = 'urn:rezics:text-index-generation:00000000-0000-4000-8000-000000000001';
  const charge = (name: string) => {
    calls.push(name);
    const budget = fusekiReadBudget.getStore()!;
    expect(budget.callsLeft, `transport ${calls.length}: ${name.slice(0, 100)}`).toBeGreaterThan(0);
    budget.callsLeft--;
  };
  graph.commandHealth = async () => {
    charge('health');
    return { moduleVersion: 'fixture', instanceId: '00000000-0000-4000-8000-000000000002',
      publicSearchWriteEpoch: '0', publicSearchWriteActive: false, publicSearchDeltaAvailable: true, profiles: {} };
  };
  graph.searchDeltaSince = async () => {
    charge('qualified-delta');
    return { available: true, ordinal: '0', dataEpoch: 'epoch', sequence: '7', generation,
      writeEpoch: '0', luceneGeneration: '1', qualifiedPopulation: '65', deltas: [] };
  };
  graph.query = (body, maximum) => fencedGraphQuery(graph, body, maximum, async () => {
    charge(body);
    let rows: NonNullable<SparqlResult['results']>['bindings'];
    if (body.includes('SELECT ?epoch ?sequence ?generation')) rows = [{ ...control, generation: uri(generation) }];
    else if (body.includes('SELECT ?epoch ?sequence WHERE')) rows = [control];
    else if (body.includes('SELECT ?space ?realmRevision')) rows = [{ space: uri(id(2001)),
      realmRevision: uri(id(3001)), disclosure: uri('https://rezics.com/vocab/Public') }];
    else if (body.includes('SELECT ?resourceDirectorySource ?page')) rows =
      [...body.matchAll(/BIND\("(\d+)" AS \?resourceDirectorySource\)/g)].map(match => ({
        resourceDirectorySource: literal(match[1]!), page: literal(JSON.stringify({ hits: [], more: false, commit: '1' })) }));
    else if (body.includes('SELECT DISTINCT ?r ?kind ?summary')) rows = refs(body, 'r').filter(ref => realms.includes(ref)).map(ref => ({
      r: uri(ref), summary: uri(ref), kind: literal('realm'), resourceType: uri('https://rezics.com/vocab/Realm') }));
    else if (body.includes('SELECT ?epoch ?sequence ?hold ?r')) rows = [control,
      ...refs(body, 'r').filter(ref => realms.includes(ref)).map(ref => ({ ...control,
        r: uri(ref), type: literal('realm'), head: uri(id(3000 + realms.indexOf(ref))), public: literal('true') }))];
    else if (body.includes('SELECT ?realm ?name')) rows = refs(body, 'realm').map(realm => ({ realm: uri(realm), name: literal(`Realm ${realm}`) }));
    else if (body.includes('SELECT ?realm ?payload')) rows = refs(body, 'realm').map(realm => ({ realm: uri(realm) }));
    else if (body.includes('SELECT ?resource ?space ?site')) rows = refs(body, 'resource').map(resource => ({ resource: uri(resource), space: uri(id(2000 + realms.indexOf(resource))) }));
    else if (body.includes('SELECT ?work ?head')) rows = refs(body, 'work').map(work => ({ work: uri(work), head: uri(id(3000 + realms.indexOf(work))) }));
    else throw new Error(`Unexpected real owner query: ${body}`);
    const result = { results: { bindings: rows } };
    noteGraphReadVersion(result, '1');
    return result;
  });
  const pool = { query: async (sql: string, args: unknown[]) => {
    if (!sql.includes('requested AS')) throw new Error(`Unexpected SQL: ${sql}`);
    const targets = JSON.parse(String(args[0])) as { ordinal: number }[];
    expect(targets.length).toBeLessThanOrEqual(64);
    return { rows: targets.map(target => ({ ordinal: target.ordinal, open: true, restricted: false,
      realmClosed: false, assessments: [], nameVisible: true, publicNameVisible: true, ...fixtureDisclosureCut })) };
  } } as unknown as Pool;
  const environment = { fuseki: graph, lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' }, objectDirectory: '.temp/unused-query-budget' };
  configureDisclosure(environment, new DisclosureStore(pool));
  let imageBatches = 0, attachmentBatches = 0;
  const avatar = (target: string): AvatarRow => {
    const n = realms.indexOf(target);
    return { target, context: DEFAULT_MEDIA_CONTEXT, selection: id(4000 + n).slice(-36), selectionPosition: '1',
      use: id(5000 + n).slice(-36), asset: id(6000 + n).slice(-36), representation: id(7000 + n).slice(-36),
      sha256: 'a'.repeat(64), crop: null, mediaType: 'image/png', byteLength: 100, width: 128, height: 128,
      availability: 'available', clearance: 'cleared', disclosure: 'public', moderation: 'none', lifecycle: 'active', statePosition: '1' };
  };
  const deps = { environment, media: { store: {
    avatarRows: async (resources: readonly string[]) => {
      imageBatches++;
      return { rows: new Map(resources.map(resource => [resource, avatar(resource)])),
        generation: { owner: 'content', dataEpoch: 'media', sequence: '1' } };
    },
    visibilityFacts: async (references: readonly string[]) => {
      attachmentBatches++;
      return new Map(references.map(reference => {
        const n = Number(reference.slice(-12)) - 5000;
        return [reference, { owner: id(9000), exactUse: true, asset: id(6000 + n).slice(-36), disclosure: 'public',
          pending: false, blocked: false, attachmentOverflow: false,
          attachments: [{ target: realms[n]!, context: DEFAULT_MEDIA_CONTEXT }] }];
      }));
    },
  } }, discovery: { active: async () => ({ generation_id: 'generation', stale: false }),
    resourcePage: async () => [], conceptPage: async () => [], conceptCounts: async () => [] },
  access: { assertRecoveryOpen: async () => {}, realmDirectory: {
    page: async (_session: unknown, input: { limit: number }) => ({
      rows: realms.slice(0, input.limit).map((realm, n) => ({ realm, rank: String(n - 1000) })), next: 'more',
      position: 'directory', sourcePosition: { dataEpoch: 'epoch', sequence: '7' } }), fence: async () => {},
  } } } as unknown as MainWorkDependencies;
  configureMediaVisibility(deps);
  return { deps, calls, imageBatches: () => imageBatches, attachmentBatches: () => attachmentBatches };
}

test.each(['all', 'realm'] as const)('default %s Query with distinct selected Realm images closes every owner within canonical32', async scope => {
  const f = fixture();
  const result = await withResourceListBudget(() => publicWorkRead(f.deps,
    new Request('http://main.test/v1/query', { method: 'POST' }), {}, session => readResourceList(session, {
      input: { profile: 'resource-list-v1', context: 'global', scope: scope === 'all' ? { kind: 'all' }
        : { kind: 'realm', realm: id(1000) }, sort: 'newest', limit: 64 }, conditions: [],
    })), scope, ['work', 'space', 'realm', 'site', 'agent', 'collection', 'concept', 'resource', 'post']);
  expect(result.items).toHaveLength(32);
  expect(result.items.every(item => item.icon.kind === 'image')).toBe(true);
  expect(result.complete).toBe(false);
  expect(result.nextCursor).not.toBeNull();
  expect(result.count).toEqual({ value: 32, kind: 'at-least' });
  expect(f.imageBatches()).toBeGreaterThan(0);
  expect(f.attachmentBatches()).toBeGreaterThan(0);
  expect(f.calls.length).toBeLessThanOrEqual(32);
  console.info(JSON.stringify({ controlledQueryOwnerProof: true, scope, graphCalls: f.calls.length,
    readiness: f.calls.filter(call => call === 'health' || call === 'qualified-delta'
      || call.includes('SELECT ?epoch ?sequence ?generation')).length,
    sourceSeeks: f.calls.filter(call => call.includes('SELECT ?resourceDirectorySource ?page')).length,
    selectedImages: result.items.length }));
});
