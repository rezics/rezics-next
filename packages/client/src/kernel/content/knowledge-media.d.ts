import { type KnowledgeMediaSelection } from '@rezics/definitions/knowledge-media';
import type { AccessClient, Actor } from '../request/access.ts';
import type { MediaDependencies } from './media.ts';
export { claimKnowledgeMedia } from './knowledge-media-claim.ts';
export { publishKnowledgeMedia } from './knowledge-media-publication.ts';
export type { KnowledgeMediaSelection } from '@rezics/definitions/knowledge-media';
/** Same-home native ownership and ancestry; an account grant alone is insufficient. */
export declare function knowledgeMediaReservationParent(client: AccessClient, documentId: string, ownerId: string, forUpdate?: boolean): Promise<boolean>;
export { parseKnowledgeMediaQuery as knowledgeMediaSelectionFromQuery } from '@rezics/definitions/knowledge-media';
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
export declare function prepareKnowledgeMediaRead(deps: MediaDependencies, actor: Actor, mediaId: string, documentId: string, selection: KnowledgeMediaSelection | undefined, original: boolean, deadline: number): Promise<KnowledgeMediaReadAdmission | null>;
/** Public projection and owner publication preview reuse ordinary Media admission.
 * The returned IDs carry no bytes, signing capability, or persisted read grant.
 */
export declare function readKnowledgeMediaAvailability(deps: MediaDependencies, actor: Actor, ids: readonly string[], selection: KnowledgeMediaSelection, deadline: number): Promise<ReadonlySet<string>>;
