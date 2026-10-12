import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { ContentCore, ExactReadResult } from '../../content/src/core.ts';
import type { AccessAdmissionRegistry, VerifiedPrincipal } from '../src/modules/access/admission.ts';
import { capturePublishedHomeEvidence, governanceContentEvidenceReader, governanceNoticeParticipants } from '../src/modules/governance/composition.ts';
import { publicReportOwners } from '../src/modules/public-report/owners.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { ownerEvidenceCapture } from '../src/modules/governance/evidence.ts';
import { GovernanceDenied, GovernanceUnavailable } from '../src/modules/governance/store.ts';
import { RV, prepareComponent } from '../src/modules/work/activate.ts';
import { zoneHomeTargetFixture, zoneHomeTargetCell as cell } from './support/zone-home-target.ts';

import { ZONE_CONFIG_FORMAT, ZONE_LIMITS, ZONE_PROFILE } from '../src/modules/zone/config-format.ts';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

const principal = { issuer: 'account', subject: 'legacy-reader', emailVerified: true } as VerifiedPrincipal;
const actor = `https://rezics.com/id/${randomUUID()}`;

function legacyEvidence() {
  const h = zoneHomeTargetFixture(), revision = randomUUID(), variant = `urn:rezics:variant:${randomUUID()}`;
  let published = true, editGrant = false;
  const navigation = `https://rezics.com/id/${randomUUID()}`;
  const objectDirectory = mkdtempSync(join(resolve(import.meta.dir, '../../../.temp'), 'zone-legacy-evidence-'));
  directories.push(objectDirectory);
  const manifest = prepareComponent(objectDirectory, h.zone, { configuration: {
    format: ZONE_CONFIG_FORMAT, zone: h.zone, space: h.space, navigation, homeDocument: h.resource,
    state: 'active', disclosure: 'public', model: ZONE_PROFILE,
    budget: { timeMs: ZONE_LIMITS.queryBudgetMs, rows: ZONE_LIMITS.queryBudgetRows }, queryBlocks: [],
  } }, ZONE_PROFILE);
  h.env.objectDirectory = objectDirectory;
  const queries: string[] = [], semanticTargets: string[] = [], workTargets: string[] = [];
  const legacyRows: Array<{ legacySpace?: ReturnType<typeof cell> }> = [{ legacySpace: cell(h.space) }];
  const query = h.env.fuseki.query.bind(h.env.fuseki);
  h.env.fuseki.query = async text => {
    queries.push(text);
    if (text.includes('SELECT ?space ?navigation ?head')) return { results: { bindings: [{
      space: cell(h.space), navigation: cell(navigation), head: cell(h.siteRevision),
      manifest: cell(`urn:rezics:sha256:${manifest}`), state: cell(`${RV}Active`),
      spaceDisclosure: h.visibilityRows[0]!.disclosure!, homeDocument: cell(h.resource),
      homeRevision: cell(h.revision), publication: cell(h.siteRevision),
    }] } };
    if (text.includes('ASK') && text.includes('rv:sitePublicationRevision')) {
      return { boolean: published && text.includes(`urn:rezics:content:revision:${revision}`) };
    }
    if (text.includes('SELECT ?admission ?receipt ?digest')) return { results: { bindings: [{
      admission: cell(randomUUID()), receipt: cell(`urn:rezics:receipt:${'a'.repeat(64)}`), digest: cell('b'.repeat(64)),
    }] } };
    if (text.includes('SELECT DISTINCT ?zone ?head ?typed') && text.includes(`<${h.zone}>`)) {
      return { results: { bindings: [] } };
    }
    if (text.includes('SELECT ?legacySpace')) return { results: { bindings: legacyRows } };
    if (text.includes('SELECT ?epoch ?sequence')) return { results: { bindings: [{ epoch: cell(h.env.lineage.dataEpoch), sequence: cell('9') }] } };
    if (text.includes('SELECT DISTINCT ?author')) return { results: { bindings: [{ author: cell(h.author) }] } };
    return query(text);
  };
  let zoneGrant = false, workGrant = false, realmGrant = false;
  const registry = {
    assertRecoveryOpen: async () => {},
    activePrincipalId: async () => editGrant ? randomUUID() : null,
    withOwnerAuthority: async (_request: unknown, operation: (client: PoolClient) => Promise<unknown>) =>
      operation({ query: async () => ({ rowCount: 1, rows: [{ id: randomUUID() }] }) } as unknown as PoolClient),
    realmReadProof: async () => realmGrant ? randomUUID() : null,
    canReadSemanticResource: async (_principal: VerifiedPrincipal | null, _actor: string | null, resource: string) => {
      semanticTargets.push(resource); return zoneGrant && resource === h.zone;
    },
    canReadWork: async (_principal: VerifiedPrincipal | null, _actor: string | null, resource: string) => {
      workTargets.push(resource); return workGrant;
    },
  } as Pick<AccessAdmissionRegistry, 'realmReadProof' | 'canReadSemanticResource' | 'canReadWork' | 'activePrincipalId' | 'withOwnerAuthority'>;
  const pool = { query: async () => { throw new Error('Zone Content cannot use media authority'); } } as unknown as Pool;
  const selected: ExactReadResult = { status: 'available', revisionId: revision, serializedJson: '{}', body: {},
    reference: { owner: 'content', resourceId: h.zone, variantId: variant, revisionId: revision,
      byteDigest: 'a'.repeat(64), byteLength: 2, model: 'zone-page-v1', format: 'rezics-content-json-v1',
      language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr',
      sourceRevision: null, predecessor: null, provenance: {} } };
  const reads: string[][] = [];
  const core = { owningResourceForRevision: async () => h.zone,
    readExactBatch: async (ids, authorize) => {
      const readable = await authorize(ids);
      reads.push(ids);
      return ids.map(id => readable.has(id) ? selected : { revisionId: id, status: 'denied' as const });
    } } as Pick<ContentCore, 'owningResourceForRevision' | 'readExactBatch'>;
  const canRead = governanceContentEvidenceReader(core, pool, registry, h.env);
  const capture = ownerEvidenceCapture({ content: { core, canRead } });
  const target = { owner: 'content' as const, resource: h.zone, component: 'body' as const,
    revision, locator: null };
  return { ...h, legacyRows, queries, semanticTargets, workTargets, reads, target, capture, canRead, core, registry, pool,
    publication: (selected: boolean) => { published = selected; },
    grants: (zone: boolean, work = false, realm = false, edit = false) => { zoneGrant = zone; workGrant = work; realmGrant = realm; editGrant = edit; } };
}

