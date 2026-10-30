import type { Pool, PoolClient } from 'pg';
import { type WorkClient, type WorkIntent } from '../work/client.ts';
import { type CommandAuthorization, type PrincipalCommandIdentity } from './command.ts';
declare const operational: unique symbol;
export type OperationalTransaction = Pick<PoolClient, 'query'> & {
    readonly [operational]: true;
};
type CommonOptions = {
    partition: number;
    kind: string;
    accounts: readonly string[];
    workClient: WorkClient;
    deadline?: number;
    /** Trusted service configuration only. */
    clock?: () => Date;
};
export type OperationalOptions = CommonOptions & ((Extract<PrincipalCommandIdentity, {
    basis: {
        clientId: string;
    };
}> & {
    mode: 'request';
    authorization: CommandAuthorization;
}) | {
    mode: 'work-step';
    principal?: never;
    basis?: never;
    authorization?: never;
});
export declare function hasLiveOperationalTransaction(tx: Pick<PoolClient, 'query'>): tx is OperationalTransaction;
/** Input is a consumer-owned locator object, including the fenced accounts. */
export declare function enqueueIntent(tx: OperationalTransaction, intent: WorkIntent): Promise<void>;
/** Derived records and their DBOS intent commit together, without command effects. */
export declare function runOperationalTransaction<T>(pool: Pool, options: OperationalOptions, body: (tx: OperationalTransaction) => Promise<T>): Promise<T>;
export {};
