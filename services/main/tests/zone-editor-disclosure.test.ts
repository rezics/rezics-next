import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { documentVersion, parseDocument } from '@rezics/document';
import type { ExactReadResult } from '../../content/src/core.ts';
import type { ImmutableObjects } from '../src/infrastructure/immutable-objects.ts';
import { prepareWorkComponent, RV } from '../src/modules/work/activate.ts';
import { ZONE_CONFIG_FORMAT, ZONE_PROFILE, zonePublishedPageBinding } from '../src/modules/zone/config-format.ts';
import { DEFAULT_ZONE_PRESENTATION, ZONE_PRESENTATION_PROFILE } from '../src/modules/zone/presentation-format.ts';
import { ZONE_LOCAL_SHOWCASE_BLOCK } from '../src/modules/presentation/zone-document.ts';
import { readZonePublication, isZonePublishedPageRevision } from '../src/modules/zone/publication.ts';
import { compositionReceiptIri, orderTree, recordTree } from '../src/modules/structure/change.ts';
import { STRUCTURE_MANIFEST_FORMAT, STRUCTURE_PAGE_FORMAT, STRUCTURE_PROFILE,
  type OccurrenceRecord, type StructureManifest } from '../src/modules/structure/format.ts';
import { orderTreeKey } from '../src/modules/structure/graph.ts';
import { newCost } from '../src/modules/structure/tree.ts';
import { AdmissionDenied, AdmissionUnavailable } from '../src/modules/access/admission.ts';
import { AccountAssertionDenied, AccountAssertionInsufficientScope, AccountAssertionUnavailable }
  from '../src/modules/account/verify-assertion.ts';
import { fusekiReadBudget, FusekiReadBudgetExceeded, type FusekiClient } from '../src/infrastructure/fuseki.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { zoneRoutes } from '../src/routes/zones.ts';
import { configureDisclosure } from '../src/modules/disclosure/read.ts';
import { configureFixtureDisclosureAncestry, fixtureDisclosureReader } from './support/disclosure-ancestry.ts';

function fixture(input: { verificationError?: Error; authorityError?: Error; missingAuthority?: boolean } = {}) {
  const zone = `https://rezics.com/id/${randomUUID()}`;
  const actor = `https://rezics.com/id/${randomUUID()}`;
  const principal = { issuer: 'https://account.local', subject: 'reader' };
  const probes = { authentication: 0, authority: 0, graph: 0 };
  const fuseki = { query: async (query: string) => {
    probes.graph++;
    return query.includes('ASK') ? { boolean: true } : { results: { bindings: [] } };
  } } as unknown as FusekiClient;
  const work = { environment: { fuseki, lineage: { dataEpoch: 'epoch', routingEpoch: '1' } },
    account: { verify: async (_request: Request, scopes: string[]) => {
      probes.authentication++;
      expect(scopes).toEqual(['zone:edit']);
      if (input.verificationError) throw input.verificationError;
      return principal;
    } }, access: { ...(input.missingAuthority ? {} : {
      assertAuthority: async (request: unknown) => {
        probes.authority++;
        expect(request).toEqual({ principal, actingSubject: actor, scope: `zone:edit:${zone}`, action: 'zone.edit' });
        if (input.authorityError) throw input.authorityError;
      },
    }) } } as unknown as MainWorkDependencies;
  configureFixtureDisclosureAncestry(work.environment, () => undefined);
  configureDisclosure(work.environment, fixtureDisclosureReader(async targets => targets.map(() => 'visible')));
  const app = zoneRoutes(fuseki, work);
  return { probes, read: (endpoint: string) => app.handle(new Request(
    `http://main.local/v1/zones/${zone.slice(-36)}/${endpoint}?actingSubject=${encodeURIComponent(actor)}`,
    { headers: { authorization: 'Bearer reader' } },
  )) };
}

const id = () => `https://rezics.com/id/${randomUUID()}`;
const row = (values: Record<string, string>) => Object.fromEntries(Object.entries(values)
  .map(([key, value]) => [key, { type: 'literal' as const, value }]));

/** Real immutable configuration and navigation readers; the graph and owner
 * transport are simulated so every write and unexpected read fails the test. */
