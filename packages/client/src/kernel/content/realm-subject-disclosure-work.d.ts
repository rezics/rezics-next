import type { QueryResultRow } from 'pg';
import type { AccessClient } from '../request/access.ts';
import type { AccessWorkAccounting } from '../access/work.ts';
import type { ReadContext } from './model.ts';
import type { Partition } from '../partition/partition.ts';
/** Optional only inside the existing readers; the population seam requires a root. */
export type RealmSubjectReadContext = ReadContext & {
    readonly work?: AccessWorkAccounting;
};
export declare function bindRealmSubjectReadWork(client: AccessClient, work?: AccessWorkAccounting): void;
export declare function realmSubjectReadRoot(client: AccessClient): AccessWorkAccounting | undefined;
/** Each declaration describes an explicit finite point plan, never SQL-text inference.
 * Rows include intermediate unique joins, even for an empty result. Dispatched
 * native rows cannot be refunded. Bytes and empty seeks use this invocation's result.
 */
export declare function realmSubjectPoint<R extends QueryResultRow>(client: AccessClient, operation: string, parameters: readonly unknown[], dispatch: () => Promise<{
    rows: R[];
}>, plan: Readonly<{
    keys: number;
    rows: number;
    bytes: number;
}>): Promise<{
    rows: R[];
}>;
/** read-chain metadata only. A revision has <=128 subject/media identities;
 * review citations and licences are bounded by the native revision contract.
 * The 64 KiB envelope includes JSON escaping, digest, citation and those arrays.
 * A payload exceeding the declaration makes evidence unknown, never undercharged.
 */
export declare function realmSubjectContentPoint<R extends QueryResultRow>(client: AccessClient, kind: string, parameters: readonly unknown[], dispatch: () => Promise<{
    rows: R[];
}>): Promise<{
    rows: R[];
}>;
/** One checkout, BEGIN and a precharged cleanup slot. The slot remains charged
 * on failure/deadline, so rollback can release the original connection even when
 * no further work admission is possible. COMMIT is separately debited below.
 */
export declare function realmSubjectBegin(client: AccessClient, dispatched: () => void): Promise<void>;
export declare function realmSubjectCommit(client: AccessClient): Promise<void>;
/** Avoid generated run() catalogue preparation inside an admitted point plan. */
export declare function realmSubjectPartition(client: AccessClient, partitionNo: number): Promise<Partition | null>;