test('retained Z-owned evidence keeps its exact Resource after Z receives a new home document P', async () => {
  const h = legacyEvidence();
  expect(h.ownerRows[0]!.zone!.value).toBe(h.zone);
  expect(h.resource).not.toBe(h.zone);
  expect(await h.capture.capture(principal, actor, h.target)).toMatchObject({
    resource: h.zone, revision: h.target.revision, state: 'available', revisionDigest: 'a'.repeat(64),
  });
  expect(h.workTargets).toEqual([]);
  expect(h.reads).toEqual([[h.target.revision!]]);
});

test('public report and copyright intake admit a retained Z body through the same home evidence owner', async () => {
  for (const category of ['harassment', 'copyright'] as const) {
    const h = legacyEvidence();
    const deps = { environment: h.env, access: h.registry } as unknown as MainWorkDependencies;
    const report = await publicReportOwners(deps, h.pool, h.core as ContentCore).resolve({
      profile: 'public-report-v1', target: `https://rezics.com/v1/content-revisions/${h.target.revision}`,
      category, statement: 'Retained home document needs review', contentLanguage: 'en',
      ...(category === 'copyright' ? { copyright: { signature: 'Rights holder', claimantName: 'Rights holder',
        claimantAddress: 'Address', claimantPhone: 'Phone', claimedWork: 'Original work', materialLocation: 'Retained home',
        goodFaith: true as const, accurateAndAuthorizedUnderPerjury: true as const } } : {}),
    }, new Request('https://rezics.com/v1/public-reports', { method: 'POST' }), null);
    expect(report.evidence).toMatchObject({ owner: 'content', resource: h.zone, revision: h.target.revision,
      state: 'available', revisionDigest: 'a'.repeat(64) });
    expect(h.workTargets).toEqual([]);
  }
});