async function savedSite(mountCount = 1, foreignMount = false) {
  const zone = id(), actor = id(), space = id(), navigation = id(), revision = id(), navRevision = id();
  const homeDocument = id(), homeRevision = id();
  const publishedRevision = id(), publishedNav = id(), publishedContent = randomUUID();
  const admissionId = randomUUID(), receipt = compositionReceiptIri(admissionId, 'zone.edit');
  const variantId = `urn:rezics:variant:${randomUUID()}`, contentRevision = randomUUID();
  const stored = new Map<string, Uint8Array>();
  const objects: ImmutableObjects = {
    put: async bytes => { const digest = createHash('sha256').update(bytes).digest('hex');
      stored.set(digest, bytes); return digest; },
    get: async digest => { const bytes = stored.get(digest); if (!bytes) throw new Error('Missing object'); return bytes; },
  };
  const presentation = { ...DEFAULT_ZONE_PRESENTATION, modules: [], slides: [],
    tokens: { ...DEFAULT_ZONE_PRESENTATION.tokens, density: 'compact' as const, pageSurface: 'cards' as const },
    navigation: [{ label: 'Saved menu', href: '/saved' }] };
  const configuration = { format: ZONE_CONFIG_FORMAT, zone, space, navigation, homeDocument, state: 'active' as const,
    disclosure: 'public' as const, presentation, budget: { timeMs: 2000, rows: 1000 }, queryBlocks: [], model: ZONE_PROFILE };
  const manifest = `urn:rezics:sha256:${await prepareWorkComponent(objects, zone,
    { configuration, name: 'Draft site', language: 'en' }, ZONE_PROFILE)}`;
  const publicManifest = `urn:rezics:sha256:${await prepareWorkComponent(objects, zone,
    { configuration: { ...configuration, presentation: DEFAULT_ZONE_PRESENTATION }, name: 'Public site', language: 'en' }, ZONE_PROFILE)}`;
  const generation = id();
  const records: OccurrenceRecord[] = Array.from({ length: mountCount }, (_, index) => ({
    occurrence: id(), state: 'active', role: 'mount', parent: navigation,
    segmentKey: 'i', orderKey: String(index).padStart(8, '0'), labels: [], introducedBy: navRevision,
    target: id(), qualifier: { type: 'zone-mount', zone: foreignMount && index === 0 ? id() : zone,
      routeSegment: `saved-${index}`, disclosure: 'public' },
  }));
  const cost = newCost(), recordIndex = recordTree(objects), orderIndex = orderTree(objects);
  const entries = records.map(({ occurrence, parent, segmentKey, orderKey }) =>
    ({ occurrence, parent, segmentKey: segmentKey!, orderKey: orderKey! }));
  const navManifest: StructureManifest = { format: STRUCTURE_MANIFEST_FORMAT, structure: navigation,
    structureOf: zone, profile: 'zone-navigation', generation, pageFormat: STRUCTURE_PAGE_FORMAT,
    records: await recordIndex.apply(await recordIndex.empty(cost), new Map(records.map(item => [item.occurrence, item])), cost),
    order: await orderIndex.apply(await orderIndex.empty(cost), new Map(entries.map(item => [orderTreeKey(item), item])), cost),
    placementCount: mountCount, measures: [], model: STRUCTURE_PROFILE, shape: STRUCTURE_PROFILE };
  const navDigest = `urn:rezics:sha256:${await objects.put(new TextEncoder().encode(JSON.stringify(navManifest)))}`;
  const document = parseDocument({ version: documentVersion, profile: 'blocks', doc: { type: 'doc', content: [
    { type: 'extensionBlock', attrs: { id: 'saved-hero', definition: ZONE_LOCAL_SHOWCASE_BLOCK.definition,
      version: '2', fallback: 'Saved hero', payload: {
        'rv:module': [{ id: 'hero', type: 'hero-carousel', title: 'Saved campaign',
          source: { kind: 'query-block', block: 'new-adoptions' } }],
        'rv:slides': [{ id: 'saved', href: '/saved', title: 'Saved slide' }], 'rv:titleEffect': ['outline'],
      } } },
  ] } });
  const body = { document }, serializedJson = JSON.stringify(body);
  const exact: ExactReadResult = { status: 'available', revisionId: contentRevision, body, serializedJson,
    reference: { owner: 'content', resourceId: homeDocument, variantId, revisionId: contentRevision,
      format: 'rezics-content-json-v1', model: 'content-shape-v1', byteDigest: createHash('sha256').update(serializedJson).digest('hex'),
      byteLength: Buffer.byteLength(serializedJson), direction: 'ltr', language: { kind: 'tag', tag: 'en', originalTag: 'en' },
      sourceRevision: null, predecessor: null, provenance: {} } };
  const state = { revoked: false, bridgeRevoked: false, empty: false, exact: exact as ExactReadResult,
    replacementContent: randomUUID(),
    headReads: 0, bodyReads: 0, configReads: 0, navigationReads: 0,
    moved: '' as '' | 'content' | 'configuration' | 'navigation', missingNavigation: false, missingObject: false,
    targetChecks: 0, revokeTarget: false, readable: true };
  const principal = { issuer: 'https://account.local', subject: 'editor', emailVerified: true };
  const fuseki = { query: async (query: string) => {
    const budget = fusekiReadBudget.getStore();
    if (budget) {
      if (budget.callsLeft <= 0) throw new FusekiReadBudgetExceeded('Graph read budget exceeded');
      budget.callsLeft--;
    }
    if (query.includes('ASK') && query.includes('rv:admittedScope')) {
      return { boolean: query.includes(`urn:rezics:content:revision:${publishedContent}`) };
    }
    if (query.includes('ASK')) return { boolean: true };
    if (query.includes('SELECT ?space ?navigation ?head')) {
      state.configReads++;
      return { results: { bindings: [row({ space, navigation,
        head: state.moved === 'configuration' && state.bodyReads ? id() : revision,
        manifest, homeDocument, homeRevision, state: RV + 'Active', spaceDisclosure: RV + 'Public', presentation: ZONE_PRESENTATION_PROFILE,
        publication: publishedRevision })] } };
    }
    if (query.includes('SELECT ?receipt')) return { results: { bindings: [row({ receipt })] } };
    if (query.includes('SELECT ?zone ?revision ?routesRevision')) return { results: { bindings: [row({
      zone, revision: publishedRevision, routesRevision: publishedNav, navigationRevision: publishedNav,
      themeRevision: publishedRevision, count: '1', admissionId, digest: 'a'.repeat(64), authorityEpoch: '1',
      scope: `zone:edit:${zone}`, dataEpoch: 'epoch', sequence: '1', page: homeDocument, variant: variantId,
      homeDocument, homeRevision, byteDigest: exact.reference.byteDigest,
      binding: zonePublishedPageBinding(publishedRevision, homeDocument, publishedContent),
      contentRevision: `urn:rezics:content:revision:${publishedContent}`, language: 'en',
    })] } };
    if (query.includes('SELECT ?admission ?receipt ?digest')) return { results: { bindings: [row({
      admission: admissionId, receipt, digest: 'a'.repeat(64),
    })] } };
    if (query.includes('SELECT ?component ?profile')) {
      state.navigationReads++;
      return { results: { bindings: state.missingNavigation ? [] : [row({ component: zone, profile: RV + 'ZoneNavigation',
        head: state.moved === 'navigation' && state.navigationReads > 1 ? id() : navRevision,
        generation, count: String(mountCount), manifest: navDigest })] } };
    }
    if (query.includes('SELECT ?owner')) return { results: { bindings: [row({ owner: zone })] } };
    if (query.includes('SELECT ?manifest ?predecessor') || query.includes('SELECT ?manifest ?count')) {
      return { results: { bindings: [row({ manifest: state.missingObject ? `urn:rezics:sha256:${'0'.repeat(64)}` : navDigest,
        count: String(mountCount), epoch: 'epoch', sequence: '1' })] } };
    }
    if (query.includes('SELECT ?manifest')) return { results: { bindings: [row({ manifest: publicManifest })] } };
    if (query.includes('SELECT ?target')) return { results: { bindings: [] } };
    throw new Error(`Unexpected saved site query: ${query.slice(0, 180)}`);
  } } as unknown as FusekiClient;
  const work = { environment: { fuseki, workObjects: objects, structureObjects: objects,
    lineage: { dataEpoch: 'epoch', routingEpoch: '1' } }, structureObjects: objects,
    account: { verify: async (request: Request) => {
      if (!request.headers.has('authorization')) throw new AccountAssertionDenied('Sign in required');
      return principal;
    } }, access: {
      assertAuthority: async () => { if (state.revoked) throw new AdmissionDenied('Revoked'); },
      activePrincipalId: async () => admissionId,
      withOwnerAuthority: async (_request: unknown, operation: (client: PoolClient) => Promise<unknown>) => {
        if (state.bridgeRevoked) throw new AdmissionDenied('Revoked during read');
        return operation({ query: async (sql: string) => ({ rows: [],
          rowCount: sql.includes('SELECT a.id FROM access.admission a') ? 1 : 0 }) } as unknown as PoolClient);
      },
      canReadWork: async () => { state.targetChecks++;
        return state.readable && !(state.revokeTarget && state.targetChecks > mountCount); },
      canReadSemanticResource: async () => state.readable,
    }, contentAuthoring: {
      readDraftHead: async () => { state.headReads++; return state.empty ? null : {
        revisionId: state.moved === 'content' && state.headReads > 1 ? state.replacementContent : contentRevision,
        position: { owner: 'content', dataEpoch: 'epoch', sequence: '2' } }; },
      readExactBatch: async () => { state.bodyReads++; return [state.exact]; },
      ownerPosition: async () => ({ owner: 'content', dataEpoch: 'epoch', sequence: '2' }),
    } } as unknown as MainWorkDependencies;
  configureFixtureDisclosureAncestry(work.environment, () => undefined);
  configureDisclosure(work.environment, fixtureDisclosureReader(async targets => targets.map(() => 'visible')));
  const app = zoneRoutes(fuseki, work);
  return { work, state, zone, homeDocument, variantId, contentRevision, navRevision, records, document, publishedContent,
    read: (input: { anonymous?: boolean; after?: string } = {}) => app.handle(new Request(
      `http://main.local/v1/zones/${zone.slice(-36)}/showcase-editor?actingSubject=${encodeURIComponent(actor)}`
        + (input.after ? `&after=${encodeURIComponent(input.after)}` : ''),
      { headers: input.anonymous ? {} : { authorization: 'Bearer editor' } })) };
}

