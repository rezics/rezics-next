import { configureDisclosure } from '../src/modules/disclosure/read.ts';
import { configureFixtureDisclosureAncestry, fixtureDisclosureReader } from './support/disclosure-ancestry.ts';
import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import type { SparqlResult } from '../src/infrastructure/fuseki.ts';
import { RV, prepareComponent } from '../src/modules/work/activate.ts';
import { ZONE_CONFIG_FORMAT, ZONE_PROFILE } from '../src/modules/zone/config-format.ts';
import { parseZonePath, ZONE_RESERVED_SEGMENTS } from '../src/modules/zone/route-path.ts';
import { readZonePresentation, resolveZoneRoute, ZoneRouteMissing, ZONE_ROUTE_COST } from '../src/modules/zone/route.ts';
import { readResourceSummaries, summaryBases } from '../src/modules/media/summary.ts';
import { DEFAULT_MEDIA_CONTEXT } from '../src/modules/media/store.ts';
import { fencedGraphQuery, noteGraphReadVersion } from '../src/infrastructure/graph-read-fence.ts';
import { ObjectNotFound, type ImmutableObjects } from '../src/infrastructure/immutable-objects.ts';
import { orderTree, recordTree } from '../src/modules/structure/change.ts';
import { orderTreeKey } from '../src/modules/structure/graph.ts';
import { STRUCTURE_MANIFEST_FORMAT, STRUCTURE_PAGE_FORMAT, STRUCTURE_PROFILE,
  type OccurrenceRecord, type OrderEntry, type StructureManifest } from '../src/modules/structure/format.ts';
import { newCost } from '../src/modules/structure/tree.ts';
import { PROFILES } from '../src/modules/semantic/schema.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;

test('G630: exact route paths admit native resources and pass slug tabs to the host', () => {
  const resource = randomUUID();
  expect(parseZonePath('/')).toEqual({ kind: 'home' });
  expect(parseZonePath('/picks')).toEqual({ kind: 'mount', segment: 'picks', resource: null, tab: null });
  expect(parseZonePath(`/picks/${resource}/discussion`)).toEqual({ kind: 'mount', segment: 'picks',
    resource, tab: 'discussion' });
  expect(parseZonePath(`/w/${resource}/future-tab`)).toEqual({ kind: 'work', resource, tab: 'future-tab' });
  expect(parseZonePath('/picks/日本語/discussion')).toEqual({ kind: 'mount',segment: 'picks',resource: '日本語',tab: 'discussion' });
  for (const path of ['', 'picks', '//picks', '/picks/', '/w', '/picks/../about',
    '/picks%2fextra', `/picks/${resource}/tab/more`, `/picks/${resource}/`, '/UPPER',
    `/${'a'.repeat(65)}`, ...ZONE_RESERVED_SEGMENTS.filter(segment => segment !== 'w').map(segment => `/${segment}`)]) {
    expect(parseZonePath(path)).toBeNull();
  }
});

