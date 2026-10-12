import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { ContentCore, ExactReadResult } from '../../content/src/core.ts';
import type { AccessAdmissionRegistry, VerifiedPrincipal } from '../src/modules/access/admission.ts';
import { capturePublishedHomeEvidence, governanceContentEvidenceReader, governanceNoticeParticipants } from '../src/modules/governance/composition.ts';
import { publicReportOwners } from '../src/modules/public-report/owners.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { ownerEvidenceCapture } from '../src/modules/governance/evidence.ts';
import { GovernanceDenied, GovernanceUnavailable } from '../src/modules/governance/store.ts';
import { RV } from '../src/modules/work/activate.ts';
import { zoneHomeTargetFixture, zoneHomeTargetCell as cell } from './support/zone-home-target.ts';

const principal = { issuer: 'account', subject: 'legacy-reader', emailVerified: true } as VerifiedPrincipal;
const actor = `https://rezics.com/id/${randomUUID()}`;

function legacyEvidence() {
  const h = zoneHomeTargetFixture(), revision = randomUUID(), variant = `urn:rezics:variant:${randomUUID()}`;
  const queries: string[] = [], semanticTargets: string[] = [], workTargets: string[] = [];
  const legacyRows: Array<{ legacySpace?: ReturnType<typeof cell> }> = [{ legacySpace: cell(h.space) }];
  const query = h.env.fuseki.query.bind(h.env.fuseki);
  h.env.fuseki.query = async text => {
    queries.push(text);
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
    realmReadProof: async () => realmGrant ? randomUUID() : null,
    canReadSemanticResource: async (_principal: VerifiedPrincipal | null, _actor: string | null, resource: string) => {
      semanticTargets.push(resource); return zoneGrant && resource === h.zone;
    },
    canReadWork: async (_principal: VerifiedPrincipal | null, _actor: string | null, resource: string) => {
      workTargets.push(resource); return workGrant;
    },
  } as Pick<AccessAdmissionRegistry, 'realmReadProof' | 'canReadSemanticResource' | 'canReadWork'>;
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
    grants: (zone: boolean, work = false, realm = false) => { zoneGrant = zone; workGrant = work; realmGrant = realm; } };
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
  h.grants(true);
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
  h.grants(true);
  expect(await h.capture.capture(principal, actor, h.target)).toMatchObject({ resource: h.zone, state: 'available' });
  h.grants(false);
  expect(await h.canRead(principal, actor, [h.target.revision!])).toEqual(new Set());
  expect(h.semanticTargets).toEqual([h.zone, h.zone, h.zone]);
  expect(h.workTargets).toEqual([]);
});

test('retained Zone evidence preserves the independent private Realm membership authority', async () => {
  const h = legacyEvidence();
  h.visibilityRows[0]!.disclosure = cell(`${RV}Private`);
  h.visibilityRows[0]!.zoneDisclosure = cell(`${RV}Private`);
  h.visibilityRows[0]!.realm = cell(`https://rezics.com/id/${randomUUID()}`);
  h.grants(true, true);
  await expect(h.capture.capture(principal, actor, h.target)).rejects.toBeInstanceOf(GovernanceDenied);
  h.grants(false, false, true);
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
