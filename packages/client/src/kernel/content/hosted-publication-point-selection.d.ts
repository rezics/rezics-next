import { type HostedChapterTarget, type OrderedHostedPlacement } from './hosted-chapters-model.ts';
export type HostedPublishChapterInput = Readonly<{
    expectedRevisionId: string;
    expectedPublicationId: string;
    occurrenceId: string;
    target: HostedChapterTarget;
    parentId: string | null;
    beforeOccurrenceId: string | null;
    /** Every draft-only part in the source path, in root-to-leaf order, with its public sibling anchor. */
    selectedAncestors: readonly Readonly<{
        occurrenceId: string;
        beforeOccurrenceId: string | null;
    }>[];
}>;
export type HostedReplacePublishedChapterInput = Readonly<{
    expectedRevisionId: string;
    expectedPublicationId: string;
    occurrenceId: string;
    target: HostedChapterTarget;
}>;
export type HostedPublicationPointInput = Readonly<{
    kind: 'publishChapter';
    input: HostedPublishChapterInput;
}> | Readonly<{
    kind: 'replacePublishedChapter';
    input: HostedReplacePublishedChapterInput;
}>;
/** Snapshot-bound point reads supplied by the Book adapter. Every call names the
 * expected immutable version; selection never receives a draft iterator. */
export type HostedPointSelectionReads = Readonly<{
    draftPoint(revisionId: string, occurrenceId: string): Promise<OrderedHostedPlacement | null>;
    publicationPoint(publicationId: string, occurrenceId: string): Promise<OrderedHostedPlacement | null>;
}>;
export type HostedPointSelectedAncestor = Readonly<{
    placement: OrderedHostedPlacement;
    before: OrderedHostedPlacement | null;
}>;
export type HostedPointInsertionSelection = Readonly<{
    kind: 'publishChapter';
    expectedRevisionId: string;
    expectedPublicationId: string;
    chapter: OrderedHostedPlacement;
    ancestors: readonly HostedPointSelectedAncestor[];
    parentId: string | null;
    beforeOccurrenceId: string | null;
    parent: OrderedHostedPlacement | null;
    before: OrderedHostedPlacement | null;
    /** Placement values whose exact targets need current native checks. */
    changedPlacements: readonly OrderedHostedPlacement[];
}>;
export type HostedPointReplacementSelection = Readonly<{
    kind: 'replacePublishedChapter';
    expectedRevisionId: string;
    expectedPublicationId: string;
    /** The current public value supplies the parent, order, title and all untouched fields. */
    publicChapter: OrderedHostedPlacement;
    /** The expected draft value supplies only the exact replacement target. */
    draftChapter: OrderedHostedPlacement;
    changedPlacements: readonly OrderedHostedPlacement[];
}>;
export type HostedPointSelection = HostedPointInsertionSelection | HostedPointReplacementSelection;
/** Resolve only the selected source, its bounded parent chain and the requested
 * public anchors. The callback contract pins each read to the supplied version
 * IDs, so a draft-only occurrence can never be reinterpreted as a public rank. */
export declare function selectHostedPublicationPoint(reads: HostedPointSelectionReads, input: HostedPublicationPointInput): Promise<HostedPointSelection>;