function fixture(input: { member: boolean; readable: boolean; adopted?: boolean;
  workMount?: boolean; privateMount?: boolean; granted?: boolean; moved?: 'once' | 'always';
  removedDuringRead?: boolean; deniedWorkScope?: boolean; collectionSemantic?: boolean; revoked?: boolean;
  closedRealm?: boolean }) {
  const zone = id(), space = id(), realm = id(), navigation = id(), collection = id(), structure = id();
  const resource = id(), occurrence = id(), head = id(), generation = id(), revision = id();
  const directory = resolve('.temp', `g-630-unit-${randomUUID()}`);
  const manifest = prepareComponent(directory, zone, { configuration: {
    format: ZONE_CONFIG_FORMAT, zone, space, navigation, state: 'active', disclosure: 'public',
    defaultRealm: realm, budget: { timeMs: 500, rows: 20 }, queryBlocks: [], model: ZONE_PROFILE,
  } }, ZONE_PROFILE);
  const queries: string[] = [];
  let positions = 0;
  let sequence = 7;
  let semanticChecks = 0;
  const scopes: string[][] = [];
  const rows = (values: Record<string, string>[]): SparqlResult => ({ results: { bindings: values.map(value =>
    Object.fromEntries(Object.entries(value).map(([key, text]) => [key, { type: 'literal', value: text }]))) } });
  const work = { environment: { objectDirectory: directory, lineage: { dataEpoch: 'epoch', routingEpoch: '1' },
    fuseki: { query: async (query: string) => {
      if (query.includes('SELECT ?resource ?head') || query.includes('SELECT ?work ?head')) {
        const variable = query.includes('SELECT ?resource ?head') ? 'resource' : 'work';
        const refs = [...(/VALUES \?\w+ \{([^}]*)\}/.exec(query)?.[1] ?? '').matchAll(/<([^>]+)>/g)]
          .map(match => match[1]!);
        return rows(refs.map(resource => ({ [variable]: resource, head })));
      }
      queries.push(query);
      if (query.includes('SELECT ?space ?realmRevision')) return rows(input.closedRealm ? []
        : [{ space, realmRevision: head, disclosure: `${RV}Public` }]);
      if (query.includes('SELECT ?spaceDisclosure')) return rows([{ spaceDisclosure: `${RV}Public` }]);
      if (query.includes('SELECT ?epoch ?sequence ?hold ?r ?type')) {
        const requested = [collection, resource].filter(target => query.includes(`<${target}>`));
        const result = rows(requested.map(target => {
          const isCollection = target === collection;
          const row: Record<string, string> = { epoch: 'epoch', sequence: String(sequence), r: target,
          type: isCollection ? 'collection' : 'work', public: isCollection || input.readable ? 'true' : 'false',
          label: isCollection ? 'Picks' : 'Member', erased: 'false' };
          if (!isCollection) { row.work = resource; row.head = head; }
          return row;
        }));
        if (input.collectionSemantic && requested.includes(collection)) {
          result.results!.bindings.push({ ...result.results!.bindings.find(row => row.r?.value === collection)!,
            type: { type: 'literal', value: 'resource' } });
        }
        for (const row of result.results!.bindings) row.label!['xml:lang'] = 'en';
        return result;
      }
      if (query.includes('SELECT ?sequence WHERE')) {
        positions++;
        if (input.moved === 'always' || input.moved === 'once' && positions === 2) sequence++;
        return rows([{ sequence: String(sequence) }]);
      }
      if (query.includes('ASK')) {
        if (query.includes('rv:MemberRole')) {
          expect(query).toContain(`rv:selectedGeneration <${generation}>`);
          expect(query).toContain(`rv:generation <${generation}>`);
          expect(query).toContain('FILTER NOT EXISTS { ?placement rv:removedBy ?removal }');
          expect(query).toContain(`<${resource}>`);
          return { boolean: input.member && !(input.removedDuringRead && sequence > 7) };
        }
        if (query.includes('rv:RealmPublicationSlot')) {
          expect(query).toContain(`rv:work <${resource}>`);
          expect(query).toContain('rv:publicationHead ?decision');
          expect(query).not.toContain('LIMIT');
          return { boolean: input.adopted === true };
        }
        return { boolean: true };
      }
      if (query.includes('SELECT ?space ?navigation')) return rows([{ space, navigation, head,
        manifest: `urn:rezics:sha256:${manifest}`, state: `${RV}Active`, disclosure: `${RV}Public`, spaceDisclosure: `${RV}Public`, realm }]);
      if (query.includes('SELECT ?component ?profile')) {
        const nav = query.includes(`<${navigation}>`);
        return rows([{ component: nav ? zone : collection, profile: `${RV}${nav ? 'ZoneNavigation' : 'CollectionMembership'}`,
          head: revision, generation, count: '1', manifest: `urn:rezics:sha256:${'a'.repeat(64)}` }]);
      }
      if (query.includes('SELECT ?owner')) return rows([{ owner: query.includes(`<${zone}>`) ? zone : collection }]);
      if (query.includes('SELECT ?occurrence ?target')) return rows([{ occurrence,
        target: input.workMount ? resource : collection, disclosure: `${RV}${input.privateMount ? 'Private' : 'Public'}` }]);
      if (query.includes('SELECT ?structure')) return rows([{ structure }]);
      if (query.includes('SELECT DISTINCT ?type')) return rows([{ type: 'https://schema.org/DigitalDocument' }]);
      if (query.includes('SELECT DISTINCT ?resource ?type')) return rows([{ resource, type: 'https://schema.org/DigitalDocument' }]);
      throw new Error(`Unexpected Zone query: ${query}`);
    } } }, account: { verify: async (_request: Request, required: string[]) => {
      scopes.push(required);
      if (input.deniedWorkScope && required.includes('work:read')) throw new Error('OAuth scope denied');
      return { issuer: 'test', subject: 'reader' };
    } },
    access: { activePrincipalId: async () => 'reader', assertRecoveryOpen: async () => undefined,
      canReadWork: async () => input.granted === true,
      canReadSemanticResource: async () => input.granted === true
        && (!input.revoked || ++semanticChecks === 1) } } as unknown as MainWorkDependencies;
  configureFixtureDisclosureAncestry(work.environment, target => target.work
    ? { resource: target.work, head, protectedRevision: target.workRevision } : undefined);
  configureDisclosure(work.environment, fixtureDisclosureReader(async targets => targets.map(() => 'visible')));
  const request = new Request('http://main.local/v1/zones/test/routes');
  return { work, request, zone, realm, resource, collection, navigation, structure, revision, generation,
    queries, scopes, directory,
    close: () => rmSync(directory, { recursive: true, force: true }) };
}

