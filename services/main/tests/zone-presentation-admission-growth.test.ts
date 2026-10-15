import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Pool } from 'pg';
import { FusekiClient, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import type { ImmutableObjects } from '../src/infrastructure/immutable-objects.ts';
import { AccessAdmissionRegistry, type VerifiedPrincipal } from '../src/modules/access/admission.ts';
import { orderTree, recordTree } from '../src/modules/structure/change.ts';
import { STRUCTURE_MANIFEST_FORMAT, STRUCTURE_PAGE_FORMAT, STRUCTURE_PROFILE,
  type OccurrenceRecord, type OrderEntry, type StructureManifest } from '../src/modules/structure/format.ts';
import { derivedId, orderTreeKey } from '../src/modules/structure/graph.ts';
import { newCost } from '../src/modules/structure/tree.ts';
import { prepareComponent, RV } from '../src/modules/work/activate.ts';
import { ZONE_CONFIG_FORMAT, ZONE_PROFILE } from '../src/modules/zone/config-format.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { zoneRoutes } from '../src/routes/zones.ts';
import { readZonePresentation } from '../src/modules/zone/route.ts';
import { configureDisclosure } from '../src/modules/disclosure/read.ts';
import { configureFixtureDisclosureAncestry, fixtureDisclosureReader } from './support/disclosure-ancestry.ts';

const id = (name: string) => derivedId(`zone-presentation-admission:${name}`);
const principal = { issuer: 'https://account.test', subject: 'reader' };
const actor = id('actor'), zone = id('zone'), space = id('space'), structure = id('navigation');
const revision = id('revision'), generation = id('generation');
const rows = (values: Record<string, string>[]): SparqlResult => ({ results: { bindings: values.map(value =>
  Object.fromEntries(Object.entries(value).map(([key, text]) => [key, { type: 'literal', value: text }]))) } });
const resourcesIn = (query: string) => [...query.matchAll(/VALUES \?resource \{([^}]+)\}/g)].flatMap(match =>
  [...match[1]!.matchAll(/<([^>]+)>/g)].map(value => value[1]!));

/** The route, immutable trees and Access batch evaluator are real. Only storage
 * responses are simulated; the counters count every issued SQL/Fuseki request. */
