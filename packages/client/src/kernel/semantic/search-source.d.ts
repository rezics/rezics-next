import type { ConceptStatementReader } from '../search/concept-browse-statements.ts';
export { indexedStatement } from './scope-leaf-selection.ts';
import { type SubjectCanonicalNames, type SubjectSourceKeyTraversal as SubjectSourceKeyPages } from './subject-source-key-pages.ts';
import { relationSource } from './search-relations.ts';
import type { Pool, PoolClient } from 'pg';
import type { SubjectSource } from '../search/source.ts';
import { type CommandTransaction } from '../command/command.ts';
import { readPartition, type Partition } from '../partition/partition.ts';
import type { IdentityJobRef } from './identity-epoch-contract.ts';
import type { PublicFilterCost, PublicFilterProjectionFrontier, PublicFilterProjectionPage, PublicFilterProjectionRequest, PublicFilterProjectionRetirement, PublicFilterSource, PublicFilterSourceFactory } from './public-filter-source-contract.ts';
export { readPartition };
/** Existing `read` id cap; a larger batch is refused before SQL. */
export declare const SEARCH_SOURCE_SUBJECT_BATCH = 256;
/** `current_facts` current-slot budget per Subject. */
export declare const SEARCH_SOURCE_CURRENT_SLOT_BUDGET = 512;
/** Global adoption selection cap per expanded slot. */
export declare const SEARCH_SOURCE_CURRENT_CANDIDATE_BUDGET = 32;
/** Current name/fact/visibility publication fence used by complete Search traversals. */
export declare const readSearchCanonicalGenerationSql = "SELECT last_value::text,is_called FROM semantic.search_canonical_generation";
export declare function readSearchCanonicalGeneration(pool: CommandTransaction): Promise<string>;
export declare function inSearchSnapshot<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T>;
export declare function subjectSource(pool: Pool, routeKey?: Uint8Array): SubjectSource & SubjectSourceKeyPages & {
    canonicalNames: SubjectCanonicalNames;
    conceptBrowse: ReturnType<typeof relationSource>['conceptBrowse'];
    readConceptStatements: ConceptStatementReader;
    readCompleteWorkLinks: NonNullable<SubjectSource['readCompleteWorkLinks']>;
};
/** Revalidate retained support using one released snapshot of the installed native Pool. */
export declare function prepareRetainedIdentitySourceProjections(config: Parameters<PublicFilterSourceFactory>[0], input: Readonly<{
    job: IdentityJobRef;
    original: string;
    terminal: string;
    release: string;
    originalSupport: PublicFilterProjectionFrontier | null;
    terminalSupport: PublicFilterProjectionFrontier | null;
    deadline: number;
    phase?: 'original' | 'terminal';
}>): Promise<((tx: CommandTransaction) => Promise<ReadonlyMap<number, Partition> | null>) | null>;
/** Resolve the exact admitted root on the native projection's Source snapshot. */
export declare function readIdentitySourceProjection(config: Parameters<PublicFilterSourceFactory>[0], source: PublicFilterSource, request: Omit<PublicFilterProjectionRequest, 'subject'> & {
    job: IdentityJobRef;
    original: string;
    terminal: string;
}): Promise<{
    status: 'projected';
    projection: Extract<PublicFilterProjectionPage, {
        status: 'progress' | 'complete';
    }> | null;
    cost: PublicFilterCost;
} | {
    status: 'changed' | 'unready' | 'unavailable';
    cost: PublicFilterCost;
    retirement?: PublicFilterProjectionRetirement;
}>;
