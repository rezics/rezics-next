import { configureFixtureDisclosureAncestry } from './support/disclosure-ancestry.ts';
import { foregroundCounted } from '../../../tests/qa/integration/support/operation-cost.ts';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fromPlainText } from '@rezics/document';
import { readZoneHomeOwner, readZoneHomeTarget } from '../src/modules/zone/home-target.ts';
import { ANONYMOUS_VIEWER } from '../src/modules/suitability/policy.ts';
import { resolveDisclosureSelections } from '../src/modules/disclosure/read.ts';
import { withDisclosureViewer } from '../src/modules/disclosure/viewer.ts';
import { ZoneUnavailable } from '../src/modules/zone/configuration.ts';
import { readZonePublishedHomeContent } from '../src/modules/zone/publication.ts';
import { RV, prepareComponent } from '../src/modules/work/activate.ts';
import { ZONE_CONFIG_FORMAT, ZONE_LIMITS, ZONE_PROFILE } from '../src/modules/zone/config-format.ts';
import { zoneHomeTargetFixture as fixture, zoneHomeTargetId as id, zoneHomeTargetCell as cell,
  configureZoneHomeDisclosure as configureDisclosure } from './support/zone-home-target.ts';

// Trust condition 1: P and H name only the exact retained multilingual publication.
test('native home target returns P, H and exactly the receipt selections in every language', async () => {
  const h = fixture();
  expect(await readZoneHomeTarget(h.env, h.resource)).toEqual({ resource: h.resource,
    revision: h.revision, zone: h.zone, disclosure: 'public', space: h.space, author: h.author,
    realm: null, selections: h.selections });
  const cutQuery = h.queries.find(query => query.includes('SELECT DISTINCT ?receipt'))!;
  expect(cutQuery).toContain(`<${h.revision}> a rv:ZoneHomeRevision, rv:RevisionAnchor`);
  expect(cutQuery).toContain(`rv:component <${h.resource}>`);
  expect(cutQuery).toContain('rv:outcome rv:Succeeded');
  expect(cutQuery).not.toContain('draftHead');
});

for (const ancestry of [true, false]) for (const authority of ['zone', 'realm'] as const) {
  // The disclosure final fence still awaits the owner's production ancestry source.
  (ancestry ? test : test.failing)(`home target withholds ids and digests when ${authority} authority is revoked during the receipt read (${ancestry ? 'owner cut' : 'production ancestry pending'})`, async () => {
    const h = fixture({ ancestry }), realm = id();
    h.visibilityRows[0]!.disclosure = cell(`${RV}Private`);
    h.visibilityRows[0]!.zoneDisclosure = cell(`${RV}Private`);
    if (authority === 'realm') h.visibilityRows[0]!.realm = cell(realm);
    let readable = true;
    const query = h.env.fuseki.query.bind(h.env.fuseki);
    h.env.fuseki.query = async (text, budget) => {
      const result = await query(text, budget);
      if (text.includes('SELECT ?zone ?revision ?routesRevision')) readable = false;
      return result;
    };
    if (!ancestry) {
      const selections = await resolveDisclosureSelections(h.env, [{ owner: 'graph', resource: h.resource,
        revision: h.revision, component: 'record' }]);
      const ancestry = selections[0]!.ancestry;
      expect('relationshipBasis' in ancestry ? ancestry.relationshipBasis.kind : undefined).toBe('publication');
    }
    expect(await readZoneHomeTarget(h.env, h.resource, h.revision, {
      zoneReadable: async () => readable,
      realmReadProof: async () => readable ? 'membership' : null,
    })).toBeNull();
  });
}

test('a retained historical H stays fixed when P advances to another home cut', async () => {
  const h = fixture(), next = id();
  h.ownerRows[0]!.head = cell(next);
  const exact = await readZoneHomeTarget(h.env, h.resource, h.revision);
  expect(exact?.revision).toBe(h.revision);
  expect(exact?.selections).toEqual(h.selections);
  expect(h.queries.find(query => query.includes('SELECT DISTINCT ?receipt'))).toContain(`<${h.revision}>`);
  h.cutRows.length = 0;
  expect(await readZoneHomeTarget(h.env, h.resource, next)).toBeNull();
});

test('unpublished reservations remain home-owned but never become reportable draft targets', async () => {
  const h = fixture();
  h.ownerRows[0]!.typed = cell('false');
  delete h.ownerRows[0]!.head;
  expect(await readZoneHomeOwner(h.env, h.resource)).toBe(h.zone);
  expect(await readZoneHomeTarget(h.env, h.resource)).toBeNull();
  expect(await readZoneHomeTarget(h.env, h.resource, id())).toBeNull();
  expect(h.policyTargets).toHaveLength(0);
});

