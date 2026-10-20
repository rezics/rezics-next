import type { PoolClient } from 'pg';
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
import { isPublicContentRevision } from './public-selection.ts';
import { CompositionUnavailable } from '../structure/graph.ts';
import { readWorkComponentState } from '../work/history.ts';
import { bindNativeAssetAudience } from '../media/visibility.ts';
import { readInstructionAdoptionCandidates } from '../work/instruction-adoption.ts';

async function mediaSelection(session: WorkReadSession, target: string, revision?: string,
  representation?: string): Promise<{ duration?: number } | null> {
  const { deps, principal } = session, actingSubject = session.options.actingSubject;
  const media = deps.media;
  if (!media) throw new WorkReadUnavailable('Media owner is unavailable');
  const asset = target.slice('urn:rezics:media:asset:'.length);
  const read = async () => {
    const state = await media.store.readAsset(asset);
    if (!state || state.lifecycle !== 'active' || state.moderation !== 'none') return null;
    const owner = !!principal && !!actingSubject && state.owner === actingSubject
      && await deps.access.canManageMedia?.(principal, actingSubject);
    const viewer = disclosureViewer(principal, actingSubject);
    const grants = !owner && state.disclosure !== 'public' && revision && representation
      ? await readInstructionAdoptionCandidates(deps.environment, { target, mediaRevision: revision }) : [];
    const uses = [...new Set(grants.flatMap(item => item.selector.grain === 'representation'
      && item.selector.representation === representation && item.mediaUse ? [item.mediaUse] : []))];
    if (!owner && state.disclosure !== 'public' && !uses.length) return null;
    if (uses.length > 64) throw new WorkReadUnavailable('Media reference audience exceeds its bound');
    if (owner) bindNativeAssetAudience(viewer, asset);
    const visible = await discloseInventory(deps.environment, (uses.length ? uses : [asset]).map(use => ({ owner: 'media' as const,
      resource: `https://rezics.com/id/${use}`, component: 'cover' as const,
      ...(revision ? { revision: `https://rezics.com/id/${revision}` } : {}) })), viewer, 'read');
    if (!visible.some(decision => decision === 'visible')) return null;
    const selected = revision && representation ? await media.store.referenceSelection(asset, revision, representation) : {};
    const fresh = await media.store.readAsset(asset);
    return fresh?.state === state.state ? selected : null;
  };
  const selected = await read(); session.observeDependency(`media-reference:${asset}:${revision ?? ''}:${representation ?? ''}`, selected, read);
  return selected;
}

