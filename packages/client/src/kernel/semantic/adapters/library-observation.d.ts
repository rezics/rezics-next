/** Native SQL, parameter order and finite projections for Library's observations. */
import type { Pool, PoolClient } from 'pg';
import type { WorkDimensions } from '../../library/contract/work-dimensions.ts';
import type { LibrarySemanticMapping, LibrarySemanticScopeObservation, LibrarySemanticScopeRegistration, LibrarySemanticScopeRevalidation, LibrarySemanticSummaryObservation } from '../../library/contract/semantic-observation.ts';
import { type SummaryReaderDependencies } from '../summaries.ts';
import type { LibrarySemanticScopeResult } from '../../library/contract/semantic-observation.ts';
export type SemanticObservationNativeAdapter = Readonly<{
    canonical: Readonly<{
        mappingWork(originals: readonly string[]): WorkDimensions;
        scopeCommitWork(input: {
            route: number;
            collectionId: string;
            sourceFence: string;
            observation: LibrarySemanticScopeObservation;
        }): WorkDimensions;
        readMappings(pool: Pool, originals: readonly string[]): Promise<readonly LibrarySemanticMapping[]>;
        registerScope(pool: Pool, input: LibrarySemanticScopeRegistration): Promise<LibrarySemanticScopeResult>;
        revalidateScope(pool: Pool, input: LibrarySemanticScopeRevalidation): Promise<LibrarySemanticScopeResult>;
        commitScopeCapture(client: Pick<PoolClient, 'query'>, input: {
            route: number;
            collectionId: string;
            sourceFence: string;
            observation: LibrarySemanticScopeObservation;
        }): Promise<void>;
    }>;
    follow: Readonly<{
        mappingWork(originals: readonly string[]): WorkDimensions;
        subjectReferenceWork(subjectId: string): WorkDimensions;
        subjectSummaryWork(subjectIds: readonly string[]): WorkDimensions;
        subjectSummaryCurrentWork(subjectIds: readonly string[]): WorkDimensions;
        readMapping(pool: Pool, original: string): Promise<LibrarySemanticMapping>;
        readMappings(pool: Pool, originals: readonly string[]): Promise<readonly LibrarySemanticMapping[]>;
        readSubjectReference(input: {
            pool: Pool;
            subjectId: string;
            check(client: Pick<PoolClient, 'query'>): Promise<boolean>;
        }): Promise<Readonly<{
            state: 'present';
        } | {
            state: 'absent';
        } | {
            state: 'redirect';
            from: string;
            to: string;
        }>>;
        observeSubjects(input: {
            context: SummaryReaderDependencies;
            ids: readonly string[];
        }): Promise<Omit<LibrarySemanticSummaryObservation, 'current'> & Readonly<{
            current(): Promise<boolean>;
        }>>;
    }>;
    shelf: Readonly<{
        identityVersionWork(subjectId: string): WorkDimensions;
        itemTypesWork(subjectIds: readonly string[], maxTypeBytes?: number): WorkDimensions;
        readIdentityVersion(client: Pick<PoolClient, 'query'>, subjectId: string): Promise<{
            revision: number;
            transactionId: string;
            redirect: string | null;
        } | null>;
        readItemTypes(client: Pick<PoolClient, 'query'>, subjectIds: readonly string[]): Promise<ReadonlyMap<string, string>>;
    }>;
}>;
export declare function createNativeLibraryObservationAdapter(): SemanticObservationNativeAdapter;