test('saved site preview resolves the page, local campaign, structural tokens and current navigation without publishing', async () => {
  const f = await savedSite();
  const before = await readZonePublication(f.work.environment, f.zone);
  expect(await isZonePublishedPageRevision(f.work.environment, f.zone, f.homeDocument, f.publishedContent)).toBe(true);
  expect(await isZonePublishedPageRevision(f.work.environment, f.zone, f.homeDocument, f.contentRevision)).toBe(false);
  const response = await f.read();
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const result = await response.json();
  expect(result.preview.page.document).toEqual(f.document);
  expect(result.preview.page.blocks[0].status).toBe('resolved');
  expect(result.preview.page.showcases[0].sources[0].state).toBe('public-read');
  expect(result.preview.presentation).toMatchObject({ tokens: { density: 'compact', pageSurface: 'cards', titleEffect: 'outline' },
    navigation: [{ label: 'Saved menu', href: '/saved' }], slides: [{ id: 'saved', href: '/saved' }],
    modules: [{ id: 'hero', title: 'Saved campaign' }] });
  expect(result.preview.renderTokens).toMatchObject({ density: 'compact', pageSurface: 'cards' });
  expect(result.preview.navigation).toMatchObject({ revision: f.navRevision, mounts: f.records, next: null });
  expect(await readZonePublication(f.work.environment, f.zone)).toEqual(before);
  expect(await isZonePublishedPageRevision(f.work.environment, f.zone, f.homeDocument, f.contentRevision)).toBe(false);
  expect(await isZonePublishedPageRevision(f.work.environment, f.zone, f.homeDocument, f.publishedContent)).toBe(true);
});

