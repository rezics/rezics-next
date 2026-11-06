import type { Pool } from 'pg';
import { type CommandTransaction } from '../command/command.ts';
import { type CanonicalRangeKey } from './collection-source-native.ts';
import type { NativePublicOutputIdentity } from './native-source-output-types.ts';
import type { NativePublicOutputBinding, PublicOutputBindingSelection, PublicOutputCommandContext, PublicOutputDispositionSelection, PublicOutputPage, PublicOutputRefusal, PublicOutputTuple, PublicOutputWork } from './native-public-output-contract.ts';
/** One public RR snapshot contains observation, committed native binding and the entire raw page. */
export declare function readNativePublicCollectionOutput(pool: Pool, identity: NativePublicOutputIdentity, options: PublicOutputWork & Readonly<{
    after: CanonicalRangeKey | null;
    limit: number;
}>): Promise<PublicOutputPage>;
export declare function lockNativePublicCollectionOutput(tx: CommandTransaction, identity: NativePublicOutputIdentity, context: PublicOutputCommandContext): Promise<PublicOutputRefusal | Readonly<{
    status: 'locked';
    tuple: PublicOutputTuple;
    work: import('./contract/work-dimensions.ts').WorkReceipt;
}>>;
export declare function bindAndHoldNativePublicCollectionOutput(tx: CommandTransaction, selection: PublicOutputBindingSelection, context: PublicOutputCommandContext): Promise<PublicOutputRefusal | Readonly<{
    status: 'bound';
    binding: NativePublicOutputBinding;
    work: import('./contract/work-dimensions.ts').WorkReceipt;
}>>;
export declare function revalidateNativePublicCollectionOutputHold(tx: CommandTransaction, binding: NativePublicOutputBinding, context: PublicOutputCommandContext): Promise<PublicOutputRefusal | Readonly<{
    status: 'locked';
    binding: NativePublicOutputBinding;
    work: import('./contract/work-dimensions.ts').WorkReceipt;
}>>;
export declare function transferNativePublicCollectionOutputHold(tx: CommandTransaction, selection: PublicOutputDispositionSelection, context: PublicOutputCommandContext): Promise<Readonly<{
    status: 'changed' | 'unavailable';
    dependency?: string;
    work: import("./contract/work-dimensions.ts").WorkReceipt;
}> | {
    status: 'transferred';
    successorHoldId: string;
    transfer: Readonly<{
        partition: number;
        epoch: number;
        position: bigint;
        transactionId: string;
    }>;
    work: import("./contract/work-dimensions.ts").WorkReceipt;
    release?: never;
}>;
export declare function releaseNativePublicCollectionOutputHold(tx: CommandTransaction, selection: PublicOutputDispositionSelection, context: PublicOutputCommandContext): Promise<Readonly<{
    status: 'changed' | 'unavailable';
    dependency?: string;
    work: import("./contract/work-dimensions.ts").WorkReceipt;
}> | {
    successorHoldId?: never;
    transfer?: never;
    status: 'released';
    release: Readonly<{
        partition: number;
        epoch: number;
        position: bigint;
        transactionId: string;
    }>;
    work: import("./contract/work-dimensions.ts").WorkReceipt;
}>;
