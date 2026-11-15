import {
  parseKnowledgeMediaSelection,
  type KnowledgeMediaSelection,
} from '@rezics/definitions/knowledge-media';
import type { AccessClient, AccessCheck, Actor } from '../request/access.ts';
import { GrantDeniedError } from '../access/contract/index.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { accessCheck } from './access-port.ts';
import { mediaParentSnapshot } from './media-parent.ts';
import { prepareEditionSubjectIdentities } from './edition-subject.ts';
import { readDocumentMediaPresentations } from './media-presentation.ts';
import type { MediaDependencies } from './media.ts';
import {
  knowledgeMediaReservationSelection,
  knowledgeMediaSelection,
} from './knowledge-media-selection.ts';

export { claimKnowledgeMedia } from './knowledge-media-claim.ts';
export { publishKnowledgeMedia } from './knowledge-media-publication.ts';
export type { KnowledgeMediaSelection } from '@rezics/definitions/knowledge-media';

/** Same-home native ownership and ancestry; an account grant alone is insufficient. */
export async function knowledgeMediaReservationParent(
  client: AccessClient,
  documentId: string,
  ownerId: string,
  forUpdate = false,
): Promise<boolean> {
  const route = routeOf(documentId);
  const ownerRoute = routeOf(ownerId);
  if (route === null || ownerRoute === null || partitionOf(route) !== partitionOf(ownerRoute)) return false;
  const source = await knowledgeMediaReservationSelection(client, route, documentId, forUpdate);
  return source?.owner_account_id === ownerId;
}

export { parseKnowledgeMediaQuery as knowledgeMediaSelectionFromQuery } from '@rezics/definitions/knowledge-media';

const signature = (value: unknown) => JSON.stringify(value);
export type KnowledgeMediaReadAdmission = Readonly<{
  publiclyVisible: boolean;
  /** Native metadata only on the already-held same-home media anchor. */
  verify(client: AccessClient): Promise<boolean>;
  /** Independent source/Subject observations release every checkout before returning. */
  current(): Promise<boolean>;
}>;

/** Resolve an exact source once. Neither an image ID nor a copied publication locator
 * substitutes for current source admission. No body or foreign partition is hydrated.
 */
export async function prepareKnowledgeMediaRead(
  deps: MediaDependencies,
  actor: Actor,
  mediaId: string,
  documentId: string,
  selection: KnowledgeMediaSelection | undefined,
  original: boolean,
  deadline: number,
): Promise<KnowledgeMediaReadAdmission | null> {
  const route = routeOf(documentId);
  if (route === null || routeOf(mediaId) !== route) return null;
  // Unclaimed originals retain the ordinary uploader's private container prerequisite.
  // Public bytes and all derivatives require exact immutable revision membership.
  if (selection === undefined) {
    if (!original || actor.kind !== 'account') return null;
    const ownerRoute = routeOf(actor.accountId);
    if (ownerRoute === null || partitionOf(ownerRoute) !== partitionOf(route)) return null;
    const owner = await accessCheck(deps.access, actor, 'account:read', { route: ownerRoute, id: actor.accountId }, {
      pool: deps.pool, deadline,
    });
    const verify = async (client: AccessClient) => {
      if (!(await knowledgeMediaReservationParent(client, documentId, actor.accountId)) || !(await owner(client)))
        throw new GrantDeniedError();
      return false;
    };
    const current = async () => {
      await mediaParentSnapshot(deps.pool, route, deadline, verify);
      return true;
    };
    return (await current()) ? { publiclyVisible: false, verify, current } : null;
  }
  const selected = parseKnowledgeMediaSelection(selection);
  if (!selected || selected.documentId !== documentId || routeOf(selected.revisionId) !== route ||
      (selected.representation === 'public' && routeOf(selected.publicationId) !== route) ||
      (original && selected.representation === 'public')) return null;
  const read = (client: AccessClient) => knowledgeMediaSelection(
    client, route, documentId, selected.revisionId, selected.representation,
    selected.representation === 'public' ? selected.publicationId : undefined,
  );
  const initial = await mediaParentSnapshot(deps.pool, route, deadline, read);
  if (!initial || initial.media_ids.length > 32 || !initial.media_ids.includes(mediaId) ||
      Buffer.from(initial.body_sha256).toString('hex') !== selected.sourceSha256 ||
      (selected.representation === 'public' && initial.publication_id !== selected.publicationId)) return null;
  const publiclyVisible = selected.representation === 'public';
  let owner: AccessCheck | null = null;
  let subjects: Awaited<ReturnType<typeof prepareEditionSubjectIdentities>> | null = null;
  const ids = [...new Set([...(initial.subject_id === null ? [] : [initial.subject_id]), ...initial.subject_ids])];
  if (publiclyVisible) {
    if (initial.subject_id === null || ids.length > 65) return null;
    subjects = await prepareEditionSubjectIdentities(deps, ids, { actor: { kind: 'anonymous' }, deadline });
  } else {
    const ownerId = initial.owner_account_id;
    if (actor.kind !== 'account' || ownerId !== actor.accountId) return null;
    const ownerRoute = routeOf(ownerId);
    if (ownerRoute === null || partitionOf(ownerRoute) !== partitionOf(route)) return null;
    owner = await accessCheck(deps.access, actor, 'account:read', { route: ownerRoute, id: ownerId }, {
      pool: deps.pool, deadline,
    });
  }
  const visibleSubjects = async () => {
    if (!subjects) return true;
    const current = await subjects();
    return ids.every((id) => current.get(id)?.kind === 'available');
  };
  const verify = async (client: AccessClient) => {
    const current = await read(client);
    if (!current || signature(current) !== signature(initial) || (owner && !(await owner(client))))
      throw new GrantDeniedError();
    return publiclyVisible;
  };
  const current = async () => {
    if (!(await visibleSubjects())) return false;
    await mediaParentSnapshot(deps.pool, route, deadline, verify);
    return visibleSubjects();
  };
  return (await current()) ? { publiclyVisible, verify, current } : null;
}

/** Public projection and owner publication preview reuse ordinary Media admission.
 * The returned IDs carry no bytes, signing capability, or persisted read grant.
 */
export async function readKnowledgeMediaAvailability(
  deps: MediaDependencies,
  actor: Actor,
  ids: readonly string[],
  selection: KnowledgeMediaSelection,
  deadline: number,
): Promise<ReadonlySet<string>> {
  if (ids.length === 0) return new Set();
  const page = await readDocumentMediaPresentations(deps, actor, ids, { deadline, knowledge: selection });
  return new Set(page.images.map((image) => image.id));
}