/** Real immutable pages, semantic manifests, summaries and closing Work fences;
 * only graph/SQL transport boundaries are controlled. */
async function summaryRouteFixture(count = 2, placements = Array.from({ length: count }, (_, at) => at), unavailableCount = 0) {
  const f = fixture({ member: true, readable: true });
  const members = Array.from({ length: count }, (_, at) => ({ reference: id(),
    type: at % 2 ? 'role' : 'character', name: at % 2 ? `Role ${at + 1}` : `Entity ${at + 1}` }));
  const otherCollection = id();
  const unavailable = new Set(members.slice(0, unavailableCount).map(member => member.reference)), hidden = new Set<string>();
  const manifests = new Map<string, string>();
  const rename = (at: number, name: string) => {
    const member = members[at]!;
    manifests.set(member.reference, `urn:rezics:sha256:${prepareComponent(f.directory, member.reference,
      { component: 'resource', lifecycle: 'active', types: [`${RV}${member.type === 'role' ? 'Role' : 'Character'}`],
        properties: [{ predicate: 'https://schema.org/name', value: { kind: 'language-string', lexical: name, language: 'en' } }] },
      PROFILES.resource)}`);
  };
  members.forEach((member, at) => { if (!unavailable.has(member.reference)) rename(at, member.name); });
  const stored = new Map<string, Uint8Array>();
  const objects: ImmutableObjects = {
    put: async bytes => {
      const digest = createHash('sha256').update(bytes).digest('hex');
      stored.set(digest, bytes.slice());
      return digest;
    },
    get: async digest => {
      const bytes = stored.get(digest);
      if (!bytes) throw new ObjectNotFound('Fixture immutable page is missing');
      return bytes.slice();
    },
  };
  const composition = async (structure: string, owner: string, profile: 'zone-navigation' | 'collection-membership',
    targets: string[]) => {
    const cost = newCost();
    const records: OccurrenceRecord[] = targets.map((target, at) => ({ occurrence: id(), state: 'active',
      parent: structure, segmentKey: 'a', orderKey: at.toString(36).padStart(8, '0'),
      role: profile === 'zone-navigation' ? 'mount' : 'member', target, labels: [], introducedBy: f.revision,
      ...(profile === 'zone-navigation' ? { qualifier: { type: 'zone-mount' as const, zone: f.zone,
        routeSegment: `picks-${at + 1}`, disclosure: 'public' as const } } : {}),
    }));
    const recordIndex = recordTree(objects), orderIndex = orderTree(objects);
    const recordRoot = await recordIndex.apply(await recordIndex.empty(cost),
      new Map(records.map(record => [record.occurrence, record])), cost);
    const entries: OrderEntry[] = records.map(record => ({ occurrence: record.occurrence,
      parent: structure, segmentKey: record.segmentKey!, orderKey: record.orderKey! }));
    const orderRoot = await orderIndex.apply(await orderIndex.empty(cost),
      new Map(entries.map(entry => [orderTreeKey(entry), entry])), cost);
    const manifest: StructureManifest = { format: STRUCTURE_MANIFEST_FORMAT, structure, structureOf: owner,
      profile, generation: f.generation, pageFormat: STRUCTURE_PAGE_FORMAT, records: recordRoot, order: orderRoot,
      placementCount: records.length, measures: [], model: STRUCTURE_PROFILE, shape: STRUCTURE_PROFILE };
    return { count: records.length, manifest: `urn:rezics:sha256:${await objects.put(new TextEncoder().encode(JSON.stringify(manifest)))}` };
  };
  const collectionTree = await composition(f.structure, f.collection, 'collection-membership',
    placements.map(at => members[at]!.reference));
  const navigationTree = await composition(f.navigation, f.zone, 'zone-navigation',
    [f.collection, otherCollection, f.collection]);
  Object.assign(f.work.environment, { structureObjects: objects });
  const summaryBatches: string[][] = [], nameBatches: string[][] = [], typeBatches: string[][] = [];
  const state = { positions: 0, version: 1, changeAtClose: undefined as (() => void) | undefined };
  const values = (query: string, variable: string) => [...(new RegExp(`VALUES \\?${variable} \\{([^}]*)\\}`)
    .exec(query)?.[1] ?? '').matchAll(/<([^>]+)>/g)].map(match => match[1]!);
  const rows = (records: Record<string, string>[]): SparqlResult => ({ results: { bindings: records.map(record =>
    Object.fromEntries(Object.entries(record).map(([key, value]) => [key, { type: 'literal', value }]))) } });
  const graph = f.work.environment.fuseki;
  const query = graph.query.bind(graph);
  graph.query = async (body, maxBytes) => {
    if (body.includes('SELECT ?epoch ?sequence ?hold ?r ?type')) summaryBatches.push(values(body, 'r'));
    if (body.includes('SELECT ?resource ?manifest')) nameBatches.push(values(body, 'resource'));
    return fencedGraphQuery(graph, body, maxBytes, async () => {
      if (body.includes('SELECT ?sequence WHERE')) {
        if (++state.positions === 2) { state.changeAtClose?.(); state.changeAtClose = undefined; }
        const result = await query(body);
        noteGraphReadVersion(result, String(state.version));
        return result;
      }
      if (body.includes('SELECT ?epoch ?sequence ?hold ?r ?type')) {
        const selected = values(body, 'r').filter(reference => !unavailable.has(reference));
        const result = rows(selected.map(reference => {
          const member = members.find(member => member.reference === reference);
          return { epoch: 'epoch', sequence: '7', r: reference, type: member?.type ?? 'collection',
            public: 'true', erased: 'false', label: reference === otherCollection ? 'Other picks' : 'Picks' };
        }));
        if (!selected.length) return rows([{ epoch: 'epoch', sequence: '7' }]);
        for (const row of result.results!.bindings) row.label!['xml:lang'] = 'en';
        return result;
      }
      if (body.includes('SELECT ?resource ?manifest')) return rows(values(body, 'resource')
        .map(reference => ({ resource: reference, manifest: manifests.get(reference)! })));
      if (body.includes('SELECT ?component ?profile')) {
        const nav = body.includes(`<${f.navigation}>`), tree = nav ? navigationTree : collectionTree;
        return rows([{ component: nav ? f.zone : f.collection,
          profile: `${RV}${nav ? 'ZoneNavigation' : 'CollectionMembership'}`, head: f.revision,
          generation: f.generation, count: String(tree.count), manifest: tree.manifest }]);
      }
      if (body.includes('SELECT ?manifest ?predecessor ?count ?epoch ?sequence')) {
        const tree = body.includes(`rv:component <${f.navigation}>`) ? navigationTree : collectionTree;
        return rows([{ manifest: tree.manifest, count: String(tree.count), epoch: 'epoch', sequence: '7' }]);
      }
      if (body.includes('SELECT DISTINCT ?resource ?type')) {
        const selected = values(body, 'resource');
        typeBatches.push(selected);
        return rows(selected.map(reference => ({ resource: reference, type: `${RV}${members
          .find(member => member.reference === reference)?.type === 'role' ? 'Role' : 'Character'}` })));
      }
      if (body.includes('# Zone population batch')) return rows(values(body, 'work').map(work => ({ work })));
      return query(body);
    });
  };
  f.work.mediaAccess = {
    canReadWorks: async () => new Set<string>(),
    canReadPrivateContexts: async () => new Set<string>(),
    canReadSemantics: async (_principal, _actor, resources) => ({
      public: new Set(resources), granted: new Set<string>(),
    }),
  };
  configureDisclosure(f.work.environment, fixtureDisclosureReader(async targets => targets
    .map(target => hidden.has(target.resource) ? 'hidden' : 'visible')));
  return { ...f, members, unavailable, hidden, rename, state, summaryBatches, nameBatches, typeBatches };
}