test('orphan, multiple-owner and self-owned homes refuse generic Resource fallback', async () => {
  for (const corruption of ['orphan', 'multiple', 'self'] as const) {
    const h = fixture();
    if (corruption === 'orphan') delete h.ownerRows[0]!.zone;
    if (corruption === 'multiple') h.ownerRows.push({ ...h.ownerRows[0], zone: cell(id()) });
    if (corruption === 'self') h.ownerRows[0]!.zone = cell(h.resource);
    await expect(readZoneHomeOwner(h.env, h.resource)).rejects.toBeInstanceOf(ZoneUnavailable);
  }
});

test('missing native publication, erased cut and forged site association are unavailable', async () => {
  for (const corruption of ['missing', 'erased', 'foreign-site', 'foreign-cut'] as const) {
    const h = fixture();
    if (corruption === 'missing' || corruption === 'erased') h.cutRows.length = 0;
    if (corruption === 'foreign-site') h.cutRows[0]!.siteRevision = cell(id());
    if (corruption === 'foreign-cut') for (const row of h.rows) row.homeRevision = cell(id());
    if (corruption === 'foreign-cut') {
      await expect(readZoneHomeTarget(h.env, h.resource)).rejects.toBeInstanceOf(ZoneUnavailable);
    } else expect(await readZoneHomeTarget(h.env, h.resource)).toBeNull();
  }
});

test('receipt corruption cannot disclose a variant or digest outside exact H', async () => {
  for (const field of ['byteDigest', 'page', 'count'] as const) {
    const h = fixture();
    h.rows[0]![field] = cell(field === 'page' ? id() : 'wrong');
    await expect(readZoneHomeTarget(h.env, h.resource)).rejects.toBeInstanceOf(ZoneUnavailable);
  }
});

// Trust condition 3: live owning-Zone read authority precedes home disclosure.
test('a private Zone-only home needs Zone read authority and private Realm homes need membership', async () => {
  const h = fixture();
  h.visibilityRows[0]!.disclosure = cell(`${RV}Private`);
  h.visibilityRows[0]!.zoneDisclosure = cell(`${RV}Private`);
  expect(await readZoneHomeTarget(h.env, h.resource)).toBeNull();
  expect(h.policyTargets).toHaveLength(0);
  const zones: string[] = [];
  expect((await readZoneHomeTarget(h.env, h.resource, undefined, {
    zoneReadable: async zone => { zones.push(zone); return zone === h.zone; },
  }))?.disclosure).toBe('restricted');
  expect(zones).toEqual([h.zone, h.zone, h.zone]);
  const realm = id();
  h.visibilityRows[0]!.realm = cell(realm);
  expect(await readZoneHomeTarget(h.env, h.resource, undefined, { zoneReadable: async () => true })).toBeNull();
  expect((await readZoneHomeTarget(h.env, h.resource, undefined, {
    realmReadProof: async target => target === realm ? 'owner-proof' : null,
  }))?.realm).toBe(realm);
});

// Trust condition 2: P or exact H restrictions hide only the document, including for its own readers.
test('document restrictions address P and exact H and restoration changes only that document', async () => {
  const h = fixture();
  h.deny(true);
  for (const viewer of [ANONYMOUS_VIEWER, { ...ANONYMOUS_VIEWER, signedIn: true }]) {
    expect(await readZoneHomeTarget(h.env, h.resource, h.revision, {}, viewer)).toBeNull();
  }
  expect(h.policyTargets.map(targets => targets.filter(target => target.owner === 'graph'))).toEqual(Array.from({ length: 4 }, () =>
    [{ owner: 'graph', resource: h.resource, revision: h.revision, component: 'record' }]));
  h.deny(false);
  expect((await readZoneHomeTarget(h.env, h.resource))?.revision).toBe(h.revision);
  expect(h.rows[0]!.navigationRevision).toBeDefined();
});

test('restricted and erased homes return absent before Content reads while the site bundle keeps serving', async () => {
  const h = fixture();
  const navigationRevision = h.rows[0]!.navigationRevision!.value;
  const bundle = { homeDocument: h.resource, homeRevision: h.revision, navigationRevision,
    pages: h.selections.map(selection => ({ page: h.resource, ...selection })) };
  const state = { zone: h.zone, disclosure: 'public', bundle,
    cost: { graphReads: 4, objectReads: 4 } } as unknown as Parameters<typeof readZonePublishedHomeContent>[1];
  const originalCost = { ...state.cost };
  let contentReads = 0;
  const work = { environment: h.env, content: { readExactBatch: async () => { contentReads++; return []; } } } as unknown as
    Parameters<typeof readZonePublishedHomeContent>[0];
  h.deny(true);
  for (const viewer of [ANONYMOUS_VIEWER, { ...ANONYMOUS_VIEWER, signedIn: true }]) {
    await withDisclosureViewer(viewer, async () => {
      for (const language of ['en', 'fr']) expect(await readZonePublishedHomeContent(work, state, [language])).toBeNull();
    });
  }
  expect(h.policyTargets).toHaveLength(4);
  h.deny(false);
  state.bundle!.homeErased = true;
  expect(await readZonePublishedHomeContent(work, state, ['fr'])).toBeNull();
  expect(contentReads).toBe(0);
  expect(h.policyTargets).toHaveLength(4);
  expect(state.bundle!.navigationRevision).toBe(navigationRevision);
  expect(state.bundle!.pages).toHaveLength(2);
  expect(state.cost).toEqual(originalCost);
});