async function fixture(count: number, options: { distinct?: boolean; hidden?: (index: number) => boolean;
  work?: (index: number) => boolean; workScope?: boolean; semanticGrantsOnly?: boolean;
  workGrantsOnly?: boolean; scalar?: boolean; policy?: 'allow' | 'deny' | 'unavailable';
  maintainer?: 'organization' | 'pen-name'; successor?: boolean;
  platform?: 'semantic.read' | 'work.read'; closed?: boolean } = {}) {
  const directory = mkdtempSync('.temp/zone-presentation-admission-');
  const stored = new Map<string, Uint8Array>();
  const objects: ImmutableObjects = {
    async put(bytes) { const digest = createHash('sha256').update(bytes).digest('hex');
      stored.set(digest, bytes); return digest; },
    async get(digest) { const bytes = stored.get(digest); if (!bytes) throw new Error('Missing fixture object');
      return bytes; },
  };
  const records: OccurrenceRecord[] = Array.from({ length: count }, (_, index) => ({
    occurrence: id(`mount-${index}`), state: 'active', role: 'mount', parent: structure,
    segmentKey: 'i', orderKey: String(index).padStart(8, '0'), labels: [], introducedBy: revision,
    target: id(`target-${options.distinct ? index : 0}`),
    qualifier: { type: 'zone-mount', zone, routeSegment: `mount-${index}`, disclosure: 'public' },
  }));
  const targets = [...new Set(records.map(record => record.target!))];
  const readable = new Set(records.filter((_, index) => !options.hidden?.(index)).map(record => record.target!));
  const works = new Set(records.filter((_, index) => options.work?.(index)).map(record => record.target!));
  const cost = newCost(), recordIndex = recordTree(objects), orderIndex = orderTree(objects);
  const entries = records.map(({ occurrence, parent, segmentKey, orderKey }) =>
    ({ occurrence, parent, segmentKey: segmentKey!, orderKey: orderKey! }) satisfies OrderEntry);
  const manifest: StructureManifest = { format: STRUCTURE_MANIFEST_FORMAT, structure, structureOf: zone,
    profile: 'zone-navigation', generation, pageFormat: STRUCTURE_PAGE_FORMAT,
    records: await recordIndex.apply(await recordIndex.empty(cost), new Map(records.map(record => [record.occurrence, record])), cost),
    order: await orderIndex.apply(await orderIndex.empty(cost), new Map(entries.map(entry => [orderTreeKey(entry), entry])), cost),
    placementCount: count, measures: [], model: STRUCTURE_PROFILE, shape: STRUCTURE_PROFILE };
  const digest = await objects.put(new TextEncoder().encode(JSON.stringify(manifest)));
  const configuration = prepareComponent(directory, zone, { name: 'Mounted targets', language: 'en', configuration: {
    format: ZONE_CONFIG_FORMAT, zone, space, navigation: structure, state: 'active', disclosure: 'public',
    budget: { timeMs: 500, rows: 100 }, queryBlocks: [], model: ZONE_PROFILE,
  } }, ZONE_PROFILE);
  const sql: string[] = [], queries: string[] = [], batches: string[][] = [], summaryBatches: string[][] = [];
  const viewer: VerifiedPrincipal = { ...principal, emailVerified: true };
  const proofOnly = !!options.maintainer || !!options.successor || !!options.platform;
  const grantId = (scope: string) => id(`grant:${scope}`).slice(-36);
  const mandate = id('mandate').slice(-36), policyId = id('policy').slice(-36);
  const grantAllowed = (scope: string, action: string) => readable.has(scope.slice(scope.indexOf('https:')))
    && !proofOnly && (action === 'work.read' ? !options.semanticGrantsOnly : !options.workGrantsOnly);
  let recoveryOpen = true, failureBatch = 0, semanticBatches = 0, ambiguous = false;
  const client = { release() {}, query: async (statement: string, parameters: unknown[] = []) => {
    sql.push(statement);
    const result = (values: object[]) => ({ rows: values, rowCount: values.length });
    if (statement.includes('access.recovery_fence')) return result([{ open: recoveryOpen, generation: '0' }]);
    if (statement.includes('SELECT id FROM access.principal')) return result([{ id: id('reader').slice(-36) }]);
    if (statement.includes('WHERE NOT EXISTS (SELECT 1 FROM access.scope_gate')) {
      return result((parameters[0] as string[]).filter(resource => resource === zone || !options.closed && !options.policy)
        .map(resource => ({ resource })));
    }
    if (statement.includes('FROM access.scope_gate')) {
      if (parameters[0] === 'platform:access') return result(options.platform ? [{ id: 'platform:access', open: true }] : []);
      const scopes = Array.isArray(parameters[0]) ? parameters[0] as string[] : [parameters[0] as string];
      return result(scopes.map(scope => ({ id: scope, open: !options.closed })));
    }
    if (statement.includes('FROM access.policy p LEFT JOIN')) {
      if (options.policy === 'unavailable') throw new Error('policy unavailable');
      return result(options.policy ? [{ id: policyId, head_revision: '1', max_states: 2048,
        max_input_rows: 128, deadline_ms: 1000, now: new Date() }] : []);
    }
    if (statement.includes('FROM access.policy WHERE scope_id')) {
      const scopes = Array.isArray(parameters[0]) ? parameters[0] as string[] : [parameters[0] as string];
      return result(options.policy ? scopes.map(scope => ({ id: policyId, scope_id: scope })) : []);
    }
    if (statement.includes('FROM access.policy_rule\n')) return result([{ tier: 'ordered', position: 0,
      rule_id: id('rule').slice(-36), effect: options.policy, actions: ['work.read', 'semantic.read'], condition: { op: 'authenticated' } }]);
    if (statement.includes('FROM access.policy_rule_set_reference')) return result([]);
    if (statement.includes('SELECT *,') && statement.includes('WHERE id = $1')) {
      return result([{ id: parameters[0], generation: '1' }]);
    }
    if (statement.includes('access.read_platform_permissions')) return result(options.platform ? [
      { id: id('admin-grant').slice(-36), action: 'platform:use:platform-admin', scope_id: 'platform:access',
        generation: '1', valid_until: null, witness: 'admin' },
      ...targets.map(target => ({ id: grantId(target), action: `platform:resource:${options.platform}`,
        scope_id: `${options.platform === 'work.read' ? 'work' : 'semantic'}:read:${target}`,
        generation: '1', valid_until: null, witness: 'exact' })),
    ] : []);
    if (statement.includes('SELECT $3::text AS receipt')) return result(options.platform ? [{ representation_id: mandate }] : []);
    if (statement.includes('FROM access.authority_subject s') && statement.includes('JOIN access.agent_provision')) {
      expect(statement).not.toContain("a.agent_kind = 'person'");
      return result(options.maintainer ? [{ provision_id: 'provision', representation_id: mandate }] : []);
    }
    if (statement.includes('FROM access.agent_provision')) return result([]);
    if (statement.includes('SELECT wanted.work AS resource')) {
      return result(options.maintainer ? [{ resource: parameters[0], generation: '1', main_version: id('main'),
        creation_admission: id('creation').slice(-36), action: 'work.create', scope_id: 'work:create:root',
        graph_receipt: `urn:rezics:receipt:${'a'.repeat(64)}`, request_digest: 'b'.repeat(64) }] : []);
    }
    if (statement.includes('SELECT a.id FROM access.admission a')) {
      // Creation belonged to a different principal; the successor's current control decides.
      expect(statement).toContain('r.principal_id = $2');
      expect(statement).not.toContain('a.principal_id = $2');
      return result([{ id: id('creation').slice(-36) }]);
    }
    if (statement.includes('SELECT id FROM access.authority_subject')) return result([{ id: actor }]);
    if (statement.includes('SELECT id FROM access.representation WHERE')) return result([{ id: mandate }]);
    if (statement.includes('FROM unnest($2::text[]) AS wanted(scope_id)')) {
      return result((parameters[1] as string[]).filter(scope => grantAllowed(scope, parameters[2] as string))
        .map(scope => ({ scope_id: scope, id: grantId(scope) })));
    }
    if (statement.includes('SELECT id FROM access.permission_grant WHERE')) {
      const scope = parameters[1] as string;
      return result(grantAllowed(scope, parameters[2] as string) ? [{ id: grantId(scope) }] : []);
    }
    return result([]);
  } };
  const pool = { connect: async () => client, query: client.query } as unknown as Pool;
  const graph = new FusekiClient('http://graph.invalid');
  graph.query = async query => {
    queries.push(query);
    if (query.includes('SELECT ?sequence WHERE')) return rows([{ sequence: '1' }]);
    if (query.includes('SELECT ?spaceDisclosure WHERE')) return rows([{ spaceDisclosure: `${RV}Public` }]);
    if (query.includes('SELECT ?epoch ?sequence ?hold')) {
      const requested = [...new Set([...query.matchAll(/VALUES \?r \{([^}]+)\}/g)].flatMap(match =>
        [...match[1]!.matchAll(/<([^>]+)>/g)].map(value => value[1]!)))];
      summaryBatches.push(requested);
      return { results: { bindings: requested.map(resource => ({
        epoch: { type: 'literal', value: 'epoch' }, sequence: { type: 'literal', value: '1' },
        r: { type: 'uri', value: resource }, type: { type: 'literal', value: 'collection' },
        public: { type: 'literal', value: 'true' }, erased: { type: 'literal', value: String(!readable.has(resource)) },
        label: { type: 'literal', value: 'Mounted Collection', 'xml:lang': 'en' },
      })) } };
    }
    if (query.includes('ASK')) return { boolean: query.includes('rv:admissionId') ? !!options.maintainer
      : query.includes('a schema:CreativeWork') ? [...works].some(work => query.includes(`<${work}>`)) : true };
    if (query.includes('SELECT ?creation WHERE')) return rows([{ creation: revision }]);
    if (query.includes('SELECT ?manifest WHERE')) return rows([{ manifest: `urn:rezics:sha256:${configuration}` }]);
    if (query.includes('SELECT ?space ?navigation ?head')) return rows([{ space, navigation: structure, head: revision,
      manifest: `urn:rezics:sha256:${configuration}`, state: `${RV}Active`, spaceDisclosure: `${RV}Public` }]);
    if (query.includes('SELECT ?navigation WHERE')) return rows([{ navigation: structure }]);
    if (query.includes('SELECT ?component ?profile')) return rows([{ component: zone, profile: `${RV}ZoneNavigation`,
      head: revision, generation, count: String(count), manifest: `urn:rezics:sha256:${digest}` }]);
    if (query.includes('SELECT ?owner')) return rows([{ owner: zone }]);
    if (query.includes('SELECT ?manifest ?predecessor')) return rows([{ manifest: `urn:rezics:sha256:${digest}`,
      count: String(count), epoch: 'epoch', sequence: '1' }]);
    if (query.includes('SELECT ?resource WHERE') || query.includes('SELECT ?resource ?publicCollection WHERE')) {
      const requested = resourcesIn(query);
      if (query.includes('a schema:CreativeWork') && !query.includes('rv:RevisionAnchor')) {
        const result = requested.filter(resource => works.has(resource)).map(resource => ({ resource }));
        if (ambiguous) result.push({ resource: id('foreign') });
        return rows(result);
      }
      if (!requested.includes(zone) && ++semanticBatches === failureBatch) throw new Error('target graph unavailable');
      // The Zone is public; mounted Collections exercise private grant batching.
      return rows(requested.filter(resource => resource === zone).map(resource => ({ resource })));
    }
    if (query.includes('SELECT ?admission ?receipt ?digest')) return rows(query.includes(`BIND(<${zone}>`)
      || options.successor ? [{
      admission: id('creation').slice(-36), receipt: `urn:rezics:receipt:${'a'.repeat(64)}`, digest: 'b'.repeat(64),
    }] : []);
    throw new Error(`Unexpected graph query: ${query}`);
  };
  const access = new AccessAdmissionRegistry(pool);
  access.configureBaseline(graph);
  const originalBatch = access.canReadZoneNavigationTargets.bind(access);
  const accessForRoute = Object.create(access) as MainWorkDependencies['access'];
  accessForRoute.canReadZoneNavigationTargets = (current, workViewer, subject, resources) => {
    batches.push([...resources]);
    return originalBatch(current, workViewer, subject, resources);
  };
  if (options.scalar) accessForRoute.canReadZoneNavigationTargets = undefined;
  accessForRoute.assertAuthority = async () => {};
  accessForRoute.activePrincipalId = async () => id('reader').slice(-36);
  accessForRoute.withOwnerAuthority = async (_request, operation) => operation(client as unknown as import('pg').PoolClient);
  const work = { contentAuthoring: {
      listVariantHeads: async () => ({ items: [] }), readDraftHead: async () => null,
      ownerPosition: async () => ({ datasetId: 'content', dataEpoch: 'content', sequence: '0' }),
    }, environment: { fuseki: graph, structureObjects: objects, objectDirectory: directory,
    lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' } }, access: accessForRoute,
    account: { verify: async (_request: Request, permissions: string[]) => {
      if (permissions.includes('work:read') && options.workScope === false) throw new Error('Missing Work scope');
      return viewer;
    } },
  } as unknown as MainWorkDependencies;
  configureFixtureDisclosureAncestry(work.environment, () => undefined);
  configureDisclosure(work.environment, fixtureDisclosureReader(async targets => targets.map(() => 'visible')));
  const app = zoneRoutes(graph, work);
  const read = async (after?: string) => {
    sql.length = queries.length = batches.length = semanticBatches = 0;
    const query = new URLSearchParams({ actingSubject: actor, ...(after ? { after } : {}) });
    const response = await app.handle(new Request(`http://main.test/v1/zones/${zone.slice(-36)}/showcase-editor?${query}`));
    const result = await response.json() as { preview?: { navigation: { mounts: OccurrenceRecord[]; next: string | null } } };
    const body = (result.preview?.navigation ?? result) as { mounts?: OccurrenceRecord[]; next?: string | null };
    return { status: response.status, body, sql: sql.length, fuseki: queries.length, batches: [...batches] };
  };
  const scalar = async () => {
    const allowed = new Set<string>();
    for (const target of targets) {
      if (works.has(target) ? options.workScope !== false && await access.canReadWork(viewer, actor, target)
        : await access.canReadSemanticResource(viewer, actor, target)) allowed.add(target);
    }
    return allowed;
  };
  const readPublic = async () => {
    queries.length = summaryBatches.length = 0;
    const result = await readZonePresentation(work, new Request('http://main.test/v1/zones/public'), zone, undefined,
      async (_state, navigation, _viewer, _visibleSlides, continuation) => ({ navigation, ...continuation }));
    return { ...result, queries: queries.length, summaryBatches: [...summaryBatches] };
  };
  return { read, readPublic, records, targets, sql, queries, scalar, batch: () => originalBatch(viewer,
    options.workScope === false ? null : viewer, actor, targets), close: () => rmSync(directory, { recursive: true, force: true }),
    holdRecovery: () => { recoveryOpen = false; }, failGraph: () => { failureBatch = 2; },
    corruptTypes: () => { ambiguous = true; }, revoke: () => { readable.clear(); } };
}

