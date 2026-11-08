import type { Pool, PoolClient } from 'pg';
import type { LibrarySemanticObservationCapability } from './contract/semantic-observation.ts';
import type { WorkDimensions } from './contract/work-dimensions.ts';
export type PreparationSourceRead<T> = Readonly<{
    value: T;
    semanticWork: WorkDimensions;
}>;
export interface PreparationSourceExecution {
    transaction<T>(read: () => Promise<T>): Promise<T>;
    read<T>(client: PoolClient, subjectId: string, full: boolean, observations: LibrarySemanticObservationCapability, read: (maxTypeBytes: number) => Promise<PreparationSourceRead<T>>): Promise<PreparationSourceRead<T>>;
}
type PreparationSourceContext = {
    pool: Pool;
    deadline?: number | undefined;
    execution?: PreparationSourceExecution;
    semanticObservations?: LibrarySemanticObservationCapability;
};
export declare function observePreparationSource(context: PreparationSourceContext, subjectId: string): Promise<{
    stamp: {
        partition: number;
        epoch: number;
        position: bigint;
    };
    identity: {
        sourceId: string;
        partition: number;
        epoch: number;
        revision: number;
        transactionId: string;
        redirect: string | null;
    } | null;
    type: string | null;
}>;
export declare function observePreparationIdentity(context: PreparationSourceContext, subjectId: string): Promise<{
    stamp: {
        partition: number;
        epoch: number;
        position: bigint;
    };
    identity: {
        sourceId: string;
        partition: number;
        epoch: number;
        revision: number;
        transactionId: string;
        redirect: string | null;
    } | null;
}>;
export {};
