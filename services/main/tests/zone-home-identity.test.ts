import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { ContentCore, PublicationPreparation } from '../../content/src/core.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { contentTargetGuard, ContentDraftUnavailable, resolveContentTarget } from '../src/modules/content-publication/draft.ts';
import { ContentPublicationConflict, settleZonePageContentPublication } from '../src/modules/content-publication/publish.ts';
import { compositionReceiptIri } from '../src/modules/structure/change.ts';
import { readZoneSitePublicationReceipt, ZoneUnavailable } from '../src/modules/zone/configuration.ts';
import { zonePublishedPageBinding } from '../src/modules/zone/config-format.ts';
import { RESERVED_OWNER_PREDICATES, RESERVED_OWNER_TYPES } from '../src/modules/semantic/schema.ts';
import { readZonePublishedHomeContent } from '../src/modules/zone/publication.ts';
import { Value } from 'typebox/value';
import { shapeSchemas } from '../../../packages/model/src/generated/schemas.ts';
import { withPreservationFence } from '../src/modules/public-report/preservation.ts';
import { withAccessClient } from '../src/modules/access/topology-control.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
const homeType = 'https://rezics.com/vocab/ZoneHomeDocument';
const zoneType = 'https://rezics.com/vocab/Zone';
const cell = (value: string) => ({ value });

test('a preservation fence shares its Access checkout and releases it before subsequent owner work', async () => {
  let active = false, connections = 0, transaction = false, transactionId = 0;
  const statements: string[] = [];
  const pool = { connect: async () => {
    if (active) throw new Error('nested Access checkout');
    active = true; connections++;
    return { query: async (sql: string) => {
      statements.push(sql);
      if (sql === 'BEGIN') { transaction = true; transactionId++; }
      if (sql === 'COMMIT' || sql === 'ROLLBACK') transaction = false;
      if (sql.includes('txid_current')) return { rows: [{ id: String(transaction ? transactionId : ++transactionId) }] };
      if (sql.includes('access.recovery_fence')) return { rows: [{ open: true }] };
      return { rows: [], rowCount: 0 };
    },
      release: () => { active = false; } };
  } } as unknown as Pool;
  const page = id();
  expect(await withPreservationFence(pool, page, randomUUID(), fence =>
    withAccessClient(pool, async client => {
      expect(fence.resource).toBe(page);
      await client.query('SELECT 1');
      return 'erased';
    }))).toEqual({ held: false, value: 'erased' });
  expect(connections).toBe(1);
  expect(active).toBe(false);
  await withAccessClient(pool, async client => { await client.query('SELECT 2'); });
  expect(connections).toBe(2);
  expect(active).toBe(false);
  expect(statements.filter(sql => sql === 'BEGIN' || sql === 'COMMIT')).toEqual(['BEGIN', 'COMMIT']);
  await withAccessClient(pool, async client => {
    await withPreservationFence(pool, page, randomUUID(), () => withAccessClient(pool, async shared => {
      expect(shared).toBe(client);
      expect(active).toBe(true);
      expect(transaction).toBe(true);
    }));
    expect(active).toBe(true);
    expect(transaction).toBe(false);
  });
  expect(connections).toBe(3);
  expect(active).toBe(false);
  expect(statements.filter(sql => sql === 'BEGIN' || sql === 'COMMIT')).toEqual(['BEGIN', 'COMMIT', 'BEGIN', 'COMMIT']);
  await withAccessClient(pool, async client => {
    await client.query('BEGIN');
    await withPreservationFence(pool, page, randomUUID(), async () => { expect(transaction).toBe(true); });
    expect(transaction).toBe(true);
    await client.query('COMMIT');
  });
  expect(connections).toBe(4);
  expect(statements.filter(sql => sql === 'BEGIN' || sql === 'COMMIT')).toEqual([
    'BEGIN', 'COMMIT', 'BEGIN', 'COMMIT', 'BEGIN', 'COMMIT',
  ]);
});

function environment(rows: Record<string, { value: string } | undefined>[]) {
  const queries: string[] = [];
  const env = {
    lineage: { dataEpoch: randomUUID(), routingEpoch: randomUUID() },
    fuseki: { query: async (query: string) => {
      queries.push(query);
      return { results: { bindings: rows } };
    } },
  } as unknown as WorkActivationEnvironment;
  return { env, queries };
}