test('public Zone navigation batches duplicate and distinct 4/16/64 targets under its existing summary decision', async () => {
  for (const distinct of [false, true]) {
    const costs: number[] = [];
    for (const count of [4, 16, 64]) {
      const f = await fixture(count, { distinct });
      try {
        const result = await f.readPublic();
        expect(result.navigation.map(item => item.target)).toEqual(f.records.slice(0, 50).map(record => record.target!));
        expect(result.navigationComplete).toBe(count <= 50);
        expect(result.summaryBatches.slice(0, Math.ceil(f.targets.length / 50))).toEqual(
          Array.from({ length: Math.ceil(f.targets.length / 50) }, (_, index) => f.targets.slice(index * 50, index * 50 + 50)));
        costs.push(result.queries);
      } finally { f.close(); }
    }
    if (!distinct) expect(costs).toEqual([costs[0]!, costs[0]!, costs[0]!]);
    else expect(costs[2]! - costs[0]!).toBeLessThanOrEqual(4);
    console.info(`Public Zone ${distinct ? 'distinct' : 'duplicate'}-target navigation counts: ${JSON.stringify(costs)}`);
  }
});

test('Zone presentation navigation batches duplicate 4/16/64 mounts in constant owner queries', async () => {
  const costs: Array<{ sql: number; fuseki: number }> = [];
  for (const count of [4, 16, 64]) {
    const f = await fixture(count);
    try {
      const result = await f.read();
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      expect(result.body.mounts).toEqual(f.records.slice(0, 50));
      expect(!!result.body.next).toBe(count > 50);
      expect(result.batches).toEqual([f.targets, [...new Set(f.records.slice(0, 50).map(record => record.target!))]]);
      costs.push({ sql: result.sql, fuseki: result.fuseki });
    } finally { f.close(); }
  }
  expect(costs).toEqual([costs[0]!, costs[0]!, costs[0]!]);
  console.info(`Zone presentation duplicate-target admission counts: ${JSON.stringify(costs)}`);
});

