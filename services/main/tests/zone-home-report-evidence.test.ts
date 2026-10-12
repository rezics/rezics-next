import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { uuidToSid } from '@rezics/model/address/sid';
import type { ContentCore, ExactReadResult } from '../../content/src/core.ts';
import type { AccessAdmissionRegistry, VerifiedPrincipal } from '../src/modules/access/admission.ts';
import { captureHomeDocumentEvidence, homeDocumentVisibilityReader,
  capturePublishedHomeEvidence, governanceNoticeParticipants,
  type HomeDocumentEvidenceCut } from '../src/modules/governance/composition.ts';
import { GovernanceDenied, GovernanceUnavailable } from '../src/modules/governance/store.ts';
import { publicReportOwners, reportAddress } from '../src/modules/public-report/owners.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import type { Pool } from 'pg';
import { RV } from '../src/modules/work/activate.ts';
import { zoneHomeTargetFixture, zoneHomeTargetCell as cell } from './support/zone-home-target.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
const principal = { issuer: 'account', subject: 'reader', emailVerified: true } as VerifiedPrincipal;

function published() {
  const fixture = zoneHomeTargetFixture(), source = cut();
  source.home.resource = fixture.resource;
  source.home.revision = fixture.revision;
  source.home.zone = fixture.zone;
  source.home.pages = fixture.selections;
  source.results.splice(0, source.results.length, ...fixture.selections.map(page => ({
    revisionId: page.revisionId, status: 'available' as const, reference: {
      owner: 'content' as const, resourceId: fixture.resource, variantId: page.variantId,
      revisionId: page.revisionId, byteDigest: page.byteDigest, byteLength: 2, model: 'zone-page-v1',
      format: 'rezics-content-json-v1' as const, language: { kind: 'tag' as const, tag: page.language, originalTag: page.language },
      direction: 'ltr' as const, sourceRevision: null, predecessor: null, provenance: {} },
    serializedJson: '{}', body: {},
  })));
  const registry = { realmReadProof: async () => null,
    canReadSemanticResource: async () => false,
    assertRecoveryOpen: async () => {},
  } as unknown as AccessAdmissionRegistry;
  const query = fixture.env.fuseki.query.bind(fixture.env.fuseki);
  fixture.env.fuseki.query = async queryText => {
    if (queryText.includes('SELECT ?epoch ?sequence')) return { results: { bindings: [{
      epoch: cell(fixture.env.lineage.dataEpoch), sequence: cell('9'),
    }] } };
    if (queryText.includes('SELECT DISTINCT ?resource ?revision')) return { results: { bindings: [{
      resource: cell(fixture.resource), revision: cell(fixture.revision),
    }] } };
    return query(queryText);
  };
  const pool = { query: async () => { throw new Error('home evidence cannot fall through to another owner'); } } as unknown as Pool;
  const deps = { environment: fixture.env, access: registry } as unknown as MainWorkDependencies;
  const core = { ...source.core, owningResourceForRevision: async () => fixture.resource } as unknown as ContentCore;
  return { ...fixture, source, registry, pool, deps, core };
}

function cut() {
  const home: HomeDocumentEvidenceCut = { resource: id(), revision: id(), zone: id(),
    disclosure: 'public', pages: Array.from({ length: 2 }, (_, index) => ({
      revisionId: randomUUID(), variantId: `urn:rezics:variant:${randomUUID()}`,
      byteDigest: String(index + 1).repeat(64),
    })) };
  const requested: string[][] = [];
  const results: ExactReadResult[] = home.pages.map(page => ({ revisionId: page.revisionId, status: 'available',
    reference: { owner: 'content', resourceId: home.resource, variantId: page.variantId,
      revisionId: page.revisionId, byteDigest: page.byteDigest!, byteLength: 2, model: 'zone-page-v1',
      format: 'rezics-content-json-v1', language: { kind: 'tag', tag: 'en', originalTag: 'en' },
      direction: 'ltr', sourceRevision: null, predecessor: null, provenance: {} }, serializedJson: '{}', body: {} }));
  const core: Pick<ContentCore, 'readExactBatch'> = { readExactBatch: async (ids, authorize) => {
    requested.push(ids);
    expect(await authorize(ids)).toEqual(new Set(ids));
    return ids.map(revision => results.find(result => result.revisionId === revision)!);
  } };
  return { home, core, requested, results };
}

test('condition 1: a notice captures P and exact multilingual H, without later Content revisions', async () => {
  const h = cut();
  const notice = await captureHomeDocumentEvidence(h.core, h.home);
  expect(notice).toMatchObject({ owner: 'graph', resource: h.home.resource,
    revision: h.home.revision, component: 'record', state: 'available',
    provenance: { homeRevision: h.home.revision, zone: h.home.zone } });
  expect(h.requested).toEqual([h.home.pages.map(page => page.revisionId)]);
  expect(notice.resource).not.toBe(h.home.zone);
  expect(notice.revisionDigest).toMatch(/^[0-9a-f]{64}$/);
});

