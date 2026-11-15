import type { AnchoredPosition, ReadContext } from './model.ts';
import type { HostedPointSelectionReads } from './hosted-publication-point-selection.ts';
import { type HostedBodyLanguageQuery } from './hosted-chapter-languages.ts';
import { type HostedDependencies, type HostedReadSelection, type HostedChildrenInput, type HostedNavigationInput, type HostedOccurrenceView, type OrderedHostedPlacement, type HostedPageView, type HostedResolutionView } from './hosted-chapters-model.ts';
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
/** Shared catalogue/occurrence admission for language metadata and body resolution. */
export declare function readHostedOccurrenceSelection(deps: HostedDependencies, catalogueId: string, occurrenceId: string, selection: HostedReadSelection, context: ReadContext): Promise<{
    selected: {
        route: number;
        epoch: number;
        view: Readonly<{
            catalogueId: string;
            revisionId: string;
            kind: 'structure' | 'publication';
            sourceRevisionId: string | null;
        }>;
        finish: () => Promise<{
            anchor: Readonly<{
                partition: import("../partition/partition.ts").Partition;
                epoch: number;
                position: bigint;
            }>;
            post: Readonly<{
                id: string;
                threadId: string;
                revisionId: string;
                authorId: string;
                licence: string;
                sha256: string;
                visibility: import("./model.ts").Visibility;
                kind: 'discussion' | 'review';
                documentKind: 'opening' | 'reply';
                title: string | null;
                subjectIds: readonly string[];
            }>;
        }>;
    };
    placement: OrderedHostedPlacement;
    anchor: Readonly<{
        partition: import("../partition/partition.ts").Partition;
        epoch: number;
        position: bigint;
    }>;
}>;
/** Snapshot-bound readers for one publication point command. Each lookup names
 * only its expected immutable version and requested occurrence; compatibility
 * manifests are deliberately not expanded into an ordered candidate here. */
export declare function hostedPublicationPointSelectionReads(deps: HostedDependencies, catalogueId: string, context: ReadContext): HostedPointSelectionReads;
export declare function resolveHostedOccurrence(deps: HostedDependencies, catalogueId: string, occurrenceId: string, selection: HostedReadSelection & HostedBodyLanguageQuery, context: ReadContext): Promise<{
    value: HostedResolutionView;
    anchors: Readonly<{
        partition: import("../partition/partition.ts").Partition;
        epoch: number;
        position: bigint;
    }>[];
}>;
/** Explicit body-address endpoint adds the actual selected language without changing ordinary resolution. */
export declare function resolveHostedOccurrenceBody(deps: HostedDependencies, catalogueId: string, occurrenceId: string, selection: HostedReadSelection & HostedBodyLanguageQuery, context: ReadContext): Promise<{
    anchors: Readonly<{
        partition: import("../partition/partition.ts").Partition;
        epoch: number;
        position: bigint;
    }>[];
    value: {
        catalogueId: string;
        revisionId: string;
        kind: 'structure' | 'publication';
        sourceRevisionId: string | null;
        occurrence: HostedOccurrenceView;
        document: Readonly<{
            encoding: 'base64';
            canonicalBytes: string;
            sha256: string;
            authorId: string;
            licence: string;
        }> | null;
        selectedLanguage: string | null;
    };
}>;
/** Resolve the same historical occurrence and current Access as exact opening,
 * but disclose target metadata without selecting or serializing chapter bytes. */
export declare function resolveHostedOccurrenceMetadata(deps: HostedDependencies, catalogueId: string, occurrenceId: string, selection: HostedReadSelection & HostedBodyLanguageQuery, context: ReadContext): Promise<{
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
type HostedChapterPlacement = Extract<OrderedHostedPlacement, {
    kind: 'chapter';
}>;
type HostedPageTargetGuard = Readonly<{
    final(): Promise<Readonly<{
        anchor: AnchoredPosition;
    }> | null>;
}>;
/** Prepare and close a page's target observations while keeping the I/O
 * strategy injectable for focused bounded-work tests. Ordinary targets share
 * one observation by full identity; private fallback remains occurrence-bound. */
export declare function discloseHostedPageTargets(placements: readonly OrderedHostedPlacement[], prepareOrdinary: (target: HostedChapterPlacement['target']) => Promise<HostedPageTargetGuard | null>, prepareScoped?: (placement: HostedChapterPlacement) => Promise<HostedPageTargetGuard | null>): Promise<ReadonlyMap<string, AnchoredPosition | null>>;
export {};