test('Zone index selects one entity/role name batch and rereads that dependency once at completion', async () => {
  const f = await summaryRouteFixture();
  try {
    expect(await resolveZoneRoute(f.work, f.request, { zone: f.zone, path: '/picks' })).toMatchObject({ kind: 'index',
      items: f.members.map(member => ({ id: member.reference, name: { value: member.name }, inZone: true })) });
    expect(f.nameBatches).toEqual([f.members.map(member => member.reference), f.members.map(member => member.reference)]);
    expect(f.typeBatches).toEqual([f.members.map(member => member.reference)]);
    expect(f.summaryBatches).toEqual([[f.collection], f.members.map(member => member.reference),
      [f.collection], f.members.map(member => member.reference)]);
  } finally { f.close(); }
});

test('Zone final projection preserves caller order and duplicate members around an unavailable selection', async () => {
  const f = await summaryRouteFixture(3, [1, 2, 0, 1]);
  f.unavailable.add(f.members[2]!.reference);
  try {
    const result = await resolveZoneRoute(f.work, f.request, { zone: f.zone, path: '/picks' });
    expect(result.kind).toBe('index');
    if (result.kind !== 'index') throw new Error('Expected index');
    expect(result.items.map(item => item.id)).toEqual([1, 0, 1].map(at => f.members[at]!.reference));
    expect(result.items.map(item => 'name' in item ? item.name.value : item.title.value))
      .toEqual(['Role 2', 'Entity 1', 'Role 2']);
    const selected = [1, 2, 0].map(at => f.members[at]!.reference);
    expect(f.summaryBatches).toEqual([[f.collection], selected, [f.collection], selected]);
  } finally { f.close(); }
});

