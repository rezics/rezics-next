import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { fromPlainText } from '@rezics/document';
import type { ExactReadResult } from '../../content/src/core.ts';
import type { ImmutableObjects } from '../src/infrastructure/immutable-objects.ts';
import type { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { prepareWorkComponent, RV } from '../src/modules/work/activate.ts';
import { ZONE_CONFIG_FORMAT, ZONE_PROFILE } from '../src/modules/zone/config-format.ts';
import { DEFAULT_ZONE_PRESENTATION, ZONE_PRESENTATION_PROFILE } from '../src/modules/zone/presentation-format.ts';
import { STRUCTURE_MANIFEST_FORMAT, STRUCTURE_PAGE_FORMAT, STRUCTURE_PROFILE,
  type StructureManifest } from '../src/modules/structure/format.ts';
import { orderTree, recordTree } from '../src/modules/structure/change.ts';
import { newCost } from '../src/modules/structure/tree.ts';
import { configureDisclosure } from '../src/modules/disclosure/read.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { zoneRoutes } from '../src/routes/zones.ts';
import { configureFixtureDisclosureAncestry, fixtureDisclosureReader } from './support/disclosure-ancestry.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
const row = (values: Record<string, string>) => Object.fromEntries(Object.entries(values)
  .map(([key, value]) => [key, { type: 'literal' as const, value }]));

async function savedHome(moveDuringRead = false) {
  const zone = id(), homeDocument = id(), actor = id(), space = id(), navigation = id();
  const revision = id(), navRevision = id(), generation = id();
  const variantId = `urn:rezics:variant:${randomUUID()}`, contentRevision = randomUUID();
  const replacementRevision = randomUUID(), admissionId = randomUUID();
  const stored = new Map<string, Uint8Array>();
  const objects: ImmutableObjects = {
    put: async bytes => {
      const digest = createHash('sha256').update(bytes).digest('hex');
      stored.set(digest, bytes); return digest;
    },
    get: async digest => {
      const bytes = stored.get(digest);
      if (!bytes) throw new Error('Missing object');
      return bytes;
    },
  };
  const configuration = { format: ZONE_CONFIG_FORMAT, zone, homeDocument, space, navigation,
    state: 'active' as const, disclosure: 'public' as const, presentation: DEFAULT_ZONE_PRESENTATION,
    budget: { timeMs: 2000, rows: 1000 }, queryBlocks: [], model: ZONE_PROFILE };
  const manifest = `urn:rezics:sha256:${await prepareWorkComponent(objects, zone,
    { configuration, name: 'Saved home', language: 'en' }, ZONE_PROFILE)}`;
  const cost = newCost();
  const navManifest: StructureManifest = { format: STRUCTURE_MANIFEST_FORMAT, structure: navigation,
    structureOf: zone, profile: 'zone-navigation', generation, pageFormat: STRUCTURE_PAGE_FORMAT,
    records: await recordTree(objects).empty(cost), order: await orderTree(objects).empty(cost),
    placementCount: 0, measures: [], model: STRUCTURE_PROFILE, shape: STRUCTURE_PROFILE };
  const navDigest = `urn:rezics:sha256:${await objects.put(new TextEncoder().encode(JSON.stringify(navManifest)))}`;
  const document = fromPlainText('Private saved home draft', 'blocks');
  const body = { document }, serializedJson = JSON.stringify(body);
  const exact: ExactReadResult = { status: 'available', revisionId: contentRevision, body, serializedJson,
    reference: { owner: 'content', resourceId: homeDocument, variantId, revisionId: contentRevision,
      format: 'rezics-content-json-v1', model: 'content-shape-v1',
      byteDigest: createHash('sha256').update(serializedJson).digest('hex'), byteLength: Buffer.byteLength(serializedJson),
      direction: 'ltr', language: { kind: 'tag', tag: 'en', originalTag: 'en' },
      sourceRevision: null, predecessor: null, provenance: {} } };
  const headReads: Array<{ resource: string; variant: string }> = [];
  const variantReads: string[] = [];
  const unexpectedQueries: string[] = [];
  let hydrated = false;
  const fuseki = { query: async (query: string) => {
    if (query.includes('ASK')) return { boolean: true };
    if (query.includes('SELECT ?admission ?receipt ?digest')) return { results: { bindings: [row({
      admission: admissionId, receipt: `urn:rezics:receipt:${'b'.repeat(64)}`, digest: 'a'.repeat(64),
    })] } };
    if (query.includes('SELECT ?creation')) return { results: { bindings: [row({ creation: revision })] } };
    if (query.includes('SELECT ?space ?navigation ?head')) return { results: { bindings: [row({
      space, navigation, head: revision, manifest, homeDocument, state: RV + 'Active',
      spaceDisclosure: RV + 'Public', presentation: ZONE_PRESENTATION_PROFILE,
    })] } };
    if (query.includes('SELECT ?component ?profile')) return { results: { bindings: [row({
      component: zone, profile: RV + 'ZoneNavigation', head: navRevision, generation, count: '0', manifest: navDigest,
    })] } };
    if (query.includes('SELECT ?owner')) return { results: { bindings: [row({ owner: zone })] } };
    if (query.includes('SELECT ?manifest ?predecessor') || query.includes('SELECT ?manifest ?count')) return { results: { bindings: [row({
      manifest: navDigest, count: '0', epoch: 'epoch', sequence: '1',
    })] } };
    if (query.includes('SELECT ?manifest')) return { results: { bindings: [row({ manifest })] } };
    if (query.includes('SELECT ?target') && query.includes('rv:ErasedRevision')) return { results: { bindings: [] } };
    unexpectedQueries.push(query);
    throw new Error(`Unexpected home editor query: ${query.slice(0, 180)}`);
  } } as unknown as FusekiClient;
  const principal = { issuer: 'https://account.local', subject: 'owner', emailVerified: true };
  const position = { owner: 'content', dataEpoch: 'epoch', sequence: '2' };
  const work = { environment: { fuseki, workObjects: objects, structureObjects: objects,
    lineage: { dataEpoch: 'epoch', routingEpoch: '1' } }, structureObjects: objects,
    account: { verify: async () => principal }, access: {
      assertAuthority: async () => {}, activePrincipalId: async () => admissionId,
      withOwnerAuthority: async (_request: unknown, operation: (client: PoolClient) => Promise<unknown>) =>
        operation({ query: async (sql: string) => ({ rows: [],
          rowCount: sql.includes('SELECT a.id FROM access.admission a') ? 1 : 0 }) } as unknown as PoolClient),
      canReadSemanticResource: async () => true,
    }, contentAuthoring: {
      listVariantHeads: async (resource: string) => {
        variantReads.push(resource);
        return { items: [{ id: variantId, languageKind: 'tag', languageTag: 'en', originalLanguageTag: 'en' }] };
      },
      readDraftHead: async (resource: string, variant: string) => {
        headReads.push({ resource, variant });
        if (resource !== homeDocument || variant !== variantId) return null;
        return { revisionId: hydrated && moveDuringRead ? replacementRevision : contentRevision, position };
      },
      readExactBatch: async () => { hydrated = true; return [exact]; },
      ownerPosition: async () => position,
    } } as unknown as MainWorkDependencies;
  configureFixtureDisclosureAncestry(work.environment, () => undefined);
  configureDisclosure(work.environment, fixtureDisclosureReader(async targets => targets.map(() => 'visible')));
  const app = zoneRoutes(fuseki, work);
  return { zone, homeDocument, variantId, contentRevision, document, headReads, variantReads, unexpectedQueries,
    read: () => app.handle(new Request(
      `http://main.local/v1/zones/${zone.slice(-36)}/showcase-editor?actingSubject=${encodeURIComponent(actor)}`,
      { headers: { authorization: 'Bearer owner' } })) };
}

test('unchanged distinct home draft survives the editor consistency fence', async () => {
  const f = await savedHome();
  expect(f.homeDocument).not.toBe(f.zone);
  const response = await f.read();
  const result = await response.json();
  expect(f.unexpectedQueries).toEqual([]);
  expect(response.status, JSON.stringify(result)).toBe(200);
  expect(result.draft).toMatchObject({ variantId: f.variantId, revisionId: f.contentRevision, document: f.document });
  expect(result.preview.page.document).toEqual(f.document);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(f.variantReads).toEqual([f.homeDocument]);
  expect(f.headReads).toEqual(Array.from({ length: 2 }, () => ({ resource: f.homeDocument, variant: f.variantId })));
});

test('a distinct home draft moving during hydration still refuses a mixed editor preview', async () => {
  const f = await savedHome(true);
  const response = await f.read();
  expect(f.unexpectedQueries).toEqual([]);
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: 'zone_route_stale', title: 'Content draft changed' });
  expect(f.headReads).toEqual(Array.from({ length: 2 }, () => ({ resource: f.homeDocument, variant: f.variantId })));
});
