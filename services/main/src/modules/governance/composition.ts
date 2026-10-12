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
import { GRAPHS, RV, iri } from '../work/activate.ts';

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

/** Report and notice capture share one bounded exact Content read. The digest
 * covers only this H's selections; a later publication cannot widen evidence. */
export async function captureHomeDocumentEvidence(core: Pick<ContentCore, 'readExactBatch'>,
  home: HomeDocumentEvidenceCut, selectedRevision?: string): Promise<CapturedEvidence> {
  const pages = selectedRevision ? home.pages.filter(page => page.revisionId === selectedRevision) : home.pages;
  if (!pages.length || pages.length > 32 || new Set(pages.map(page => page.revisionId)).size !== pages.length) {
    throw new GovernanceDenied('Target is unavailable');
  }
  const exact = await core.readExactBatch(pages.map(page => page.revisionId), async ids => new Set(ids))
    .catch(() => { throw new GovernanceUnavailable('Content owner is unavailable'); });
  if (exact.length !== pages.length) throw new GovernanceUnavailable('Exact home evidence is unavailable');
  for (const [index, page] of pages.entries()) {
    const read = exact[index];
    if (!read || read.status !== 'available') throw new GovernanceDenied('Target is unavailable');
    if (read.revisionId !== page.revisionId || read.reference.resourceId !== home.resource || read.reference.variantId !== page.variantId
      || read.reference.revisionId !== page.revisionId || read.reference.byteDigest !== page.byteDigest) {
      throw new GovernanceUnavailable('Exact home evidence differs from the published cut');
    }
    if (['media-set-v1', 'member-reply-v1'].includes(read.reference.model)) {
      throw new GovernanceInvalid('Home evidence does not name a document body');
    }
  }
  const read = exact[0]!;
  if (read.status !== 'available') throw new GovernanceDenied('Target is unavailable');
  return { owner: selectedRevision ? 'content' : 'graph', resource: home.resource,
    component: selectedRevision ? 'body' : 'record', locator: null,
    revision: selectedRevision ?? home.revision, state: 'available',
    revisionDigest: selectedRevision ? read.reference.byteDigest
      : sha256(JSON.stringify([home.resource, home.revision, pages.map(page =>
        [page.variantId, page.revisionId, page.byteDigest])])),
    representation: selectedRevision ? read.reference.format : 'zone-home-cut-v1',
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

/** Known home identities do not fall through to Work authority or draft reads. */
export async function capturePublishedHomeEvidence(env: WorkActivationEnvironment,
  core: Pick<ContentCore, 'readExactBatch'>, registry: Partial<Pick<AccessAdmissionRegistry,
  'realmReadProof' | 'canReadSemanticResource'>>, principal: VerifiedPrincipal | null,
  actingSubject: string | undefined, target: EvidenceTarget, resolveCurrent = false,
  observedHomeRevision?: string): Promise<CapturedEvidence | null> {
  if (!await readZoneHomeOwner(env, target.resource)) return null;
  if (target.locator !== null || target.owner === 'graph' && target.component !== 'record'
    || target.owner === 'content' && target.component !== 'body'
    || !['graph', 'content'].includes(target.owner)
    || target.owner === 'graph' && !target.revision && !resolveCurrent) throw new GovernanceDenied('Target is unavailable');
  const home = await readZoneHomeTarget(env, target.resource,
    target.owner === 'graph' ? target.revision ?? undefined : observedHomeRevision,
    homeDocumentVisibilityReader(registry, principal, actingSubject), disclosureViewer(principal));
  if (!home || target.owner === 'content' && !target.revision) throw new GovernanceDenied('Target is unavailable');
  const captured = await captureHomeDocumentEvidence(core, { ...home, disclosure: home.disclosure === 'restricted' ? 'private' : 'public',
    pages: home.selections }, target.owner === 'content' ? target.revision! : undefined);
  const current = await readZoneHomeTarget(env, target.resource, home.revision,
    homeDocumentVisibilityReader(registry, principal, actingSubject), disclosureViewer(principal));
  if (!current || !isDeepStrictEqual(current, home)) throw new GovernanceDenied('Target is unavailable');
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
    content: { core: content, canRead: async (principal, actingSubject, ids) => {
      const disclosed = new Set<string>();
      for (const id of ids) {
        const resource = await content.owningResourceForRevision(id);
        if (resource && await readZoneHomeOwner(env, resource)) {
          const home = await readZoneHomeTarget(env, resource, undefined,
            homeDocumentVisibilityReader(registry, principal, actingSubject), disclosureViewer(principal));
          if (home?.selections.some(page => page.revisionId === id)) disclosed.add(id);
          continue;
        }
        if (resource &&
            ((await registry.canReadWork(principal, actingSubject, resource)) ||
              (
                await contentPool.query(
                  `SELECT 1 FROM media.asset a JOIN media.asset_state s ON s.id = a.state_head
            WHERE a.id = $1 AND s.disclosure = 'public' AND s.lifecycle = 'active' AND s.moderation = 'none'`,
                  [resource.slice(-36)],
                )
              ).rowCount)) disclosed.add(id);
      }
      return disclosed;
    } },
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
    if (!zone) return graph.participants!(target, after, limit);
    const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?space WHERE {
      GRAPH ${iri(GRAPHS.current)} { ${iri(zone)} a rv:Zone ; rv:space ?space ;
        rv:homeDocument ${iri(target.resource)} . ?space a rv:Space }
    } LIMIT 2`, 8192)).results?.bindings ?? [];
    if (rows.length !== 1 || !rows[0]?.space?.value) throw new GovernanceUnavailable('Home document owner is unavailable');
    return graph.participants!({ ...target, resource: rows[0].space.value }, after, limit);
  } };
}