test('Zone summary reuse retains unavailable IDs across ranges and batches distinct unknowns at fifty', async () => {
  const f = await summaryRouteFixture(103, [...Array.from({ length: 101 }, (_, at) => at), 0, 101, 102, 101], 100);
  try {
    const result = await resolveZoneRoute(f.work, f.request, { zone: f.zone, path: '/picks' });
    expect(result.kind).toBe('index');
    if (result.kind !== 'index') throw new Error('Expected index');
    expect(result.items.map(item => item.id)).toEqual([100, 101, 102, 101].map(at => f.members[at]!.reference));
    const selected = [[f.collection], ...[f.members.slice(0, 50), f.members.slice(50, 100),
      f.members.slice(100, 101), f.members.slice(101)].map(batch => batch.map(member => member.reference))];
    expect(f.summaryBatches).toEqual([...selected, ...selected]);
    expect(f.summaryBatches.every(batch => batch.length <= 50 && new Set(batch).size === batch.length)).toBe(true);
  } finally { f.close(); }
});

test('Zone navigation reuses selected mount summaries and preserves repeated mounts in order', async () => {
  const f = await summaryRouteFixture();
  try {
    const items = await readZonePresentation(f.work, f.request, f.zone, undefined, async (_state, navigation) => navigation);
    expect(items.map(item => item.segment)).toEqual(['picks-1', 'picks-2', 'picks-3']);
    expect(items.map(item => item.name.value)).toEqual(['Picks', 'Other picks', 'Picks']);
    expect(f.summaryBatches).toHaveLength(2);
    expect(f.summaryBatches[0]).toEqual(f.summaryBatches[1]);
  } finally { f.close(); }
});

test('Zone summary reuse is isolated to each request', async () => {
  const f = await summaryRouteFixture();
  try {
    const read = () => resolveZoneRoute(f.work, f.request, { zone: f.zone, path: '/picks' });
    expect(await read()).toMatchObject({ kind: 'index', items: [{ name: { value: 'Entity 1' } }, { name: { value: 'Role 2' } }] });
    f.rename(0, 'Current entity');
    f.state.version++;
    expect(await read()).toMatchObject({ kind: 'index', items: [{ name: { value: 'Current entity' } }, { name: { value: 'Role 2' } }] });
    expect(f.nameBatches).toHaveLength(4);
  } finally { f.close(); }
});

test('Zone final summary fence detects a changed name and retries with a fresh attempt selection', async () => {
  const f = await summaryRouteFixture();
  f.state.changeAtClose = () => { f.rename(0, 'Renamed at completion'); f.state.version++; };
  try {
    expect(await resolveZoneRoute(f.work, f.request, { zone: f.zone, path: '/picks' }))
      .toMatchObject({ kind: 'index', items: [{ name: { value: 'Renamed at completion' } }, { name: { value: 'Role 2' } }] });
    expect(f.nameBatches).toHaveLength(4);
    expect(f.typeBatches).toHaveLength(3);
  } finally { f.close(); }
});

