import type { ReadContext } from './model.ts';
import type { AccessClient } from '../request/access.ts';
import { type HostedChapterTarget, type HostedDependencies, type HostedReadSelection, type HostedRevisionView, type OrderedHostedPlacement } from './hosted-chapters-model.ts';
export type HostedBodyLanguageQuery = Readonly<{
    language?: string;
    preferredLanguages?: string;
    targetPostId?: string;
    targetRevisionId?: string;
    targetSha256?: string;
}>;
type Chapter = Extract<OrderedHostedPlacement, {
    kind: 'chapter';
}>;
export type HostedSelectedBody = Chapter & Readonly<{
    selectedLanguage: string | null;
}>;
export declare function hostedLanguageQuery(query: HostedBodyLanguageQuery): {
    preferred: readonly string[];
    exact: boolean;
};
/** Selection is metadata-only. A pinned body never substitutes another language or revision. */
export declare function selectHostedChapterBody(deps: HostedDependencies, view: HostedRevisionView, chapter: Chapter, query: HostedBodyLanguageQuery, context: ReadContext): Promise<HostedSelectedBody | null>;
/** One frozen raw key page, sparse current disclosure, no body hydration or lifetime language cap. */
export declare function listHostedChapterLanguages(deps: HostedDependencies, catalogueId: string, occurrenceId: string, selection: HostedReadSelection & Readonly<{
    limit?: number;
    cursor?: string;
}>, context: ReadContext): Promise<{
    value: {
        catalogueId: string;
        revisionId: string;
        kind: 'structure' | 'publication';
        sourceRevisionId: string | null;
        occurrenceId: string;
        items: {
            language: string;
            title: string;
            target: HostedChapterTarget;
            isDefault: boolean;
        }[];
        nextCursor: string | null;
    };
    anchors: Readonly<{
        partition: import("../partition/partition.ts").Partition;
        epoch: number;
        position: bigint;
    }>[];
}>;
/** Direct calls count every raw alternative key in the existing request work budget.
 * Larger immutable selections continue through the prepared release path. */
export type HostedLanguageSnapshotRow = Readonly<{
    occurrenceId: string;
    language: string;
    firstVersion: string;
    title: string;
    target: HostedChapterTarget;
}>;
export declare function prepareHostedChapterLanguageRows(deps: HostedDependencies, catalogueId: string, placements: readonly OrderedHostedPlacement[], context: ReadContext, maximum: number): Promise<Readonly<{
    placements: readonly OrderedHostedPlacement[];
    rows: readonly HostedLanguageSnapshotRow[];
}>>;
/** A full explicit outline replacement keeps language associations on surviving logical chapters.
 * Only the caller's bounded occurrence set is read; no retained outline or language population is scanned. */
export declare function retainHostedChapterLanguageAssociations(deps: HostedDependencies, catalogueId: string, revisionId: string, placements: readonly OrderedHostedPlacement[], context: ReadContext): Promise<readonly OrderedHostedPlacement[]>;
export declare function freezeHostedChapterLanguageNamespaces(placements: readonly OrderedHostedPlacement[], namespaceId: string): readonly OrderedHostedPlacement[];
/** Only explicitly selected metadata is copied. The direct request bound is checked before this transaction. */
export declare function commitHostedChapterLanguageNamespace(tx: AccessClient, catalogueId: string, namespaceId: string, publicationId: string, rows: readonly HostedLanguageSnapshotRow[]): Promise<void>;
export {};