test('home Content authority resolves one server-owned Zone, including a reserved unpublished document', async () => {
  const zone = id(), page = id();
  const h = environment([{ type: cell(homeType), zone: cell(zone) }]);
  expect(await resolveContentTarget(h.env, page)).toEqual({ type: homeType, zone });
  expect(h.queries[0]).toContain(`rv:homeDocument <${page}>`);
  expect(h.queries[0]).toContain('rv:zoneState rv:Active');
  const guard = contentTargetGuard(page, { type: homeType, zone });
  expect(guard).toContain(`<${zone}> a <${zoneType}>`);
  expect(guard).toContain(`<https://rezics.com/vocab/homeDocument> <${page}>`);
  expect(guard).toContain('?otherZone');
  expect(guard).not.toContain(`<${page}> a <https://schema.org/CreativeWork>`);
});

test('missing, foreign, ambiguous and self-owned home targets cannot fall through to Work authority', async () => {
  const page = id(), zone = id();
  for (const rows of [[], [{ type: cell(homeType) }],
    [{ type: cell(homeType), zone: cell(zone) }, { type: cell(homeType), zone: cell(id()) }],
    [{ type: cell(homeType), zone: cell(zone) }, { type: cell('https://schema.org/CreativeWork') }],
    [{ type: cell(homeType), zone: cell(page) }]]) {
    await expect(resolveContentTarget(environment(rows).env, page)).rejects.toBeInstanceOf(ContentDraftUnavailable);
  }
  expect(() => contentTargetGuard(page, { type: homeType, zone: null })).toThrow(ContentDraftUnavailable);
  expect(() => contentTargetGuard(page, { type: homeType, zone: page })).toThrow(ContentDraftUnavailable);
});

test('legacy Zone-owned Content retains its original resolution without rewriting its Resource', async () => {
  const zone = id();
  expect(await resolveContentTarget(environment([{ type: cell(zoneType) }]).env, zone))
    .toEqual({ type: zoneType, zone });
  expect(RESERVED_OWNER_TYPES.has(homeType)).toBe(true);
  for (const term of ['homeDocument', 'homeDocumentHead', 'ZoneHomeRevision']) {
    expect(term === 'ZoneHomeRevision'
      ? RESERVED_OWNER_TYPES.has(`https://rezics.com/vocab/${term}`)
      : RESERVED_OWNER_PREDICATES.has(`https://rezics.com/vocab/${term}`)).toBe(true);
  }
});

test('legacy Z remains readable but its draft target is read-only once P is allocated', async () => {
  const zone = id(), page = id();
  const target = await resolveContentTarget(environment([{ type: cell(zoneType), allocatedHomeDocument: cell(page) }]).env, zone);
  expect(target).toEqual({ type: zoneType, zone, readOnly: true });
  expect(contentTargetGuard(zone, target)).toContain('homeDocument> ?allocatedHomeDocument');
});

function publicationProof(legacy = false) {
  const zone = id(), page = legacy ? zone : id(), homeRevision = id(), revision = id();
  const admissionId = randomUUID(), contentRevision = randomUUID();
  const receipt = compositionReceiptIri(admissionId, 'zone.edit');
  const variant = `urn:rezics:variant:${randomUUID()}`, digest = 'a'.repeat(64);
  const h = environment([]);
  const fields = { zone, revision, routesRevision: id(), navigationRevision: id(), themeRevision: id(),
    count: '1', admissionId, digest: 'b'.repeat(64), authorityEpoch: '1', scope: `zone:edit:${zone}`,
    dataEpoch: h.env.lineage.dataEpoch, sequence: '9',
    binding: zonePublishedPageBinding(revision, page, contentRevision), page, variant,
    contentRevision: `urn:rezics:content:revision:${contentRevision}`, byteDigest: digest,
    ...(legacy ? {} : { homeDocument: page, homeRevision }) };
  const row = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, cell(value)]));
  const queries: string[] = [];
  h.env.fuseki = { query: async (query: string) => {
    queries.push(query);
    return { results: { bindings: [row] } };
  } } as unknown as WorkActivationEnvironment['fuseki'];
  const preparation = { operationId: `pin:${randomUUID()}`, reference: {
    resourceId: page, variantId: variant, revisionId: contentRevision, byteDigest: digest,
  }, position: { owner: 'content', dataEpoch: randomUUID(), sequence: '3' },
  status: 'pending', pinActive: true, replayed: false } as PublicationPreparation;
  const settlements: unknown[][] = [];
  const content = { readPublicationPreparation: async () => preparation,
    ownerPosition: async () => preparation.position,
    settlePublication: async (...args: unknown[]) => { settlements.push(args); return { replayed: false }; },
  } as unknown as ContentCore;
  return { ...h, queries, row, fields, preparation, receipt, content, settlements };
}