test('anonymous and revoked viewers cannot read saved draft bytes', async () => {
  for (const denial of ['anonymous', 'revoked', 'bridgeRevoked'] as const) {
    const f = await savedSite();
    if (denial !== 'anonymous') f.state[denial] = true;
    expect((await f.read({ anonymous: denial === 'anonymous' })).status)
      .toBe(denial === 'anonymous' ? 401 : denial === 'revoked' ? 404 : 403);
    expect(f.state.bodyReads).toBe(0);
  }
});

test('malformed, unavailable and mismatched saved draft resolutions never succeed', async () => {
  for (const invalid of ['unavailable', 'document', 'missing-document', 'resource', 'variant', 'revision',
    'navigation', 'object'] as const) {
    const f = await savedSite();
    const exact = f.state.exact;
    if (exact.status !== 'available') throw new Error('Expected available fixture');
    if (invalid === 'unavailable') f.state.exact = { revisionId: f.contentRevision, status: 'unavailable' };
    if (invalid === 'document') exact.body.document = { malformed: true };
    if (invalid === 'missing-document') delete exact.body.document;
    if (invalid === 'resource') exact.reference.resourceId = id();
    if (invalid === 'variant') exact.reference.variantId = `urn:rezics:variant:${randomUUID()}`;
    if (invalid === 'revision') exact.reference.revisionId = randomUUID();
    if (invalid === 'navigation') f.state.missingNavigation = true;
    if (invalid === 'object') f.state.missingObject = true;
    expect((await f.read()).status).not.toBe(200);
  }
});

