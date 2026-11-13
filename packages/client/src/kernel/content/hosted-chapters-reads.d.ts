import type { ReadContext } from './model.ts';
import type { HostedPointSelectionReads } from './hosted-publication-point-selection.ts';
import { type HostedDependencies, type HostedReadSelection, type HostedChildrenInput, type HostedNavigationInput, type HostedOccurrenceView, type HostedPageView, type HostedResolutionView } from './hosted-chapters-model.ts';
type HostedCatalogueReadSelection = HostedReadSelection & Readonly<{
    includeTitle?: '1';
}>;
export declare function readHostedCatalogue(deps: HostedDependencies, catalogueId: string, selection: HostedCatalogueReadSelection, context: ReadContext): Promise<{
    value: {
        catalogueId: string;
        revisionId: string;
        kind: 'structure' | 'publication';
        sourceRevisionId: string | null;
        title?: string;
    };
    anchors: Readonly<{
        partition: import("../partition/partition.ts").Partition;
        epoch: number;
        position: bigint;
    }>[];
}>;
/** Snapshot-bound readers for one publication point command. Each lookup names
 * only its expected immutable version and requested occurrence; compatibility
 * manifests are deliberately not expanded into an ordered candidate here. */
export declare function hostedPublicationPointSelectionReads(deps: HostedDependencies, catalogueId: string, context: ReadContext): HostedPointSelectionReads;
export declare function resolveHostedOccurrence(deps: HostedDependencies, catalogueId: string, occurrenceId: string, selection: HostedReadSelection, context: ReadContext): Promise<{
    value: HostedResolutionView;
    anchors: Readonly<{
        partition: import("../partition/partition.ts").Partition;
        epoch: number;
        position: bigint;
    }>[];
}>;
/** Resolve the same historical occurrence and current Access as exact opening,
 * but disclose target metadata without selecting or serializing chapter bytes. */
export declare function resolveHostedOccurrenceMetadata(deps: HostedDependencies, catalogueId: string, occurrenceId: string, selection: HostedReadSelection, context: ReadContext): Promise<{
    value: {
        catalogueId: string;
        revisionId: string;
        kind: 'structure' | 'publication';
        sourceRevisionId: string | null;
        occurrence: HostedOccurrenceView;
    };
    anchors: Readonly<{
        partition: import("../partition/partition.ts").Partition;
        epoch: number;
        position: bigint;
    }>[];
}>;
export declare function listHostedChildren(deps: HostedDependencies, catalogueId: string, input: HostedChildrenInput, context: ReadContext): Promise<{
    value: HostedPageView;
    anchors: Readonly<{
        partition: import("../partition/partition.ts").Partition;
        epoch: number;
        position: bigint;
    }>[];
}>;
/** Author outline pages every placement in immutable preorder, including empty
 * parts. Keep sibling positions intact so a consumer can reconstruct the tree. */
export declare function listHostedAuthorOutline(deps: HostedDependencies, catalogueId: string, input: Omit<HostedChildrenInput, 'parentId'>, context: ReadContext): Promise<{
    value: HostedPageView;
    anchors: Readonly<{
        partition: import("../partition/partition.ts").Partition;
        epoch: number;
        position: bigint;
    }>[];
}>;
export declare function navigateHostedChapters(deps: HostedDependencies, catalogueId: string, input: HostedNavigationInput, context: ReadContext): Promise<{
    value: HostedPageView;
    anchors: Readonly<{
        partition: import("../partition/partition.ts").Partition;
        epoch: number;
        position: bigint;
    }>[];
}>;
export {};
