import { resolveResourceReference, type ReferenceOwners, type ReferenceResolution } from '../../../../content/src/reference.ts';
import { type ResourceReference } from '../../../../content/src/adoption.ts';
import { retainedDocumentBody } from '../../../../content/src/document-body.ts';
import { discloseContent } from '../disclosure/assembly.ts';
import { discloseInventory } from '../disclosure/read.ts';
import { disclosureViewer } from '../disclosure/viewer.ts';
import { referenceDisclosure } from '../target/disclosed-references.ts';
import { readSemanticRevision } from '../semantic/read.ts';
import { readCompositionHeader } from '../structure/graph.ts';
import { readCompositionPage, selectWorkCompositionRevision } from '../structure/read.ts';
import { GRAPHS, iri } from '../work/activate.ts';
import { type WorkReadSession, WorkReadUnavailable } from '../work/read-session.ts';
import { canReadContentTarget, ContentDraftUnavailable, resolveContentTarget } from './draft.ts';
import { publicDomainRevisionCurrent } from './public-domain-read.ts';

/** Main connects Content's closed selectors to existing Semantic, Structure and Media owners. */
export function contentReferenceOwners(session: WorkReadSession): ReferenceOwners {
  const deps = session.deps, env = deps.environment, principal = session.principal;
  const actingSubject = session.options.actingSubject;
  const viewer = disclosureViewer(principal, actingSubject);
  const disclosed = referenceDisclosure(env, { access: deps.access, principal, actingSubject,
    readers: { media: deps.media, mediaAccess: deps.mediaAccess } }, async target => !!principal && !!actingSubject
      && (!!await deps.access.canReadSemanticResource?.(principal, actingSubject, target)
        || await deps.access.canReadWork(principal, actingSubject, target)));
  const resource = async (target: string) => (await disclosed([target])).has(target);
  const structure = async (target: string, id: string, revision: string, occurrence?: string): Promise<boolean> => {
    const header = await readCompositionHeader(env, id);
    if (!header || ![header.owner, header.component, header.structure].includes(target)) return false;
    // Publication or represented preview selects the requested exact Structure.
    if (await selectWorkCompositionRevision(session, header, revision) !== revision) return false;
    const page = await readCompositionPage(env, { structure: id, revision, occurrence, limit: 1,
      canReadTarget: resource, canReadTargets: disclosed, header });
    return !occurrence || page.occurrences.some(item => item.occurrence === occurrence);
  };
  return {
    resource,
    revision: async (target, revision) => {
      if (!await resource(target)) return false;
      const header = await readCompositionHeader(env, target);
      if (header) return structure(target, target, revision);
      return (await readSemanticRevision(env, target, revision, disclosed)) !== null;
    },
    occurrence: (target, id, revision, occurrence) => structure(target, id, revision, occurrence),
    content: async (target, variant, revision) => {
      if (!deps.content) throw new WorkReadUnavailable('Content owner is unavailable');
      if (await deps.content.owningResourceForRevision(revision) !== target) return null;
      let privateReadable = false;
      if (principal && actingSubject) {
        try { privateReadable = await canReadContentTarget(env, deps.access, principal, actingSubject,
          target, await resolveContentTarget(env, target)); }
        catch (error) { if (!(error instanceof ContentDraftUnavailable)) throw error; }
      }
      const published = async () => (await session.query(`SELECT ?publication WHERE {
        GRAPH ${iri(GRAPHS.current)} { ${iri(variant)} <https://rezics.com/vocab/contentPublicationHead> ?publication ;
          <https://rezics.com/vocab/publicSearchEligibilityHead> ?eligibility }
        GRAPH ${iri(GRAPHS.revisions)} { ?publication a <https://rezics.com/vocab/ContentPublicationDecision> ;
          <https://rezics.com/vocab/contentRevision> ${iri(`urn:rezics:content:revision:${revision}`)} .
          ?eligibility a <https://rezics.com/vocab/ContentSearchEligibilityDecision> ;
          <https://rezics.com/vocab/publicationDecision> ?publication ;
          <https://rezics.com/vocab/disclosure> <https://rezics.com/vocab/Public> }
      } LIMIT 2`, 2)).length === 1;
      if (!privateReadable && !await published()) return null;
      const result = (await discloseContent(env, await deps.content.readExactBatch([revision], async ids => new Set(ids)), viewer))[0];
      if (result?.status !== 'available' || result.reference.resourceId !== target
        || result.reference.variantId !== variant || !await publicDomainRevisionCurrent(result.reference, deps.rights?.store)) return null;
      if (privateReadable && principal && actingSubject) {
        if (!await canReadContentTarget(env, deps.access, principal, actingSubject, target,
          await resolveContentTarget(env, target))) return null;
      } else if (!await published()) return null;
      return retainedDocumentBody(result.body);
    },
    representation: async (target, revision, representation) => {
      if (!deps.media) throw new WorkReadUnavailable('Media owner is unavailable');
      const asset = target.slice('urn:rezics:media:asset:'.length);
      const state = await deps.media.store.readAsset(asset);
      if (!state || state.lifecycle !== 'active' || state.moderation !== 'none') return null;
      const owner = !!principal && !!actingSubject && state.owner === actingSubject
        && await deps.access.canManageMedia?.(principal, actingSubject);
      if (!owner && state.disclosure !== 'public') return null;
      const visible = await discloseInventory(env, [{ owner: 'media', resource: `https://rezics.com/id/${asset}`,
        component: 'cover', revision: `https://rezics.com/id/${revision}` }], viewer, 'read');
      if (visible[0] !== 'visible') return null;
      const result = await deps.media.store.referenceSelection(asset, revision, representation);
      const fresh = await deps.media.store.readAsset(asset);
      if (!fresh || fresh.state !== state.state) return null;
      return result;
    },
  };
}
export async function resolveContentReference(session: WorkReadSession, reference: ResourceReference): Promise<ReferenceResolution> {
  return resolveResourceReference(reference, contentReferenceOwners(session));
}