test('a moved Content, configuration or navigation head refuses a mixed saved preview', async () => {
  for (const moved of ['content', 'configuration', 'navigation'] as const) {
    const f = await savedSite(); f.state.moved = moved;
    expect((await f.read()).status).toBe(409);
  }
});

test('unsupported or invalid extension payloads preserve authored bytes with an explicit unresolved block', async () => {
  for (const unknown of [false, true]) {
    const f = await savedSite();
    if (f.state.exact.status !== 'available') throw new Error('Expected available fixture');
    const document = parseDocument({ version: documentVersion, profile: 'blocks', doc: { type: 'doc', content: [
      { type: 'extensionBlock', attrs: { id: 'unresolved',
        definition: unknown ? 'https://rezics.com/definition/unknown-block' : ZONE_LOCAL_SHOWCASE_BLOCK.definition,
        version: '2', fallback: 'Retained fallback', payload: { unsupported: true } } },
    ] } });
    f.state.exact.body.document = document;
    const response = await f.read(); expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.preview.page.document).toEqual(document);
    expect(result.preview.page.blocks[0]).toMatchObject({ status: 'placeholder',
      reason: unknown ? 'unknown_definition' : 'invalid_payload' });
    expect(result.preview.page.showcases).toEqual([]);
  }
});

test('an oversized preview refuses delivery instead of bypassing the document response budget', async () => {
  const f = await savedSite();
  if (f.state.exact.status !== 'available') throw new Error('Expected available fixture');
  f.state.exact.body.notes = 'x'.repeat(4 * 1024 * 1024);
  expect((await f.read()).status).toBe(503);
});

test('draft navigation retains continuation and resolves every mount across its bounded pages', async () => {
  const f = await savedSite(51);
  const first = await f.read(); expect(first.status).toBe(200);
  const firstPage = (await first.json()).preview.navigation;
  expect(firstPage.mounts).toHaveLength(50);
  expect(firstPage.next).toBeString();
  const second = await f.read({ after: firstPage.next }); expect(second.status).toBe(200);
  const secondPage = (await second.json()).preview.navigation;
  expect(secondPage.mounts).toHaveLength(1);
  expect(secondPage.next).toBeNull();
  expect([...firstPage.mounts, ...secondPage.mounts]).toEqual(f.records);
});

test('navigation continuation refuses changed saved cuts and malformed cursors', async () => {
  for (const moved of ['content', 'configuration', 'navigation'] as const) {
    const f = await savedSite(51);
    const first = await f.read(); expect(first.status).toBe(200);
    const cursor = (await first.json()).preview.navigation.next;
    f.state.moved = moved;
    if (moved === 'content' && f.state.exact.status === 'available') {
      f.state.exact.revisionId = f.state.replacementContent;
      f.state.exact.reference.revisionId = f.state.replacementContent;
    }
    expect((await f.read({ after: cursor })).status).toBe(409);
  }
  const f = await savedSite();
  expect((await f.read({ after: 'malformed' })).status).toBe(400);
});