test('condition 1: a selected public report reads only one exact body within its H', async () => {
  const h = cut(), page = h.home.pages[1]!;
  const report = await captureHomeDocumentEvidence(h.core, h.home, page.revisionId);
  expect(report).toMatchObject({ owner: 'content', resource: h.home.resource,
    revision: page.revisionId, revisionDigest: page.byteDigest, component: 'body', state: 'available' });
  expect(h.requested).toEqual([[page.revisionId]]);
});

test('condition 1: a draft or another cut cannot become selected home evidence', async () => {
  const h = cut();
  await expect(captureHomeDocumentEvidence(h.core, h.home, randomUUID())).rejects.toBeInstanceOf(GovernanceDenied);
  expect(h.requested).toEqual([]);
});

test('condition 1: resource, variant, revision and digest tampering refuse exact evidence', async () => {
  for (const field of ['resourceId', 'variantId', 'revisionId', 'byteDigest'] as const) {
    const h = cut(), first = h.results[0]!;
    if (first.status !== 'available') throw new Error('fixture');
    first.reference[field] = field === 'byteDigest' ? 'f'.repeat(64) : id();
    await expect(captureHomeDocumentEvidence(h.core, h.home)).rejects.toBeInstanceOf(GovernanceUnavailable);
  }
});

test('condition 1: erased or missing selected bytes refuse the complete home cut', async () => {
  for (const status of ['erased', 'missing', 'denied', 'corrupt'] as const) {
    const h = cut();
    h.results[1] = { revisionId: h.home.pages[1]!.revisionId, status };
    await expect(captureHomeDocumentEvidence(h.core, h.home)).rejects.toBeInstanceOf(GovernanceDenied);
  }
});

test('condition 3: authenticated home evidence uses owning Zone read and Realm membership', async () => {
  const zone = id(), realm = id(), actor = id(), scopes: string[] = [];
  const registry = { canReadSemanticResource: async (caller: VerifiedPrincipal | null,
    subject: string | null, resource: string) => { expect(caller).toBe(principal);
    expect(subject).toBe(actor); scopes.push(resource); return resource === zone; },
  realmReadProof: async (_caller: VerifiedPrincipal, _subject: string, target: string) => {
    scopes.push(target); return target === realm ? 'membership' : null;
  }, canReadWork: async () => { throw new Error('Work authority cannot substitute for Zone reading'); } } as unknown as AccessAdmissionRegistry;
  const reader = homeDocumentVisibilityReader(registry, principal, actor);
  expect(await reader.zoneReadable!(zone)).toBe(true);
  expect(await reader.realmReadProof!(realm)).toBe('membership');
  expect(scopes).toEqual([zone, realm]);
});

test('condition 3: anonymous and unrepresented readers cannot use private Realm evidence', async () => {
  let grants = 0;
  const registry = { realmReadProof: async () => { grants++; return 'membership'; },
    canReadSemanticResource: async () => false } as unknown as AccessAdmissionRegistry;
  for (const [caller, actor] of [[null, undefined], [principal, undefined]] as const) {
    const reader = homeDocumentVisibilityReader(registry, caller, actor);
    expect(await reader.realmReadProof!(id())).toBe(null);
    expect(await reader.zoneReadable!(id())).toBe(false);
  }
  expect(grants).toBe(0);
});

test('condition 1: /e/ native and SID display addresses admit a home Resource without URL fetch', async () => {
  const resource = id(), uuid = resource.slice(-36), sid = uuidToSid(uuid);
  for (const segment of [uuid, sid, `${sid}-home-document`]) {
    expect(await reportAddress({} as MainWorkDependencies, `https://rezics.com/e/${segment}`)).toBe(resource);
  }
  for (const segment of ['wrong', '%EA', `${sid}/extra`, `${sid}?revision=draft`, `${sid}#private`]) {
    await expect(reportAddress({} as MainWorkDependencies, `https://rezics.com/e/${segment}`)).rejects.toThrow();
  }
});

test('conditions 1 and 3: a public reader completes a report and copyright notice on a published /z/ home', async () => {
  for (const category of ['harassment', 'copyright'] as const) {
    const h = published();
    const result = await publicReportOwners(h.deps, h.pool, h.core).resolve({
      profile: 'public-report-v1', target: `https://rezics.com/z/${uuidToSid(h.space.slice(-36))}-site`,
      category, statement: 'This published document needs review', contentLanguage: 'en',
      ...(category === 'copyright' ? { copyright: { signature: 'Rights holder', claimantName: 'Rights holder',
        claimantAddress: 'Address', claimantPhone: 'Phone', claimedWork: 'Original work',
        materialLocation: 'Home page', goodFaith: true as const, accurateAndAuthorizedUnderPerjury: true as const } } : {}),
    }, new Request('https://rezics.com/v1/public-reports', { method: 'POST' }), null);
    expect(result.evidence).toMatchObject({ owner: 'graph', resource: h.resource,
      revision: h.revision, component: 'record', state: 'available' });
    expect(result.author).toBe(h.author);
    expect(h.source.requested).toEqual([h.selections.map(page => page.revisionId)]);
  }
});