test('site settlement selects the document exact bytes while retaining Zone authority', async () => {
  const h = publicationProof();
  const bundle = await readZoneSitePublicationReceipt(h.env, h.receipt);
  expect(bundle).toMatchObject({ zone: h.fields.zone, homeDocument: h.fields.page,
    homeRevision: h.fields.homeRevision, pages: [{ page: h.fields.page,
      revisionId: h.preparation.reference.revisionId, byteDigest: h.fields.byteDigest }] });
  expect(h.fields.zone).not.toBe(h.preparation.reference.resourceId);
  await settleZonePageContentPublication(h.env, h.content, h.preparation.operationId, h.receipt);
  expect(h.settlements).toHaveLength(1);
  expect(h.queries[0]).toContain('rv:publishedPage ?binding');
  expect(h.queries[0]).toContain('rv:contentRevision ?contentRevision ; rv:byteDigest ?byteDigest');
});

test('legacy retained site receipts still select their original exact Zone-owned bytes', async () => {
  const h = publicationProof(true);
  const bundle = await readZoneSitePublicationReceipt(h.env, h.receipt);
  expect(bundle?.homeDocument).toBeUndefined();
  await settleZonePageContentPublication(h.env, h.content, h.preparation.operationId, h.receipt);
  expect(h.settlements).toHaveLength(1);
});

test('wrong digest, variant and document cannot settle a retained custody pin', async () => {
  for (const field of ['byteDigest', 'variantId', 'resourceId'] as const) {
    const h = publicationProof();
    h.preparation.reference[field] = field === 'byteDigest' ? 'c'.repeat(64)
      : field === 'variantId' ? `urn:rezics:variant:${randomUUID()}` : id();
    await expect(settleZonePageContentPublication(h.env, h.content, h.preparation.operationId, h.receipt))
      .rejects.toBeInstanceOf(ContentPublicationConflict);
    expect(h.settlements).toHaveLength(0);
  }
});

test('receipt home identity is paired and cannot select a foreign document', async () => {
  for (const mismatch of ['missing-anchor', 'foreign-page', 'malformed-digest'] as const) {
    const h = publicationProof();
    if (mismatch === 'missing-anchor') delete h.row.homeRevision;
    if (mismatch === 'foreign-page') h.row.homeDocument = cell(id());
    if (mismatch === 'malformed-digest') h.row.byteDigest = cell('wrong');
    await expect(readZoneSitePublicationReceipt(h.env, h.receipt)).rejects.toBeInstanceOf(ZoneUnavailable);
  }
});

test('an erased document cut retains the site bundle and returns an absent home in every language', async () => {
  const h = publicationProof();
  h.row.homeErased = cell('true');
  for (const field of ['binding', 'page', 'variant', 'contentRevision', 'byteDigest']) delete h.row[field];
  const bundle = await readZoneSitePublicationReceipt(h.env, h.receipt, true);
  expect(bundle).toMatchObject({ homeErased: true, pages: [], routesRevision: h.fields.routesRevision,
    navigationRevision: h.fields.navigationRevision, themeRevision: h.fields.themeRevision });
  const state = { bundle, disclosure: 'public' } as Parameters<typeof readZonePublishedHomeContent>[1];
  for (const language of ['en', 'fr']) {
    expect(await readZonePublishedHomeContent({ environment: h.env }, state, [language])).toBeNull();
  }
  expect(h.settlements).toHaveLength(0);
});

test('home publication shapes keep one head and bounded exact revision selections', () => {
  const prefix = 'https://rezics.com/definition/zone-capability-v1/';
  const document = { '@id': id(), 'rdf:type': [homeType], 'rv:homeDocumentHead': [id()] };
  expect(Value.Check(shapeSchemas[`${prefix}home-document-shape`], document)).toBe(true);
  expect(Value.Check(shapeSchemas[`${prefix}home-document-shape`], { ...document,
    'rv:homeDocumentHead': [id(), id()] })).toBe(false);
  const anchor = { '@id': id(), 'rdf:type': ['https://rezics.com/vocab/ZoneHomeRevision',
    'https://rezics.com/vocab/RevisionAnchor'], 'rv:component': [document['@id']],
    'rv:publishedPage': ['urn:rezics:binding:test'], 'rv:publishedPageCount': [1],
    'rv:manifest': [`urn:rezics:sha256:${'b'.repeat(64)}`],
    'rv:operation': [id()], 'rv:modelRevision': [prefix.slice(0, -1)], 'rv:shapeRevision': [prefix.slice(0, -1)],
    'rv:datasetId': ['urn:rezics:dataset:product'], 'rv:dataEpoch': [randomUUID()], 'rv:sequence': [1] };
  expect(Value.Check(shapeSchemas[`${prefix}home-revision-shape`], anchor)).toBe(true);
  expect(Value.Check(shapeSchemas[`${prefix}home-revision-shape`], { ...anchor,
    'rv:publishedPage': Array.from({ length: 33 }, () => `urn:rezics:binding:${randomUUID()}`) })).toBe(false);
});