test('Zone final summary fence withholds a selected member whose disclosure closes without a graph change', async () => {
  const f = await summaryRouteFixture();
  f.state.changeAtClose = () => { f.hidden.add(f.members[0]!.reference); };
  try {
    const result = await resolveZoneRoute(f.work, f.request, { zone: f.zone, path: '/picks' });
    expect(result.kind).toBe('index');
    if (result.kind !== 'index') throw new Error('Expected index');
    expect(result.items.map(item => item.id)).toEqual([f.members[1]!.reference]);
    expect(f.nameBatches).toHaveLength(4);
  } finally { f.close(); }
});

test('Zone detail final projection uses selected summaries and keeps the closing dependency reread', async () => {
  const f = fixture({ member: true, readable: true });
  try {
    expect(await resolveZoneRoute(f.work, f.request, { zone: f.zone, path: `/picks/${f.resource.slice(-36)}` }))
      .toMatchObject({ kind: 'detail', resource: { id: f.resource } });
    expect(f.queries.filter(query => query.includes('SELECT ?epoch ?sequence ?hold ?r ?type'))).toHaveLength(4);
  } finally { f.close(); }
});

test('independent home, document and Collection detail routes omit a closed Realm without losing their resources', async () => {
  for (const workMount of [false, true]) for (const closedRealm of [false, true]) {
    const f = fixture({ member: true, readable: true, adopted: true, workMount, closedRealm });
    try {
      const paths = ['/', ...(workMount ? ['/guide'] : [`/picks/${f.resource.slice(-36)}`,
        `/picks/${f.resource.slice(-36)}/discussion`])];
      for (const path of paths) expect(await resolveZoneRoute(f.work, f.request, { zone: f.zone, path }))
        .toMatchObject({ realm: closedRealm ? null : f.realm });
      const dependent = resolveZoneRoute(f.work, f.request, { zone: f.zone, path: `/w/${f.resource.slice(-36)}` });
      if (closedRealm) await expect(dependent).rejects.toBeInstanceOf(ZoneRouteMissing);
      else expect(await dependent).toMatchObject({ realm: f.realm, resource: { id: f.resource } });
    } finally { f.close(); }
  }
});

test('G630 class guard: paths × membership × disclosure; a readable non-member never resolves', async () => {
  for (const member of [false, true]) for (const readable of [false, true]) {
    const f = fixture({ member, readable });
    try {
      for (const tab of ['', '/discussion', '/future-tab']) {
        const result = resolveZoneRoute(f.work, f.request, { zone: f.zone,
          path: `/picks/${f.resource.slice(-36)}${tab}` });
        if (member && readable) expect(await result).toMatchObject({ kind: 'detail',
          collection: f.collection, resource: { id: f.resource }, tab: tab ? tab.slice(1) : null });
        else await expect(result).rejects.toBeInstanceOf(ZoneRouteMissing);
      }
      expect(f.queries.filter(query => query.includes('ASK') && query.includes('rv:MemberRole'))).toHaveLength(6);
      // Three tab reads, including their bounded selected-input fences and
      // one canonical Space address batch per successful route.
      expect(f.queries.length).toBeLessThanOrEqual(108);
    } finally { f.close(); }
  }
});

test('G630/G506: Collection summaries opt in with base/work null and outrank semantic attachments', async () => {
  const f = fixture({ member: true, readable: true, collectionSemantic: true });
  try {
    const input = { resources: [f.collection], context: DEFAULT_MEDIA_CONTEXT, language: null };
    expect((await readResourceSummaries(f.work.environment, undefined, {}, input)).summaries)
      .toEqual([{ reference: f.collection, status: 'unavailable' }]);
    expect((await readResourceSummaries(f.work.environment, undefined, {}, { ...input, includeCollections: true })).summaries)
      .toMatchObject([{ reference: f.collection, status: 'available', type: 'collection', base: null, work: null }]);
    expect(summaryBases.collection).toBeNull();
  } finally { f.close(); }
});

test('G630: direct Work routes need an exact public adoption; grants never replace population', async () => {
  for (const adopted of [false, true]) {
    const f = fixture({ member: false, readable: true, adopted, granted: true });
    try {
      const result = resolveZoneRoute(f.work, f.request, { zone: f.zone, path: `/w/${f.resource.slice(-36)}` });
      if (adopted) expect(await result).toMatchObject({ kind: 'detail', mount: null, collection: null });
      else await expect(result).rejects.toBeInstanceOf(ZoneRouteMissing);
    } finally { f.close(); }
  }
});