test('retained Z evidence rechecks its Zone grant after the exact Content read', async () => {
  const h = legacyEvidence();
  h.visibilityRows[0]!.disclosure = cell(`${RV}Private`);
  h.visibilityRows[0]!.zoneDisclosure = cell(`${RV}Private`);
  h.grants(true, false, false, true);
  const read = h.core.readExactBatch.bind(h.core);
  h.core.readExactBatch = async (...args) => { const bytes = await read(...args); h.grants(false); return bytes; };
  await expect(capturePublishedHomeEvidence(h.env, h.core, h.registry, principal, actor, h.target))
    .rejects.toBeInstanceOf(GovernanceDenied);
  expect(h.workTargets).toEqual([]);
});

test('private retained Z-owned evidence uses Zone authority and cannot inherit a Work grant', async () => {
  const h = legacyEvidence();
  h.visibilityRows[0]!.disclosure = cell(`${RV}Private`);
  h.visibilityRows[0]!.zoneDisclosure = cell(`${RV}Private`);
  h.grants(false, true);
  await expect(h.capture.capture(principal, actor, h.target)).rejects.toBeInstanceOf(GovernanceDenied);
  h.grants(true, false, false, true);
  expect(await h.capture.capture(principal, actor, h.target)).toMatchObject({ resource: h.zone, state: 'available' });
  h.grants(false);
  expect(await h.canRead(principal, actor, [h.target.revision!])).toEqual(new Set());
  expect(h.semanticTargets).toEqual([h.zone]);
  expect(h.workTargets).toEqual([]);
});

test('retained Zone evidence preserves the independent private Realm membership authority', async () => {
  const h = legacyEvidence();
  h.visibilityRows[0]!.disclosure = cell(`${RV}Private`);
  h.visibilityRows[0]!.zoneDisclosure = cell(`${RV}Private`);
  h.visibilityRows[0]!.realm = cell(`https://rezics.com/id/${randomUUID()}`);
  h.grants(true, true);
  await expect(h.capture.capture(principal, actor, h.target)).rejects.toBeInstanceOf(GovernanceDenied);
  h.grants(false, false, true, true);
  expect(await h.capture.capture(principal, actor, h.target)).toMatchObject({ state: 'available' });
  expect(h.workTargets).toEqual([]);
});

test('ambiguous legacy Zone ownership is unavailable rather than a Work authority fallback', async () => {
  for (const incomplete of [false, true]) {
    const h = legacyEvidence();
    if (incomplete) delete h.legacyRows[0]!.legacySpace;
    else h.legacyRows.push({ legacySpace: cell(`https://rezics.com/id/${randomUUID()}`) });
    h.grants(true, true);
    await expect(h.capture.capture(principal, actor, h.target)).rejects.toBeInstanceOf(GovernanceUnavailable);
    expect(h.workTargets).toEqual([]);
  }
});

test('retained Zone rights-notice participants come from the owning Space after P is assigned', async () => {
  const h = legacyEvidence();
  const participants = await governanceNoticeParticipants(h.env).participants({ ...h.target,
    scopeKind: 'exact_revision', expectedHead: h.target.revision, effect: 'disclosure' }, null, 10);
  expect(participants).toEqual([h.author]);
  const query = h.queries.find(text => text.includes('SELECT DISTINCT ?author'))!;
  expect(query).toContain(`<${h.space}>`);
  expect(query).not.toContain(`<${h.zone}>`);
  expect(query).not.toContain(`<${h.resource}>`);
});

