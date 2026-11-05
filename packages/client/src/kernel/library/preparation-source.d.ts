import type { Pool } from 'pg';
export interface PreparationSourceExecution {
    transaction<T>(read: () => Promise<T>): Promise<T>;
    read<T>(client: import('pg').PoolClient, subjectId: string, full: boolean, read: () => Promise<T>): Promise<T>;
}
type PreparationSourceContext = {
    pool: Pool;
    deadline?: number | undefined;
    execution?: PreparationSourceExecution;
};
export declare function observePreparationSource(context: PreparationSourceContext, subjectId: string): Promise<{
    stamp: {
        partition: number;
        epoch: number;
        position: bigint;
    };
    identity: {
        revision: number;
        transactionId: string;
        redirect: string | null;
        sourceId: string;
        partition: number;
        epoch: number;
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
        revision: number;
        transactionId: string;
        redirect: string | null;
        sourceId: string;
        partition: number;
        epoch: number;
    } | null;
}>;
export {};
