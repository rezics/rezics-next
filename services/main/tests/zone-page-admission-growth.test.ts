import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Pool } from 'pg';
import { FusekiClient, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import type { ImmutableObjects } from '../src/infrastructure/immutable-objects.ts';
import { readZoneNavigationTargetDisclosure } from '../src/modules/access/semantic-disclosure.ts';
import { MediaAccessBatchReader } from '../src/modules/media/access-batch.ts';
import { orderTree, recordTree } from '../src/modules/structure/change.ts';
import { STRUCTURE_MANIFEST_FORMAT, STRUCTURE_PAGE_FORMAT, STRUCTURE_PROFILE,
  type OccurrenceRecord, type OrderEntry, type StructureManifest } from '../src/modules/structure/format.ts';
import { derivedId, orderTreeKey } from '../src/modules/structure/graph.ts';
import { newCost } from '../src/modules/structure/tree.ts';
import { prepareComponent, RV } from '../src/modules/work/activate.ts';
import { ZONE_CONFIG_FORMAT, ZONE_PROFILE } from '../src/modules/zone/config-format.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { zoneRoutes } from '../src/routes/zones.ts';

const id = (name: string) => derivedId(`zone-page-admission:${name}`);
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
  workGrantsOnly?: boolean; scalar?: boolean } = {}) {
  const directory = mkdtempSync('.temp/zone-page-admission-');
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
  const sql: string[] = [], queries: string[] = [], batches: string[][] = [];
  let recoveryOpen = true, failureBatch = 0, semanticBatches = 0, ambiguous = false;
  const client = { release() {}, query: async (statement: string, parameters: unknown[] = []) => {
    sql.push(statement);
    if (statement.includes('access.recovery_fence')) return { rows: [{ open: recoveryOpen, generation: '0' }] };
    if (statement.includes('SELECT id FROM access.principal')) return { rows: [{ id: '00000000-0000-4000-8000-000000000001' }] };
    if (statement.includes('CROSS JOIN (VALUES')) {
      const requested = parameters[2] as string[];
      return { rows: requested.filter(resource => readable.has(resource) && (works.has(resource)
        ? statement.includes("('work:read:', 'work.read')") && !options.semanticGrantsOnly
        : statement.includes("('semantic:read:', 'semantic.read')") && !options.workGrantsOnly)).map(resource => ({ resource })) };
    }
    if (statement.includes('FROM unnest($1::text[]) AS wanted(resource)')) {
      return { rows: (parameters[0] as string[]).map(resource => ({ resource })) };
    }
    return { rows: [] };
  } };
  const pool = { connect: async () => client } as unknown as Pool;
  const graph = new FusekiClient('http://graph.invalid');
  graph.query = async query => {
    queries.push(query);
    if (query.includes('ASK')) return { boolean: query.includes('a schema:CreativeWork')
      ? [...works].some(work => query.includes(`<${work}>`)) : true };
    if (query.includes('SELECT ?space ?navigation ?head')) return rows([{ space, navigation: structure, head: revision,
      manifest: `urn:rezics:sha256:${configuration}`, state: `${RV}Active`, spaceDisclosure: `${RV}Public` }]);
    if (query.includes('SELECT ?navigation WHERE')) return rows([{ navigation: structure }]);
    if (query.includes('SELECT ?component ?profile')) return rows([{ component: zone, profile: `${RV}ZoneNavigation`,
      head: revision, generation, count: String(count), manifest: `urn:rezics:sha256:${digest}` }]);
    if (query.includes('SELECT ?owner')) return rows([{ owner: zone }]);
    if (query.includes('SELECT ?manifest ?predecessor')) return rows([{ manifest: `urn:rezics:sha256:${digest}`,
      count: String(count), epoch: 'epoch', sequence: '1' }]);
    if (query.includes('SELECT ?resource WHERE')) {
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
    if (query.includes('SELECT ?resource ?admission ?receipt') || query.includes('SELECT DISTINCT ?resource')) return rows([]);
    throw new Error(`Unexpected graph query: ${query}`);
  };
  const mediaAccess = new MediaAccessBatchReader(pool, graph);
  const originalBatch = mediaAccess.canReadZoneNavigationTargets.bind(mediaAccess);
  mediaAccess.canReadZoneNavigationTargets = (viewer, workViewer, subject, resources) => {
    batches.push([...resources]);
    return originalBatch(viewer, workViewer, subject, resources);
  };
  const work = { environment: { fuseki: graph, structureObjects: objects, objectDirectory: directory,
    lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' } }, mediaAccess: options.scalar ? undefined : mediaAccess,
    account: { verify: async (_request: Request, permissions: string[]) => {
      if (permissions.includes('work:read') && options.workScope === false) throw new Error('Missing Work scope');
      return principal;
    } },
    access: {
      canReadSemanticResource: async (_viewer: unknown, _subject: string, resource: string) => {
        const decision = await mediaAccess.canReadSemantics(principal, actor, [resource]);
        return 'public' in decision ? decision.public.has(resource) || decision.granted.has(resource) : decision.has(resource);
      },
      canReadWork: async (_viewer: unknown, _subject: string, resource: string) =>
        (await readZoneNavigationTargetDisclosure({ pool, graph }, principal, principal, actor, [resource])).has(resource),
    },
  } as unknown as MainWorkDependencies;
  const app = zoneRoutes(graph, work);
  const read = async (limit = 100, after?: string, historical = false) => {
    sql.length = queries.length = batches.length = semanticBatches = 0;
    const query = new URLSearchParams({ actingSubject: actor, limit: String(limit), ...(after ? { after } : {}) });
    const response = await app.handle(new Request(`http://main.test/v1/zones/${zone.slice(-36)}${historical
      ? `/revisions/${revision.slice(-36)}` : ''}?${query}`));
    const body = await response.json() as { mounts?: OccurrenceRecord[]; next?: string | null };
    return { status: response.status, body, sql: sql.length, fuseki: queries.length, batches: [...batches] };
  };
  return { read, records, targets, sql, queries, close: () => rmSync(directory, { recursive: true, force: true }),
    holdRecovery: () => { recoveryOpen = false; }, failGraph: () => { failureBatch = 2; },
    corruptTypes: () => { ambiguous = true; }, revoke: () => { readable.clear(); } };
}

test('Zone page admission has constant SQL and Fuseki requests for 4/16/64 mounts over one Collection', async () => {
  const costs: Array<{ sql: number; fuseki: number }> = [];
  for (const count of [4, 16, 64]) {
    const f = await fixture(count);
    try {
      const result = await f.read();
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      expect(result.body.mounts).toEqual(f.records);
      expect(result.body.next).toBeNull();
      expect(result.batches).toEqual([f.targets]);
      costs.push({ sql: result.sql, fuseki: result.fuseki });
    } finally { f.close(); }
  }
  expect(costs).toEqual([costs[0]!, costs[0]!, costs[0]!]);
  expect(costs[0]!.sql).toBeLessThanOrEqual(24);
  expect(costs[0]!.fuseki).toBeLessThanOrEqual(12);
});

test('64 distinct Collections use the same owner statement set as one Collection', async () => {
  const one = await fixture(64), distinct = await fixture(64, { distinct: true });
  try {
    const baseline = await one.read(), result = await distinct.read();
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.mounts).toEqual(distinct.records);
    expect(result.batches).toEqual([distinct.targets]);
    expect({ sql: result.sql, fuseki: result.fuseki }).toEqual({ sql: baseline.sql, fuseki: baseline.fuseki });
  } finally { one.close(); distinct.close(); }
});

test('page plus lookahead is admitted together; historical navigation uses the same batch path', async () => {
  const f = await fixture(64, { distinct: true });
  try {
    const first = await f.read(4, undefined, true);
    expect(first.status).toBe(200);
    expect(first.body.mounts).toEqual(f.records.slice(0, 4));
    expect(first.body.next).not.toBeNull();
    expect(first.batches).toEqual([f.targets]);
    const next = await f.read(100, first.body.next!);
    expect(next.status).toBe(200);
    expect(next.body.mounts).toEqual(f.records.slice(4));
    expect(next.body.next).toBeNull();
  } finally { f.close(); }
});

test('a full 100-mount page admits 101 candidates in one transaction with bounded semantic sub-batches', async () => {
  const f = await fixture(101, { distinct: true });
  try {
    const result = await f.read();
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.mounts).toEqual(f.records.slice(0, 100));
    expect(result.body.next).not.toBeNull();
    expect(result.batches).toEqual([f.targets]);
    expect(f.queries.filter(query => query.includes('a schema:CreativeWork') && !query.includes('rv:RevisionAnchor'))
      .map(query => resourcesIn(query).length))
      .toEqual([101]);
    expect(f.queries.filter(query => query.includes('rv:RevisionAnchor')).map(query => resourcesIn(query).length))
      .toEqual([1, 65, 36]);
    // The Zone admission has its own transaction; all mounted targets share one.
    expect(f.sql.filter(statement => statement === 'BEGIN')).toHaveLength(2);
    expect(f.sql.filter(statement => statement === 'COMMIT')).toHaveLength(2);
  } finally { f.close(); }
});