test('Zone presentation batches distinct 4/16/64 targets, retaining current per-target recovery proofs', async () => {
  const costs: Array<{ targets: number; sql: number; fuseki: number }> = [];
  for (const count of [4, 16, 64]) {
    const f = await fixture(count, { distinct: true });
    try {
      const result = await f.read();
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      expect(result.body.mounts).toEqual(f.records.slice(0, 50));
      expect(result.batches).toEqual([f.targets, [...new Set(f.records.slice(0, 50).map(record => record.target!))]]);
      expect(result.fuseki).toBeLessThanOrEqual(20 + 5 * count);
      expect(result.sql).toBeLessThanOrEqual(45 + 16 * count);
      costs.push({ targets: count, sql: result.sql, fuseki: result.fuseki });
    } finally { f.close(); }
  }
  console.info(`Zone presentation distinct-target admission counts: ${JSON.stringify(costs)}`);
});

test('Zone presentation hides denied targets and propagates unavailable admission owners', async () => {
  const denied = await fixture(16, { distinct: true, hidden: index => index % 2 === 0 });
  try {
    const result = await denied.read();
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.mounts).toEqual(denied.records.filter((_, index) => index % 2 !== 0));
    expect(result.batches).toEqual([denied.targets,
      denied.records.filter((_, index) => index % 2 !== 0).map(record => record.target!)]);
  } finally { denied.close(); }
  const failed = await fixture(4);
  try {
    failed.failGraph();
    expect((await failed.read()).status).toBe(503);
  } finally { failed.close(); }
});