test('navigation excludes foreign qualifiers and unreadable targets, and fences mid-read target revocation', async () => {
  const foreign = await savedSite(1, true);
  expect((await (await foreign.read()).json()).preview.navigation.mounts).toEqual([]);
  const hidden = await savedSite(); hidden.state.readable = false;
  expect((await (await hidden.read()).json()).preview.navigation.mounts).toEqual([]);
  const revoked = await savedSite(); revoked.state.revokeTarget = true;
  expect((await revoked.read()).status).toBe(409);
});

test('preview resolution shares and respects the existing outer graph read budget', async () => {
  const f = await savedSite();
  const budget = { signal: AbortSignal.timeout(5000), callsLeft: 8, bytesLeft: 1024 * 1024 };
  const response = await fusekiReadBudget.run(budget, () => f.read());
  expect({ status: response.status, body: await response.json() }).toMatchObject({ status: 503 });
  expect(budget.callsLeft).toBe(0);
});

test('a cancelled preview returns unavailable before reading saved draft bytes', async () => {
  const f = await savedSite();
  const controller = new AbortController(); controller.abort(new Error('Read cancelled'));
  const response = await fusekiReadBudget.run({ signal: controller.signal, callsLeft: 100, bytesLeft: 1024 * 1024 }, () => f.read());
  expect(response.status).toBe(503);
  expect(f.state.bodyReads).toBe(0);
});

test('a Zone with no saved Content head has an explicit empty page and its saved shell', async () => {
  const f = await savedSite(0); f.state.empty = true;
  const response = await f.read(); expect(response.status).toBe(200);
  const result = await response.json();
  expect(result.draft.revisionId).toBeNull(); expect(result.preview.page).toBeNull();
  expect(result.preview.presentation.tokens).toMatchObject({ density: 'compact', pageSurface: 'cards' });
  expect(f.state.bodyReads).toBe(0);
});

for (const endpoint of ['configuration', 'showcase-editor']) {
  test(`Zone ${endpoint} hides authority denial with the missing configuration problem before owner IO`, async () => {
    const missing = fixture();
    const missingResponse = await missing.read(endpoint);
    expect(missingResponse.status).toBe(404);
    expect(missing.probes).toEqual({ authentication: 1, authority: 1, graph: 2 });
    const denied = fixture({ authorityError: new AdmissionDenied('Reader cannot edit this Zone') });
    const deniedResponse = await denied.read(endpoint);
    expect(deniedResponse.status).toBe(404);
    expect(await deniedResponse.json()).toEqual(await missingResponse.json());
    expect(denied.probes).toEqual({ authentication: 1, authority: 1, graph: 0 });
  });

  test(`Zone ${endpoint} hides missing editor scope and fails closed without an authority probe`, async () => {
    for (const input of [
      { verificationError: new AccountAssertionInsufficientScope('No zone:edit consent') },
      { missingAuthority: true },
    ]) {
      const f = fixture(input);
      const response = await f.read(endpoint);
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ code: 'zone_unavailable', title: 'Zone is unavailable' });
      expect(f.probes).toEqual({ authentication: 1, authority: 0, graph: 0 });
    }
  });

  test(`Zone ${endpoint} preserves authentication and unavailable-service outcomes before owner IO`, async () => {
    for (const [input, status, authority] of [
      [{ verificationError: new AccountAssertionDenied('Invalid credentials') }, 401, 0],
      [{ verificationError: new AccountAssertionUnavailable('Account unavailable') }, 503, 0],
      [{ authorityError: new AdmissionUnavailable('Access unavailable') }, 503, 1],
    ] as const) {
      const f = fixture(input);
      const response = await f.read(endpoint);
      expect(response.status).toBe(status);
      expect(f.probes).toEqual({ authentication: 1, authority, graph: 0 });
    }
  });
}
