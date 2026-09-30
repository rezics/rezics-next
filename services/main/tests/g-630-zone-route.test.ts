import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import type { SparqlResult } from '../src/infrastructure/fuseki.ts';
import { RV, prepareComponent } from '../src/modules/work/activate.ts';
import { WorkReadUnavailable } from '../src/modules/work/read-session.ts';
import { WORK_READ_COST } from '../src/modules/work/read-contract.ts';
import { ZONE_CONFIG_FORMAT, ZONE_PROFILE } from '../src/modules/zone/config-format.ts';
import { parseZonePath, ZONE_RESERVED_SEGMENTS } from '../src/modules/zone/route-path.ts';
import { resolveZoneRoute, ZoneRouteMissing, ZONE_ROUTE_COST } from '../src/modules/zone/route.ts';
import { readResourceSummaries, summaryBases } from '../src/modules/media/summary.ts';
import { DEFAULT_MEDIA_CONTEXT } from '../src/modules/media/store.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;

test('G630: exact route paths admit native resources and pass slug tabs to the host', () => {
  const resource = randomUUID();
  expect(parseZonePath('/')).toEqual({ kind: 'home' });
  expect(parseZonePath('/picks')).toEqual({ kind: 'mount', segment: 'picks', resource: null, tab: null });
  expect(parseZonePath(`/picks/${resource}/discussion`)).toEqual({ kind: 'mount', segment: 'picks',
    resource, tab: 'discussion' });
  expect(parseZonePath(`/w/${resource}/future-tab`)).toEqual({ kind: 'work', resource, tab: 'future-tab' });
  for (const path of ['', 'picks', '//picks', '/picks/', '/picks/not-a-uuid', '/w', '/picks/../about',
    '/picks%2fextra', `/picks/${resource}/tab/more`, `/picks/${resource}/`, '/UPPER',
    `/${'a'.repeat(65)}`, ...ZONE_RESERVED_SEGMENTS.filter(segment => segment !== 'w').map(segment => `/${segment}`)]) {
    expect(parseZonePath(path)).toBeNull();
  }
});

function fixture(input: { member: boolean; readable: boolean; adopted?: boolean;
  workMount?: boolean; privateMount?: boolean; granted?: boolean; moved?: 'once' | 'always';
  removedDuringRead?: boolean; deniedWorkScope?: boolean; collectionSemantic?: boolean; revoked?: boolean }) {
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
      queries.push(query);
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
        manifest: `urn:rezics:sha256:${manifest}`, state: `${RV}Active`, disclosure: `${RV}Public`, realm }]);
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
      throw new Error(`Unexpected Zone query: ${query}`);
    } } }, account: { verify: async (_request: Request, required: string[]) => {
      scopes.push(required);
      if (input.deniedWorkScope && required.includes('work:read')) throw new Error('OAuth scope denied');
      return { issuer: 'test', subject: 'reader' };
    } },
    access: { canReadWork: async () => input.granted === true,
      canReadSemanticResource: async () => input.granted === true
        && (!input.revoked || ++semanticChecks === 1) } } as unknown as MainWorkDependencies;
  const request = new Request('http://main.local/v1/zones/test/routes');
  return { work, request, zone, resource, collection, queries, scopes, directory,
    close: () => rmSync(directory, { recursive: true, force: true }) };
}

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
      expect(f.queries.filter(query => query.includes('ASK') && query.includes('rv:MemberRole'))).toHaveLength(3);
      expect(f.queries.length).toBeLessThan(50);
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

test('G630: a graph write retries the route against fresh population and repeats OAuth scopes', async () => {
  const f = fixture({ member: true, readable: true, moved: 'once', granted: true });
  try {
    expect(await resolveZoneRoute(f.work, f.request, { zone: f.zone, actingSubject: id(),
      path: `/picks/${f.resource.slice(-36)}` })).toMatchObject({ kind: 'detail', sourcePosition: { sequence: '8' } });
    expect(f.scopes).toEqual([['semantic:read'], ['work:read'], ['semantic:read'], ['work:read']]);
    expect(f.queries.filter(query => query.includes('rv:MemberRole'))).toHaveLength(2);
  } finally { f.close(); }
  const removed = fixture({ member: true, readable: true, moved: 'once', removedDuringRead: true });
  try {
    await expect(resolveZoneRoute(removed.work, removed.request, { zone: removed.zone,
      path: `/picks/${removed.resource.slice(-36)}` })).rejects.toBeInstanceOf(ZoneRouteMissing);
  } finally { removed.close(); }
});

test('G630: continuous graph writes exhaust the bounded retries without returning a route conflict', async () => {
  const f = fixture({ member: true, readable: true, moved: 'always' });
  try {
    await expect(resolveZoneRoute(f.work, f.request, { zone: f.zone,
      path: `/picks/${f.resource.slice(-36)}` })).rejects.toBeInstanceOf(WorkReadUnavailable);
    expect(f.queries.filter(query => query.includes('rv:MemberRole'))).toHaveLength(WORK_READ_COST.attempts);
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