test('G630: private mounts and members require current grants, while Work mounts are documents', async () => {
  const f = fixture({ member: true, readable: false, privateMount: true, granted: true });
  try {
    const path = `/picks/${f.resource.slice(-36)}`;
    await expect(resolveZoneRoute(f.work, f.request, { zone: f.zone, path })).rejects.toBeInstanceOf(ZoneRouteMissing);
    expect(await resolveZoneRoute(f.work, f.request, { zone: f.zone, path, actingSubject: id() }))
      .toMatchObject({ kind: 'detail', resource: { id: f.resource } });
    expect((await readResourceSummaries(f.work.environment, undefined, {}, {
      resources: [f.collection], context: DEFAULT_MEDIA_CONTEXT, language: null })).summaries)
      .toEqual([{ reference: f.collection, status: 'unavailable' }]);
  } finally { f.close(); }
  const document = fixture({ member: false, readable: true, workMount: true });
  try {
    expect(await resolveZoneRoute(document.work, document.request, { zone: document.zone, path: '/guide' }))
      .toMatchObject({ kind: 'document', resource: { id: document.resource } });
    await expect(resolveZoneRoute(document.work, document.request, { zone: document.zone,
      path: `/guide/${document.resource.slice(-36)}` })).rejects.toBeInstanceOf(ZoneRouteMissing);
  } finally { document.close(); }
});

test('an unrelated graph write preserves the Zone route and its opening position without replaying OAuth', async () => {
  const f = fixture({ member: true, readable: true, moved: 'once', granted: true });
  try {
    expect(await resolveZoneRoute(f.work, f.request, { zone: f.zone, actingSubject: id(),
      path: `/picks/${f.resource.slice(-36)}` })).toMatchObject({ kind: 'detail', sourcePosition: { sequence: '7' } });
    expect(f.scopes).toEqual([['semantic:read'], ['work:read']]);
    expect(f.queries.filter(query => query.includes('rv:MemberRole'))).toHaveLength(2);
  } finally { f.close(); }
  const removed = fixture({ member: true, readable: true, moved: 'once', removedDuringRead: true });
  try {
    await expect(resolveZoneRoute(removed.work, removed.request, { zone: removed.zone,
      path: `/picks/${removed.resource.slice(-36)}` })).rejects.toBeInstanceOf(ZoneRouteMissing);
  } finally { removed.close(); }
});

test('continuous unrelated graph writes do not consume Zone retries', async () => {
  const f = fixture({ member: true, readable: true, moved: 'always' });
  try {
    expect(await resolveZoneRoute(f.work, f.request, { zone: f.zone,
      path: `/picks/${f.resource.slice(-36)}` })).toMatchObject({ kind: 'detail', sourcePosition: { sequence: '8' } });
    expect(f.queries.filter(query => query.includes('rv:MemberRole'))).toHaveLength(2);
    expect(ZONE_ROUTE_COST).toMatchObject({ pageSize: 24, maxNavigation: 50, membershipQueries: 1, immutableRangeRows: 101 });
  } finally { f.close(); }
});

test('G630: semantic OAuth scope and Work Access grants cannot disclose private members or documents', async () => {
  for (const workMount of [false, true]) {
    const f = fixture({ member: true, readable: false, workMount, granted: true, deniedWorkScope: true });
    try {
      await expect(resolveZoneRoute(f.work, f.request, { zone: f.zone, actingSubject: id(),
        path: workMount ? '/guide' : `/picks/${f.resource.slice(-36)}` })).rejects.toBeInstanceOf(ZoneRouteMissing);
      expect(f.scopes).toEqual([['semantic:read'], ['work:read']]);
    } finally { f.close(); }
  }
});

test('G630: a private-mount grant revoked during hydration is fenced without a graph change', async () => {
  const f = fixture({ member: true, readable: true, privateMount: true, granted: true, revoked: true });
  try {
    await expect(resolveZoneRoute(f.work, f.request, { zone: f.zone, actingSubject: id(),
      path: `/picks/${f.resource.slice(-36)}` })).rejects.toBeInstanceOf(ZoneRouteMissing);
  } finally { f.close(); }
});
