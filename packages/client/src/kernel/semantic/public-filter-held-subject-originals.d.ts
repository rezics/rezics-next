import type { PoolClient } from 'pg';
export type HeldSubjectOriginal = Readonly<{
    route: number;
    id: string;
}>;
/** Resolve the saved owner and its raw Subject keys in one primary snapshot.
 * A successful empty seek still returns the immutable cut's receipt.
 */
export declare function readHeldSubjectOriginals(db: Pick<PoolClient, 'query'>, input: Readonly<{
    bootstrap: string;
    birth: string;
    partition: number;
    after: HeldSubjectOriginal | null;
    inputLimit: number;
}>, context: Readonly<{
    deadline: number;
}>, retained?: Readonly<{
    key: HeldSubjectOriginal | null;
    commandHead: string;
}>): Promise<{
    epoch: number;
    receipt: string;
    commandHead: string;
    originals: Readonly<{
        route: number;
        id: string;
    }>[];
    complete: boolean;
}>;
export declare const heldRepairHomes = 32;
export declare function readHeldRepairHomes(db: Pick<PoolClient, 'query'>, input: Readonly<{
    bootstrap: string;
    birth: string;
    partition: number;
    limit: number;
    after: HeldSubjectOriginal | null;
    inventory: boolean;
}>, context: Readonly<{
    deadline: number;
}>, retained?: Readonly<{
    heads: readonly string[];
    key: HeldSubjectOriginal | null;
}>, meter?: {
    inputKeys: number;
    rows: number;
    dependencyPoints: number;
}): Promise<{
    partition: number;
    epoch: number;
    receipt: string;
    base: string;
    head: string;
    route: number | null;
    id: string | null;
}[]>;
