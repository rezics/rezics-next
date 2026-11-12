import type { ReadContext } from './model.ts';
import { type HostedDependencies, type HostedReadSelection, type HostedChildrenInput, type HostedNavigationInput, type HostedOccurrenceView, type HostedPageView, type HostedResolutionView } from './hosted-chapters-model.ts';
export declare function readHostedCatalogue(deps: HostedDependencies, catalogueId: string, selection: HostedReadSelection, context: ReadContext): Promise<{
    value: Readonly<{
        catalogueId: string;
        revisionId: string;
        kind: 'structure' | 'publication';
        sourceRevisionId: string | null;
    }>;
    anchors: Readonly<{
        partition: import("../partition/partition.ts").Partition;
        epoch: number;
        position: bigint;
    }>[];
}>;
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
export declare function navigateHostedChapters(deps: HostedDependencies, catalogueId: string, input: HostedNavigationInput, context: ReadContext): Promise<{
    value: HostedPageView;
    anchors: Readonly<{
        partition: import("../partition/partition.ts").Partition;
        epoch: number;
        position: bigint;
    }>[];
}>;
