import type { AccessClient } from '../request/access.ts';
import type { SummaryReaderDependencies, SubjectSummary } from '../semantic/summaries.ts';
import type { CollectionDiscoveryContext, CollectionCurator } from './contract/index.ts';
export type { CollectionDiscoveryContext, CollectionCurator, CollectionPreview, CollectionPreviewMember, } from './contract/index.ts';
export declare const COLLECTION_PREVIEW_SIZE = 3;
export declare const COLLECTION_PREVIEW_EXAMINED: number;
export type DiscoveryMemberKey = Readonly<{
    id: string;
    subjectId: string;
}>;
export type ContextSource = Readonly<{
    id: string;
    route: number;
    curatorAccountId: string | null;
    membershipKind: string;
    outputGeneration: string | null;
}>;
export type CollectionDiscoveryContextFilters = Readonly<{
    subjectId?: string;
    curatorAccountId?: string;
}>;
/** Two input-bounded statements, each with an indexed lateral LIMIT 4 per full Collection key.
 * Curated occurrences keep their native order; dynamic rows use only the selected published output.
 */
export declare function readDiscoveryMemberKeys(client: AccessClient, sources: readonly ContextSource[]): Promise<ReadonlyMap<string, readonly DiscoveryMemberKey[]>>;
/** Indexed exact-Subject probes for a query operand; this never reads or materializes a Collection's members. */
export declare function readDiscoverySubjectMembership(client: AccessClient, sources: readonly ContextSource[], subjectId: string): Promise<ReadonlyMap<string, boolean>>;
/** Withhold optional context if the native foreign projection is not installed. */
export declare function prepareCollectionDiscoveryContext(dependencies: Omit<SummaryReaderDependencies, 'actor'> | null, sources: readonly ContextSource[], members: ReadonlyMap<string, readonly DiscoveryMemberKey[]>, languages?: readonly string[], filters?: CollectionDiscoveryContextFilters): Promise<Readonly<{
    values: ReadonlyMap<string, CollectionDiscoveryContext>;
    queryCurator?: CollectionCurator | null;
    querySubject?: SubjectSummary | null;
    observation: string;
    current: () => Promise<boolean>;
}>>;