for (const category of ['harassment', 'copyright'] as const) test(`anonymous ${category} intake refuses an unpublished Z-owned draft in a public Zone`, async () => {
  const h = legacyEvidence();
  h.publication(false);
  const deps = { environment: h.env, access: h.registry } as unknown as MainWorkDependencies;
  await expect(publicReportOwners(deps, h.pool, h.core as ContentCore).resolve({
    profile: 'public-report-v1', target: `https://rezics.com/v1/content-revisions/${h.target.revision}`,
    category, statement: 'Unpublished home draft', contentLanguage: 'en',
    ...(category === 'copyright' ? { copyright: { signature: 'Rights holder', claimantName: 'Rights holder',
      claimantAddress: 'Address', claimantPhone: 'Phone', claimedWork: 'Original work', materialLocation: 'Home draft',
      goodFaith: true as const, accurateAndAuthorizedUnderPerjury: true as const } } : {}),
  }, new Request('https://rezics.com/v1/public-reports', { method: 'POST' }), null)).rejects.toBeInstanceOf(GovernanceDenied);
  expect(h.reads).toEqual([]);
});

test('a public legacy draft needs Zone edit authority, and a Work grant cannot substitute', async () => {
  const h = legacyEvidence();
  h.publication(false);
  h.grants(true, true);
  await expect(capturePublishedHomeEvidence(h.env, h.core, h.registry, principal, actor, h.target))
    .rejects.toBeInstanceOf(GovernanceDenied);
  expect(await h.canRead(principal, actor, [h.target.revision!])).toEqual(new Set());
  h.grants(true, false, false, true);
  expect(await capturePublishedHomeEvidence(h.env, h.core, h.registry, principal, actor, h.target))
    .toMatchObject({ state: 'available', revision: h.target.revision });
  expect(h.workTargets).toEqual([]);
});

for (const authority of ['publication', 'edit'] as const) test(`legacy intake refuses ${authority} revoked during exact custody hydration`, async () => {
  const h = legacyEvidence();
  if (authority === 'edit') { h.publication(false); h.grants(true, false, false, true); }
  const read = h.core.readExactBatch.bind(h.core);
  h.core.readExactBatch = async (...args) => {
    const exact = await read(...args);
    h.publication(false); h.grants(false);
    return exact;
  };
  await expect(capturePublishedHomeEvidence(h.env, h.core, h.registry,
    authority === 'edit' ? principal : null, authority === 'edit' ? actor : undefined, h.target))
    .rejects.toBeInstanceOf(GovernanceDenied);
});


for (const authority of ['zone', 'realm'] as const) for (const path of ['reader', 'capture'] as const) {
  test(`legacy ${path} checks ${authority} read authority after its final publication/edit lookup`, async () => {
    const h = legacyEvidence();
    h.visibilityRows[0]!.disclosure = cell(`${RV}Private`);
    h.visibilityRows[0]!.zoneDisclosure = cell(`${RV}Private`);
    if (authority === 'realm') h.visibilityRows[0]!.realm = cell(`https://rezics.com/id/${randomUUID()}`);
    h.grants(authority === 'zone', false, authority === 'realm', true);
    const lookup = h.registry.withOwnerAuthority.bind(h.registry);
    let editLookups = 0;
    const finalLookup = path === 'reader' ? 1 : 3;
    h.registry.withOwnerAuthority = async (...args) => {
      const allowed = await lookup(...args);
      if (++editLookups === finalLookup) h.grants(false, false, false, true);
      return allowed;
    };
    if (path === 'reader') {
      expect(await h.canRead(principal, actor, [h.target.revision!])).toEqual(new Set());
      expect(h.reads).toEqual([]);
    } else {
      await expect(capturePublishedHomeEvidence(h.env, h.core, h.registry, principal, actor, h.target))
        .rejects.toBeInstanceOf(GovernanceDenied);
      expect(h.reads).toEqual([[h.target.revision!]]);
    }
    expect(editLookups).toBe(finalLookup);
    expect(h.workTargets).toEqual([]);
  });
}
