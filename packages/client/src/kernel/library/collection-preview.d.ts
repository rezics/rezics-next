import type { Actor } from '../request/access.ts';
import type { SubjectSummary } from '../semantic/summaries.ts';
import type { PresentationDependencies } from './collection-presentation.ts';
export type CollectionPreview = {
    previewMembers: {
        subjectId: string;
        subject: SubjectSummary;
    }[];
    previewStatus: 'ready' | 'pending';
};
export type PreviewParent = {
    id: string;
    revision: number;
    sourceGeneration: string;
    membershipKind: string;
};
/** One native home batch and one native display batch. No retained writes are performed.
 * An unfinished prefix is pending with no partial successful projection.
 */
export declare function readCollectionPreviews(deps: PresentationDependencies, actor: Actor, parents: readonly PreviewParent[], deadline: number, authorizeCurrent: (parent: PreviewParent) => Promise<void>, prepareUnresolved?: (previews: ReadonlyMap<string, CollectionPreview>) => Promise<void>): Promise<Map<string, CollectionPreview>>;
