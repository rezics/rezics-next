import type { Pool } from 'pg';
import { isDeepStrictEqual } from 'node:util';
import type { ContentCore } from '../../../../content/src/core.ts';
import type { AccessAdmissionRegistry } from '../access/admission.ts';
import type { VerifiedPrincipal } from '../access/admission.ts';
import type { SourceIntakeStore } from '../source/intake.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import { ownerEvidenceCapture, ownerTargetHeads } from './evidence.ts';
import { graphNoticeParticipants, ownerModerationEffects } from './effects.ts';
import { ContentModeration } from '../../../../content/src/moderation.ts';
import { GovernanceRules } from './rules.ts';
import { GovernanceStore } from './store.ts';
import { ReviewReportOwner } from './report-review.ts';
import { RealmReplyContentStore } from '../realm-reply/content-store.ts';
import { RealmReplyStore } from '../realm-reply/store.ts';
import { GovernanceDenied, GovernanceInvalid, GovernanceUnavailable, sha256,
  type CapturedEvidence, type EvidenceTarget } from './store.ts';
import { readZoneHomeOwner, readZoneHomeTarget } from '../zone/home-target.ts';
import { disclosureViewer } from '../disclosure/viewer.ts';
import type { VisibilityReader } from '../space/visibility.ts';
import { readResourceVisibility } from '../space/visibility.ts';
import { GRAPHS, RV, iri } from '../work/activate.ts';
import { captureHomeDisclosureFence } from '../zone/home-disclosure-fence.ts';

/** The publication owner supplies a published cut, never a variant draft head. */
export interface HomeDocumentEvidenceCut {
  resource: string;
  revision: string;
  zone: string;
  disclosure: 'public' | 'private';
  pages: readonly { variantId: string; revisionId: string; byteDigest?: string }[];
  author?: string;
  realm?: string | null;
}

/** Report and notice capture share bounded exact Content reads. The digest
 * covers only this H's selections; a later publication cannot widen evidence. */
export async function captureHomeDocumentEvidence(core: Pick<ContentCore, 'readExactBatch'>,
  home: HomeDocumentEvidenceCut, selectedRevision?: string): Promise<CapturedEvidence> {
  const pages = selectedRevision ? home.pages.filter(page => page.revisionId === selectedRevision) : home.pages;
  if (!pages.length) {
    throw new GovernanceDenied('Target is unavailable');
  }
  if (pages.length > 32 || new Set(pages.map(page => page.revisionId)).size !== pages.length) {
    throw new GovernanceUnavailable('Exact home evidence exceeds its bound');
  }
  let firstReference: Extract<Awaited<ReturnType<ContentCore['readExactBatch']>>[number], { status: 'available' }>['reference'] | undefined;
  // Each admitted body fits Content's 4 MiB bound; their multilingual sum need
  // not. Sequential singleton reads also release each body before the next one.
  for (const page of pages) {
    const exact = await core.readExactBatch([page.revisionId], async ids => new Set(ids))
      .catch(() => { throw new GovernanceUnavailable('Content owner is unavailable'); });
    const read = exact[0];
    if (exact.length !== 1 || !read || ['missing', 'unavailable', 'corrupt'].includes(read.status)) {
      throw new GovernanceUnavailable('Exact home evidence is unavailable');
    }
    if (read.status !== 'available') throw new GovernanceDenied('Target is unavailable');
    if (read.revisionId !== page.revisionId || read.reference.resourceId !== home.resource || read.reference.variantId !== page.variantId
      || read.reference.revisionId !== page.revisionId || read.reference.byteDigest !== page.byteDigest) {
      throw new GovernanceUnavailable('Exact home evidence differs from the published cut');
    }
    if (['media-set-v1', 'member-reply-v1'].includes(read.reference.model)) {
      throw new GovernanceInvalid('Home evidence does not name a document body');
    }
    firstReference ??= read.reference;
  }
  if (!firstReference) throw new GovernanceUnavailable('Exact home evidence is unavailable');
  return { owner: selectedRevision ? 'content' : 'graph', resource: home.resource,
    component: selectedRevision ? 'body' : 'record', locator: null,
    revision: selectedRevision ?? home.revision, state: 'available',
    revisionDigest: selectedRevision ? firstReference.byteDigest
      : sha256(JSON.stringify([home.resource, home.revision, pages.map(page =>
        [page.variantId, page.revisionId, page.byteDigest])])),
    representation: selectedRevision ? firstReference.format : 'zone-home-cut-v1',
    provenance: { capturedBy: 'zone-home-exact-cut-v1', zone: home.zone,
      homeRevision: home.revision, disclosure: home.disclosure,
      ...(home.author ? { author: home.author } : {}), ...(home.realm ? { realm: home.realm } : {}) } };
}