/** Main connects Content's closed selectors to existing Semantic, Structure and Media owners. */
export function contentReferenceOwners(session: WorkReadSession, contentClient?: PoolClient,
  publicSelection?: () => Promise<boolean>): ReferenceOwners {
  const deps = session.deps, env = deps.environment, principal = session.principal;
  const actingSubject = session.options.actingSubject;
  const viewer = session.viewer;
  const disclosed = referenceDisclosure(env, { access: deps.access, principal, actingSubject,
    readers: { media: deps.media, mediaAccess: deps.mediaAccess } }, async target => !!principal && !!actingSubject
      && (!!await deps.access.canReadSemanticResource?.(principal, actingSubject, target)
        || await deps.access.canReadWork(principal, actingSubject, target)));
  const resource = async (target: string) => {
    const read = async () => target.startsWith('urn:rezics:media:asset:')
      ? (await mediaSelection(session, target)) !== null : (await disclosed([target])).has(target);
    const available = await read(); session.observeDependency(`resource-reference:${target}`, available, read);
    return available;
  };
  const structure = async (target: string, id: string, revision: string, occurrence?: string): Promise<boolean> => {
    const header = await readCompositionHeader(env, id);
    if (!header || ![header.owner, header.component, header.structure].includes(target)) return false;
    // Publication or represented preview selects the requested exact Structure.
    try {
      if (await selectWorkCompositionRevision(session, header, revision) !== revision) return false;
      const page = await readCompositionPage(env, { structure: id, revision, occurrence, limit: 1,
        canReadTarget: resource, canReadTargets: disclosed, header });
      return !occurrence || page.occurrences.some(item => item.occurrence === occurrence);
    } catch (error) { if (error instanceof CompositionUnavailable) return false; throw error; }
  };
  return {
    resource,
    revision: async (target, revision) => {
      if (!await resource(target)) return false;
      if (await readSemanticRevision(env, target, revision, disclosed)) return resource(target);
      if (!/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(target)) return false;
      const header = await readCompositionHeader(env, target);
      if (header) return structure(target, target, revision);
      const anchors = await session.query(`SELECT ?manifest ?model WHERE {
        GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a <https://rezics.com/vocab/RevisionAnchor> ;
          <https://rezics.com/vocab/component> ${iri(target)} ; <https://rezics.com/vocab/manifest> ?manifest ;
          <https://rezics.com/vocab/modelRevision> ?model .
          VALUES ?model { <https://rezics.com/definition/work-metadata-v1> <https://rezics.com/definition/post-v1>
            <https://rezics.com/definition/agent-provision-v1> }
          FILTER NOT EXISTS { ${iri(revision)} a <https://rezics.com/vocab/ErasedRevision> }
        }
      } LIMIT 2`, 2);
      if (anchors.length !== 1 || !anchors[0]?.manifest || !anchors[0]?.model) return false;
      await readWorkComponentState(env, anchors[0].manifest.value, target, anchors[0].model.value);
      return resource(target);
    },
    occurrence: (target, id, revision, occurrence) => structure(target, id, revision, occurrence),
    content: async (target, variant, revision, selector) => {
      if (!deps.content) throw new WorkReadUnavailable('Content owner is unavailable');
      const privateAuthority = async () => {
        if (!principal || !actingSubject) return false;
        try { return await canReadContentTarget(env, deps.access, principal, actingSubject,
          target, await resolveContentTarget(env, target)); }
        catch (error) { if (!(error instanceof ContentDraftUnavailable)) throw error; return false; }
      };
      // Fence the selected authority, not just immutable bytes. This closure
      // registers no dependencies while the session is fencing its inventory.
      const privateReadable = !publicSelection && await privateAuthority();
      const authority = privateReadable ? privateAuthority
        : publicSelection ?? (() => isPublicContentRevision(env, target, revision, variant, selector));
      const read = async () => {
        try {
          if (!await authority()) return null;
          if (await deps.content!.owningResourceForRevision(revision, contentClient) !== target) {
            throw new WorkReadUnavailable('Content and publication disagree');
          }
          const results = await discloseContent(env,
            await deps.content!.readExactBatch([revision], async ids => new Set(ids), contentClient), viewer);
          if (results.length !== 1) throw new WorkReadUnavailable('Content owner result is incomplete');
          const result = results[0]!;
          if (result.status === 'denied' || result.status === 'erased') return null;
          if (result.status === 'corrupt') throw new WorkReadUnavailable('Content integrity mismatch');
          if (result.status === 'unavailable') throw new WorkReadUnavailable('Content dependency unavailable');
          if (result.status === 'missing') throw new WorkReadUnavailable('Published Content object missing');
          if (result.status !== 'available') throw new WorkReadUnavailable('Content owner result is invalid');
          if (result.revisionId !== revision || result.reference.resourceId !== target
            || result.reference.variantId !== variant) throw new WorkReadUnavailable('Content and publication disagree');
          if (!await publicDomainRevisionCurrent(result.reference, deps.rights?.store, contentClient)
            || !await authority()) return null;
          return result;
        } catch (cause) {
          if (cause instanceof WorkReadUnavailable) throw cause;
          throw new WorkReadUnavailable('Content reference owner is unavailable', { cause });
        }
      };
      const result = await read();
      session.observeDependency(`content-reference:${target}:${JSON.stringify(selector)}`, result, read);
      return result ? retainedDocumentBody(result.body) : null;
    },
    representation: (target, revision, representation) => mediaSelection(session, target, revision, representation),
  };
}
export async function resolveContentReference(session: WorkReadSession, reference: ResourceReference,
  publicSelection?: () => Promise<boolean>): Promise<ReferenceResolution> {
  return resolveResourceReference(reference, contentReferenceOwners(session, undefined, publicSelection));
}