test('condition 3: a private home notice requires its Zone read authority, not a Work grant on P', async () => {
  const h = published(), actor = id();
  h.visibilityRows[0]!.disclosure = cell(`${RV}Private`);
  h.visibilityRows[0]!.zoneDisclosure = cell(`${RV}Private`);
  let zoneGrant = false;
  const scopes: string[] = [];
  h.registry.canReadSemanticResource = async (_principal, _actor, target) => { scopes.push(target); return zoneGrant && target === h.zone; };
  h.registry.canReadWork = async () => { throw new Error('Work authority cannot grant home evidence'); };
  const target = { owner: 'graph' as const, resource: h.resource, component: 'record' as const,
    revision: h.revision, locator: null };
  await expect(capturePublishedHomeEvidence(h.env, h.core, h.registry, principal, actor, target))
    .rejects.toThrow('Target is unavailable');
  expect(h.source.requested).toEqual([]);
  zoneGrant = true;
  expect(await capturePublishedHomeEvidence(h.env, h.core, h.registry, principal, actor, target))
    .toMatchObject({ resource: h.resource, revision: h.revision, state: 'available' });
  expect(scopes.every(scope => scope === h.zone)).toBe(true);
});

test('conditions 1 and 3: erasure, draft cuts and reader revocation give the same unavailable evidence answer', async () => {
  for (const mode of ['erased', 'draft', 'revoked'] as const) {
    const h = published(), actor = id();
    h.visibilityRows[0]!.disclosure = cell(`${RV}Private`);
    h.visibilityRows[0]!.zoneDisclosure = cell(`${RV}Private`);
    let readable = true;
    h.registry.canReadSemanticResource = async () => readable;
    if (mode !== 'revoked') h.cutRows.splice(0);
    const core = { readExactBatch: async (...args: Parameters<ContentCore['readExactBatch']>) => {
      const read = await h.core.readExactBatch(...args); readable = false; return read;
    } };
    await expect(capturePublishedHomeEvidence(h.env, core, h.registry, principal, actor,
      { owner: 'graph', resource: h.resource, component: 'record', revision: h.revision, locator: null }))
      .rejects.toThrow('Target is unavailable');
    expect(h.source.requested.length).toBe(mode === 'revoked' ? 1 : 0);
  }
});

test('conditions 1 and 3: an anonymous non-reader cannot report or inspect a private /e/ home', async () => {
  const h = published();
  h.visibilityRows[0]!.disclosure = cell(`${RV}Private`);
  h.visibilityRows[0]!.zoneDisclosure = cell(`${RV}Private`);
  await expect(publicReportOwners(h.deps, h.pool, h.core).resolve({ profile: 'public-report-v1',
    target: `https://rezics.com/e/${uuidToSid(h.resource.slice(-36))}`, category: 'harassment',
    statement: 'An unadmitted report', contentLanguage: 'en',
  }, new Request('https://rezics.com/v1/public-reports', { method: 'POST' }), null))
    .rejects.toThrow('Target is unavailable');
  expect(h.source.requested).toEqual([]);
});

test('condition 1: lazy reservations never fall through to a draft evidence owner', async () => {
  const h = published();
  h.ownerRows[0]!.typed = cell('false');
  delete h.ownerRows[0]!.head;
  await expect(capturePublishedHomeEvidence(h.env, h.core, h.registry, principal, id(),
    { owner: 'graph', resource: h.resource, component: 'record', revision: h.revision, locator: null }))
    .rejects.toThrow('Target is unavailable');
  expect(h.source.requested).toEqual([]);
});

test('condition 3: home rights-notice affected parties come from the owning Space', async () => {
  const h = published(), prior = h.env.fuseki.query.bind(h.env.fuseki);
  h.env.fuseki.query = async query => {
    if (query.includes('SELECT ?space WHERE')) return { results: { bindings: [{ space: cell(h.space) }] } };
    if (query.includes('SELECT DISTINCT ?author')) {
      expect(query).toContain(`<${h.space}> rv:owner ?author`);
      expect(query).not.toContain(`<${h.resource}> rv:owner ?author`);
      return { results: { bindings: [{ author: cell(h.author) }] } };
    }
    return prior(query);
  };
  expect(await governanceNoticeParticipants(h.env).participants(
    { owner: 'graph', resource: h.resource, component: 'record', revision: h.revision, locator: null,
      scopeKind: 'exact_revision', expectedHead: h.revision, effect: 'disclosure' }, null, 10))
    .toEqual([h.author]);
});