export function homeDocumentVisibilityReader(registry: Partial<Pick<AccessAdmissionRegistry,
  'realmReadProof' | 'canReadSemanticResource'>>, principal: VerifiedPrincipal | null,
  actingSubject?: string): VisibilityReader {
  return { realmReadProof: realm => principal && actingSubject
    ? registry.realmReadProof?.(principal, actingSubject, realm) ?? Promise.resolve(null) : Promise.resolve(null),
  zoneReadable: zone => registry.canReadSemanticResource?.(principal, actingSubject ?? null, zone) ?? Promise.resolve(false) };
}

/** Legacy Content keeps Z as its resource after the document receives P. Its
 * read authority and notice participants still belong to Z's Space. */
async function legacyZoneContentOwner(env: WorkActivationEnvironment, resource: string): Promise<string | null> {
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?legacySpace WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(resource)} a rv:Zone .
      OPTIONAL { ${iri(resource)} rv:space ?legacySpace . ?legacySpace a rv:Space } }
  } LIMIT 2`, 8192).catch(error => {
    throw new GovernanceUnavailable('Legacy home owner is unavailable', { cause: error });
  })).results?.bindings ?? [];
  if (!rows.length) return null;
  if (rows.length !== 1 || !rows[0]?.legacySpace?.value) {
    throw new GovernanceUnavailable('Legacy home owner is unavailable');
  }
  return rows[0].legacySpace.value;
}

export function governanceContentEvidenceReader(content: Pick<ContentCore, 'owningResourceForRevision'>,
  contentPool: Pick<Pool, 'query'>, registry: Pick<AccessAdmissionRegistry,
    'realmReadProof' | 'canReadSemanticResource' | 'canReadWork'>, env: WorkActivationEnvironment) {
  return async (principal: VerifiedPrincipal, actingSubject: string, ids: readonly string[]) => {
    const disclosed = new Set<string>();
    for (const id of ids) {
      const resource = await content.owningResourceForRevision(id);
      if (!resource) continue;
      if (await readZoneHomeOwner(env, resource)) {
        const home = await readZoneHomeTarget(env, resource, undefined,
          homeDocumentVisibilityReader(registry, principal, actingSubject), disclosureViewer(principal));
        if (home?.selections.some(page => page.revisionId === id)) disclosed.add(id);
        continue;
      }
      if (await legacyZoneContentOwner(env, resource)) {
        const visibility = await readResourceVisibility(env, resource,
          homeDocumentVisibilityReader(registry, principal, actingSubject)).catch(error => {
          throw new GovernanceUnavailable('Legacy home visibility is unavailable', { cause: error });
        });
        if (visibility?.readable) disclosed.add(id);
        continue;
      }
      if (await registry.canReadWork(principal, actingSubject, resource)
        || (await contentPool.query(
          `SELECT 1 FROM media.asset a JOIN media.asset_state s ON s.id = a.state_head
            WHERE a.id = $1 AND s.disclosure = 'public' AND s.lifecycle = 'active' AND s.moderation = 'none'`,
          [resource.slice(-36)],
        )).rowCount) disclosed.add(id);
    }
    return disclosed;
  };
}

/** Known home identities do not fall through to Work authority or draft reads. */
export async function capturePublishedHomeEvidence(env: WorkActivationEnvironment,
  core: Pick<ContentCore, 'readExactBatch'>, registry: Partial<Pick<AccessAdmissionRegistry,
  'realmReadProof' | 'canReadSemanticResource'>>, principal: VerifiedPrincipal | null,
  actingSubject: string | undefined, target: EvidenceTarget, resolveCurrent = false,
  observedHomeRevision?: string): Promise<CapturedEvidence | null> {
  if (!await readZoneHomeOwner(env, target.resource)) {
    if (target.owner !== 'content' || !await legacyZoneContentOwner(env, target.resource)) return null;
    if (target.component !== 'body' || !target.revision || target.locator !== null) {
      throw new GovernanceDenied('Target is unavailable');
    }
    const reader = homeDocumentVisibilityReader(registry, principal, actingSubject);
    const visibility = await readResourceVisibility(env, target.resource, reader);
    if (!visibility?.readable) throw new GovernanceDenied('Target is unavailable');
    const fence = await captureHomeDisclosureFence(env, [{ resource: target.resource, zone: target.resource,
      targets: [{ owner: 'content', resource: target.resource, revision: target.revision, component: 'body' }] }],
    disclosureViewer(principal), 'read');
    const exact = await core.readExactBatch([target.revision], async ids => new Set(ids))
      .catch(cause => { throw new GovernanceUnavailable('Content owner is unavailable', { cause }); });
    const read = exact[0];
    if (exact.length !== 1 || !read || ['missing', 'unavailable', 'corrupt'].includes(read.status)) {
      throw new GovernanceUnavailable('Exact legacy home evidence is unavailable');
    }
    if (read.status !== 'available') throw new GovernanceDenied('Target is unavailable');
    if (read.reference.resourceId !== target.resource || read.reference.revisionId !== target.revision) {
      throw new GovernanceUnavailable('Legacy evidence differs from its owner revision');
    }
    if (['media-set-v1', 'member-reply-v1'].includes(read.reference.model)) {
      throw new GovernanceInvalid('Home evidence does not name a document body');
    }
    const evidence: CapturedEvidence = { ...target, state: 'available', representation: read.reference.format,
      revisionDigest: read.reference.byteDigest, provenance: { capturedBy: 'zone-legacy-exact-revision-v1',
        zone: target.resource, disclosure: visibility.visibility,
        ...(visibility.realm ? { realm: visibility.realm } : {}),
        ...(typeof read.reference.provenance.author === 'string' ? { author: read.reference.provenance.author } : {}) } };
    const visible = await fence(async () => {
      const current = await readResourceVisibility(env, target.resource, reader);
      return new Set(current?.readable && current.visibility === visibility.visibility
        && current.space === visibility.space && current.realm === visibility.realm ? [target.resource] : []);
    });
    if (!visible.has(target.resource)) throw new GovernanceDenied('Target is unavailable');
    return evidence;
  }
  if (target.locator !== null || target.owner === 'graph' && target.component !== 'record'
    || target.owner === 'content' && target.component !== 'body'
    || !['graph', 'content'].includes(target.owner)
    || target.owner === 'graph' && !target.revision && !resolveCurrent) throw new GovernanceDenied('Target is unavailable');
  const home = await readZoneHomeTarget(env, target.resource,
    target.owner === 'graph' ? target.revision ?? undefined : observedHomeRevision,
    homeDocumentVisibilityReader(registry, principal, actingSubject), disclosureViewer(principal));
  if (!home || target.owner === 'content' && !target.revision) throw new GovernanceDenied('Target is unavailable');
  const fence = await captureHomeDisclosureFence(env, [{ resource: home.resource, zone: home.zone,
    targets: [{ owner: 'graph', resource: home.resource, revision: home.revision, component: 'record' },
      ...home.selections.filter(page => target.owner !== 'content' || page.revisionId === target.revision)
        .map(page => ({ owner: 'content' as const, resource: home.resource, revision: page.revisionId,
          component: 'body' as const, occurrence: { owner: 'graph' as const, kind: 'publication' as const,
            resource: home.resource, revision: home.revision } }))] }],
  disclosureViewer(principal), 'read');
  const captured = await captureHomeDocumentEvidence(core, { ...home, disclosure: home.disclosure === 'restricted' ? 'private' : 'public',
    pages: home.selections }, target.owner === 'content' ? target.revision! : undefined);
  const current = await readZoneHomeTarget(env, target.resource, home.revision,
    homeDocumentVisibilityReader(registry, principal, actingSubject), disclosureViewer(principal));
  if (!current || !isDeepStrictEqual(current, home)) throw new GovernanceDenied('Target is unavailable');
  const visible = await fence(async () => {
    const visibility = await readResourceVisibility(env, home.zone,
      homeDocumentVisibilityReader(registry, principal, actingSubject));
    return new Set(visibility?.readable && (visibility.visibility === 'private') === (home.disclosure === 'restricted')
      && visibility.space === home.space ? [home.zone] : []);
  });
  if (!visible.has(home.resource)) throw new GovernanceDenied('Target is unavailable');
  return captured;
}

/** Main's real owner readers; every evidence lookup stays on the pinned revision. */
export function governanceServices(accessPool: Pool, contentPool: Pool, content: ContentCore,
  source: SourceIntakeStore, registry: AccessAdmissionRegistry, env: WorkActivationEnvironment) {
  const rules = new GovernanceRules(accessPool);
  const reviews = new ReviewReportOwner(accessPool, registry, env);
  const evidence = ownerEvidenceCapture({
    reply: { pool: contentPool, core: content,
      reader: new RealmReplyStore(new RealmReplyContentStore(contentPool), content, registry, env) },
    content: { core: content, canRead: governanceContentEvidenceReader(content, contentPool, registry, env) },
    graph: { env, canReadWork: (principal, actingSubject, work) =>
      registry.canReadWork(principal, actingSubject, work) },
    media: { pool: contentPool, canReadWork: (principal, actingSubject, work) =>
      registry.canReadWork(principal, actingSubject, work) },
    source: async (principal, recordId, observationId) => {
      const principalId = await registry.activePrincipalId(principal);
      const observation = principalId ? await source.read(principalId, observationId) : null;
      return observation?.record === `https://rezics.com/id/${recordId}` ? {
        record: observation.record, retention: observation.retention,
        byteDigest: observation.byteDigest, mediaType: observation.mediaType,
      } : null;
    },
  });
  const heads = ownerTargetHeads({ graph: env, content: contentPool });
  const store = new GovernanceStore(accessPool, {
    capture: async (principal, actingSubject, target) => target.owner === 'review'
      ? reviews.capture(principal, actingSubject, target)
      : await capturePublishedHomeEvidence(env, content, registry, principal, actingSubject, target)
        ?? evidence.capture(principal, actingSubject, target),
  }, {
    current: async (target) => {
      if (target.owner === 'review') return reviews.current(target);
      const zone = await readZoneHomeOwner(env, target.resource);
      if (zone) {
        // Staleness is internal owner identity, not a reader admission. Private
        // homes retain their current head; the capture path establishes reading.
        const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT DISTINCT ?head WHERE {
          GRAPH ${iri(GRAPHS.current)} { ${iri(zone)} rv:homeDocument ${iri(target.resource)} ;
            rv:zoneState rv:Active . ${iri(target.resource)} rv:homeDocumentHead ?head }
          GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:ZoneHomeRevision ; rv:component ${iri(target.resource)} .
            FILTER NOT EXISTS { ?head a rv:ErasedRevision }
            ${target.owner === 'content' && target.revision
              ? `?head rv:publishedPage ?binding . ?binding rv:contentRevision ${iri(`urn:rezics:content:revision:${target.revision}`)} .` : ''}
          }
        } LIMIT 2`, 8192)).results?.bindings ?? [];
        return rows.length === 1 ? target.owner === 'graph' ? rows[0]!.head!.value : target.revision : null;
      }
      return heads.current(target);
    },
    realmBasis: (target) => heads.realmBasis(target),
  }, rules, { ...ownerModerationEffects(new ContentModeration(contentPool), env, {
      pool: contentPool,
      core: content,
    }), ...governanceNoticeParticipants(env) }, reviews);
  return { store, rules };
}

/** Main correspondence shares the private graph reader used by moderation. */
export function governanceNoticeParticipants(env: WorkActivationEnvironment) {
  const graph = graphNoticeParticipants(env);
  return { async participants(target: Parameters<NonNullable<typeof graph.participants>>[0],
    after: string | null, limit: number) {
    const zone = await readZoneHomeOwner(env, target.resource);
    if (!zone) {
      const space = await legacyZoneContentOwner(env, target.resource);
      return graph.participants!(space ? { ...target, resource: space } : target, after, limit);
    }
    const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?space WHERE {
      GRAPH ${iri(GRAPHS.current)} { ${iri(zone)} a rv:Zone ; rv:space ?space ;
        rv:homeDocument ${iri(target.resource)} . ?space a rv:Space }
    } LIMIT 2`, 8192)).results?.bindings ?? [];
    if (rows.length !== 1 || !rows[0]?.space?.value) throw new GovernanceUnavailable('Home document owner is unavailable');
    return graph.participants!({ ...target, resource: rows[0].space.value }, after, limit);
  } };
}