for (const lateTarget of ['graph', 'content'] as const) test(`a ${lateTarget} restriction after body hydration refuses delivery at the final home fence`, async () => {
  const h = fixture(), page = h.selections[0]!, navigation = id();
  const objectDirectory = mkdtempSync(join(resolve(import.meta.dir, '../../../.temp'), 'zone-home-read-owner-'));
  const manifest = prepareComponent(objectDirectory, h.zone, { configuration: {
    format: ZONE_CONFIG_FORMAT, zone: h.zone, space: h.space, navigation, homeDocument: h.resource,
    state: 'active', disclosure: 'public', model: ZONE_PROFILE,
    budget: { timeMs: ZONE_LIMITS.queryBudgetMs, rows: ZONE_LIMITS.queryBudgetRows }, queryBlocks: [],
  } }, ZONE_PROFILE);
  h.env.objectDirectory = objectDirectory;
  const originalQuery = h.env.fuseki.query.bind(h.env.fuseki);
  h.env.fuseki.query = async (query, budget) => {
    if (query.includes('SELECT ?space ?navigation ?head')) {
      if (foregroundCounted()) h.queries.push(query);
      return { results: { bindings: [{ space: cell(h.space), navigation: cell(navigation),
        head: cell(h.siteRevision), manifest: cell(`urn:rezics:sha256:${manifest}`),
        state: cell(`${RV}Active`), spaceDisclosure: cell(`${RV}Public`),
        homeDocument: cell(h.resource), homeRevision: cell(h.revision), publication: cell(h.siteRevision) }] } };
    }
    return originalQuery(query, budget);
  };
  let restricted = false, contentReads = 0;
  configureDisclosure(h.env, { read: async targets => targets.map(target =>
    restricted && target.owner === lateTarget ? 'hidden' : 'visible') });
  const state = { zone: h.zone, disclosure: 'public', bundle: { homeDocument: h.resource,
    homeRevision: h.revision, pages: h.selections.map(selection => ({ page: h.resource, ...selection })) } } as unknown as
    Parameters<typeof readZonePublishedHomeContent>[1];
  const work = { environment: h.env, content: { readExactBatch: async () => {
    contentReads++; if (lateTarget === 'graph') restricted = true;
    return [{ revisionId: page.revisionId, status: 'available', reference: { resourceId: h.resource, ...page },
      body: { document: fromPlainText('Home', 'blocks') } }];
  } }, ...(lateTarget === 'content' ? { contentAuthoring: { readExactMetadataBatch: async () => {
    restricted = true;
    return new Map([[page.revisionId, { availability: 'available', byteDigest: page.byteDigest }]]);
  } } } : {}) } as unknown as Parameters<typeof readZonePublishedHomeContent>[0];
  try {
    expect(await readZonePublishedHomeContent(work, state, ['en'])).toBeNull();
    expect(contentReads).toBe(1);
    expect(h.queries.filter(query => query.includes('SELECT ?space ?navigation ?head'))).toHaveLength(2);
    expect(h.queries.filter(query => query.includes('ASK') && query.includes('rv:sitePublicationRevision'))).toHaveLength(2);
  } finally { rmSync(objectDirectory, { recursive: true, force: true }); }
});


for (const authority of ['zone', 'realm'] as const) test(`owner-cut home target withholds H, selections and digests when ${authority} authority is revoked during final ancestry reread`, async () => {
  const h = fixture();
  h.visibilityRows[0]!.disclosure = cell(`${RV}Private`);
  h.visibilityRows[0]!.zoneDisclosure = cell(`${RV}Private`);
  if (authority === 'realm') h.visibilityRows[0]!.realm = cell(id());
  let readable = true, rereads = 0, authorityReads = 0;
  configureFixtureDisclosureAncestry(h.env, () => undefined, owner => {
    if (owner === 'graph' && ++rereads === 2) {
      expect(authorityReads).toBe(2);
      readable = false;
    }
  });
  const result = await readZoneHomeTarget(h.env, h.resource, h.revision, {
    zoneReadable: async () => { authorityReads++; return readable; },
    realmReadProof: async () => { authorityReads++; return readable ? 'membership' : null; },
  });
  expect(rereads).toBe(2);
  expect(authorityReads).toBe(3);
  expect(result).toBeNull();
});