test('denied targets do not leak labels or a continuation; Work OAuth and grant kinds stay separate', async () => {
  for (const options of [{ hidden: (index: number) => index > 0 },
    { work: (index: number) => index > 0, workScope: false },
    { work: (index: number) => index > 0, semanticGrantsOnly: true }]) {
    const f = await fixture(16, { distinct: true, ...options });
    try {
      const result = await f.read(1);
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      expect(result.body.mounts).toEqual([f.records[0]!]);
      expect(result.body.next).toBeNull();
      expect(result.batches).toEqual([f.targets]);
    } finally { f.close(); }
  }
  const mixed = await fixture(16, { distinct: true, work: index => index % 2 === 1 });
  try {
    const result = await mixed.read();
    expect(result.status).toBe(200);
    expect(result.body.mounts).toEqual(mixed.records);
  } finally { mixed.close(); }
  const workGrants = await fixture(16, { distinct: true, workGrantsOnly: true });
  try {
    const result = await workGrants.read();
    expect(result.status).toBe(200);
    expect(result.body.mounts).toEqual([]);
    expect(result.body.next).toBeNull();
  } finally { workGrants.close(); }
});

test('a later request repeats current admission after grants are revoked', async () => {
  const f = await fixture(64);
  try {
    const first = await f.read();
    expect(first.status).toBe(200);
    expect(first.body.mounts).toEqual(f.records);
    f.revoke();
    const revoked = await f.read();
    expect(revoked.status).toBe(200);
    expect(revoked.body.mounts).toEqual([]);
    expect(revoked.body.next).toBeNull();
    expect(revoked.batches).toEqual([f.targets]);
  } finally { f.close(); }
});

test('dependency sets without the optional batch retain scalar admission', async () => {
  const f = await fixture(4, { scalar: true });
  try {
    const result = await f.read();
    expect(result.status).toBe(200);
    expect(result.body.mounts).toEqual(f.records);
    expect(result.batches).toEqual([]);
  } finally { f.close(); }
});

test('held recovery, partial batch failure and ambiguous target types return no partial page', async () => {
  for (const fail of ['holdRecovery', 'failGraph', 'corruptTypes'] as const) {
    const f = await fixture(101, { distinct: true });
    try {
      f[fail]();
      const result = await f.read();
      expect(result.status).toBeGreaterThanOrEqual(500);
      expect(result.body.mounts).toBeUndefined();
      expect(f.sql).toContain('ROLLBACK');
    } finally { f.close(); }
  }
});
