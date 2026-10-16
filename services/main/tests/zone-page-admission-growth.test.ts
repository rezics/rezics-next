import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Pool } from 'pg';
import { FusekiClient, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import type { ImmutableObjects } from '../src/infrastructure/immutable-objects.ts';
import { AccessAdmissionRegistry, AdmissionDenied, type VerifiedPrincipal } from '../src/modules/access/admission.ts';
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

/** The route, immutable trees and target Access evaluator are real. Target
 * storage responses and the separate Zone editor mandate are supplied here;
 * the counters count every issued SQL/Fuseki request for target admission. */
async function fixture(count: number, options: { distinct?: boolean; hidden?: (index: number) => boolean;
  work?: (index: number) => boolean; workScope?: boolean; semanticGrantsOnly?: boolean;
  workGrantsOnly?: boolean; scalar?: boolean; policy?: 'allow' | 'deny' | 'unavailable';
  maintainer?: 'organization' | 'pen-name'; successor?: boolean;
  platform?: 'semantic.read' | 'work.read'; closed?: boolean } = {}) {
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
  const viewer: VerifiedPrincipal = { ...principal, emailVerified: !!options.maintainer };
  const proofOnly = !!options.maintainer || !!options.successor || !!options.platform;
  const grantId = (scope: string) => id(`grant:${scope}`).slice(-36);
  const mandate = id('mandate').slice(-36), policyId = id('policy').slice(-36);
  const grantAllowed = (scope: string, action: string) => readable.has(scope.slice(scope.indexOf('https:')))
    && !proofOnly && (action === 'work.read' ? !options.semanticGrantsOnly : !options.workGrantsOnly);
  let recoveryOpen = true, failureBatch = 0, semanticBatches = 0, ambiguous = false;
  let editorOpen = true, editorProbes = 0, revokeEditorAfterTargets = false;
  const client = { release() {}, query: async (statement: string, parameters: unknown[] = []) => {
    sql.push(statement);
    const result = (values: object[]) => ({ rows: values, rowCount: values.length });
    if (statement.includes('AS source_table')) {
      return result([...statement.matchAll(/SELECT '([^']+)' AS source_table/g)].flatMap((match, index) =>
        (parameters[index] as string[]).map(sourceId => ({
          source_table: match[1], source_row: { id: sourceId, generation: '1' },
        }))));
    }
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
      return result(options.successor ? [{ id: id('creation').slice(-36) }] : []);
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
  const pool = { connect: async () => client } as unknown as Pool;
  const graph = new FusekiClient('http://graph.invalid');
  graph.query = async query => {
    queries.push(query);
    if (query.includes('ASK')) return { boolean: query.includes('rv:admissionId') ? !!options.maintainer
      : query.includes('a schema:CreativeWork') ? [...works].some(work => query.includes(`<${work}>`)) : true };
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
    if (query.includes('SELECT ?admission ?receipt ?digest')) return rows(options.successor ? [{
      admission: id('creation').slice(-36), receipt: `urn:rezics:receipt:${'a'.repeat(64)}`, digest: 'b'.repeat(64),
    }] : []);
    throw new Error(`Unexpected graph query: ${query}`);
  };
  const access = new AccessAdmissionRegistry(pool);
  access.configureBaseline(graph);
  const originalBatch = access.canReadZoneNavigationTargets.bind(access);
  const accessForRoute = Object.create(access) as MainWorkDependencies['access'];
  accessForRoute.assertAuthority = async request => {
    editorProbes++;
    expect(request).toEqual({ principal: viewer, actingSubject: actor, scope: `zone:edit:${zone}`, action: 'zone.edit' });
    if (!editorOpen) throw new AdmissionDenied('Zone editor mandate is unavailable');
  };
  accessForRoute.canReadZoneNavigationTargets = async (current, workViewer, subject, resources) => {
    batches.push([...resources]);
    const allowed = await originalBatch(current, workViewer, subject, resources);
    if (revokeEditorAfterTargets) editorOpen = false;
    return allowed;
  };
  if (options.scalar) accessForRoute.canReadZoneNavigationTargets = undefined;
  const work = { environment: { fuseki: graph, structureObjects: objects, objectDirectory: directory,
    lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' } }, access: accessForRoute,
    account: { verify: async (_request: Request, permissions: string[]) => {
      if (permissions.includes('work:read') && options.workScope === false) throw new Error('Missing Work scope');
      return viewer;
    } },
  } as unknown as MainWorkDependencies;
  const app = zoneRoutes(graph, work);
  const read = async (limit = 100, after?: string, historical = false) => {
    sql.length = queries.length = batches.length = semanticBatches = editorProbes = 0;
    const query = new URLSearchParams({ actingSubject: actor, limit: String(limit), ...(after ? { after } : {}) });
    const response = await app.handle(new Request(`http://main.test/v1/zones/${zone.slice(-36)}${historical
      ? `/revisions/${revision.slice(-36)}` : ''}?${query}`));
    const body = await response.json() as { mounts?: OccurrenceRecord[]; next?: string | null };
    return { status: response.status, body, sql: sql.length, fuseki: queries.length, batches: [...batches], editorProbes };
  };
  const scalar = async () => {
    const allowed = new Set<string>();
    for (const target of targets) {
      if (works.has(target) ? options.workScope !== false && await access.canReadWork(viewer, actor, target)
        : await access.canReadSemanticResource(viewer, actor, target)) allowed.add(target);
    }
    return allowed;
  };
  return { read, records, targets, sql, queries, scalar, batch: () => originalBatch(viewer,
    options.workScope === false ? null : viewer, actor, targets), close: () => rmSync(directory, { recursive: true, force: true }),
    holdRecovery: () => { recoveryOpen = false; }, failGraph: () => { failureBatch = 2; },
    corruptTypes: () => { ambiguous = true; }, revoke: () => { readable.clear(); },
    denyEditor: () => { editorOpen = false; },
    revokeEditorDuringAdmission: () => { revokeEditorAfterTargets = true; } };
}

test('saved navigation requires a Zone editor mandate before and after target admission', async () => {
  for (const deny of ['denyEditor', 'revokeEditorDuringAdmission'] as const) {
    const f = await fixture(4);
    try {
      f[deny]();
      const result = await f.read();
      expect(result.status).toBe(404);
      expect(result.body.mounts).toBeUndefined();
      expect(result.editorProbes).toBe(deny === 'denyEditor' ? 1 : 2);
      expect(result.batches).toHaveLength(deny === 'denyEditor' ? 0 : 1);
    } finally { f.close(); }
  }
});

test('Zone page admission has constant SQL and Fuseki requests for 4/16/64 mounts over one Collection', async () => {
  const costs: Array<{ sql: number; fuseki: number }> = [];
  for (const count of [4, 16, 64]) {
    const f = await fixture(count);
    try {
      const result = await f.read();
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      expect(result.body.mounts).toEqual(f.records);
      expect(result.editorProbes).toBe(2);
      expect(result.body.next).toBeNull();
      expect(result.batches).toEqual([f.targets]);
      costs.push({ sql: result.sql, fuseki: result.fuseki });
    } finally { f.close(); }
  }
  expect(costs).toEqual([costs[0]!, costs[0]!, costs[0]!]);
  expect(costs[0]!.sql).toBeLessThanOrEqual(32);
  expect(costs[0]!.fuseki).toBeLessThanOrEqual(13);
  console.info(`Zone duplicate-target admission counts: ${JSON.stringify(costs)}`);
});

test('distinct 4/16/64 Collections batch shared facts and retain exact owner proofs per target', async () => {
  const costs: Array<{ targets: number; sql: number; fuseki: number }> = [];
  for (const count of [4, 16, 64]) {
    const f = await fixture(count, { distinct: true });
    try {
      const result = await f.read();
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      expect(result.body.mounts).toEqual(f.records);
      expect(result.batches).toEqual([f.targets]);
      expect(result.sql).toBeLessThanOrEqual(32 + count);
      expect(result.fuseki).toBeLessThanOrEqual(12 + count);
      expect(f.sql.filter(statement => statement.includes('scope_id = ANY($1::text[])'))).toHaveLength(1);
      expect(f.sql.filter(statement => statement.includes('FROM unnest($2::text[]) AS wanted(scope_id)'))).toHaveLength(1);
      costs.push({ targets: count, sql: result.sql, fuseki: result.fuseki });
    } finally { f.close(); }
  }
  console.info(`Zone distinct-target admission counts: ${JSON.stringify(costs)}`);
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
      .toEqual([65, 36]);
    // The separate editor mandate is supplied above; all mounted targets share one transaction.
    expect(f.sql.filter(statement => statement.startsWith('BEGIN'))).toHaveLength(1);
    expect(f.sql.filter(statement => statement === 'COMMIT')).toHaveLength(1);
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

test('scalar and batch admission agree on published policies, every controller kind, successor stewardship and exact platform permission', async () => {
  const cases = [
    { name: 'semantic policy deny with mandate/grant', options: { policy: 'deny' as const }, allowed: false },
    { name: 'Work policy deny with mandate/grant', options: { policy: 'deny' as const, work: () => true }, allowed: false },
    { name: 'published allow with mandate/grant', options: { policy: 'allow' as const }, allowed: true },
    { name: 'closed gate defeats published allow', options: { policy: 'allow' as const, closed: true }, allowed: false },
    { name: 'Organization maintainer', options: { maintainer: 'organization' as const, work: () => true }, allowed: true },
    { name: 'Pen Name maintainer', options: { maintainer: 'pen-name' as const, work: () => true }, allowed: true },
    { name: 'successor controller of Zone/Space steward', options: { successor: true }, allowed: true },
    { name: 'exact semantic platform permission', options: { platform: 'semantic.read' as const }, allowed: true },
    { name: 'exact Work platform permission', options: { platform: 'work.read' as const, work: () => true }, allowed: true },
    { name: 'mixed Work and semantic grants', options: { work: (index: number) => index % 2 === 0 }, allowed: true },
    { name: 'semantic grant cannot substitute for Work scope', options: { work: () => true, workScope: false }, allowed: false },
  ];
  for (const current of cases) {
    const f = await fixture(4, { distinct: true, ...current.options });
    try {
      const scalar = await f.scalar(), batch = await f.batch();
      expect(batch, current.name).toEqual(scalar);
      expect([...scalar], current.name).toEqual(current.allowed ? f.targets : []);
      const page = await f.read();
      expect(page.status, `${current.name}: ${JSON.stringify(page.body)}`).toBe(200);
      expect(page.body.mounts, current.name).toEqual(current.allowed ? f.records : []);
      expect(page.body.next).toBeNull();
    } finally { f.close(); }
  }
});

test('scalar and batch both fail closed when a published policy cannot be evaluated', async () => {
  const f = await fixture(4, { distinct: true, policy: 'unavailable' });
  try {
    await expect(f.scalar()).rejects.toThrow('published policy could not be judged');
    await expect(f.batch()).rejects.toThrow('published policy could not be judged');
    const page = await f.read();
    expect(page.status).toBe(503);
    expect(page.body.mounts).toBeUndefined();
    expect(f.sql).toContain('ROLLBACK');
  } finally { f.close(); }
});
