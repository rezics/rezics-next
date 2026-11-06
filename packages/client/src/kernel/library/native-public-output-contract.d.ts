import type { Pool } from 'pg';
import type { AuthoritativeTime, CommandTransaction } from '../command/command.ts';
import type { IdentityNativeReceipt } from '../semantic/identity-epoch-contract.ts';
import type { CanonicalRangeKey } from './collection-source-native.ts';
import type { CollectionOutputPublication, CollectionOutputRef } from './collection-source-output.ts';
import type { WorkAllowance, WorkReceipt } from './collection-source.ts';
import type { ListingStamp } from './listing-freshness-contract.ts';
import type { NativeOutputActivation, NativePublicOutputIdentity } from './native-source-output-types.ts';
/** Truthful original-command outcomes for an activated public Collection output.
 * `ready` is current membership from a retained hold. `locked`/`bound` are retained original custody.
 * Transfer and release are distinct native results. `changed` and `unavailable` refuse current admission
 * without manufacturing an empty page or erasing committed custody. A JSON binding is not authority.
 */
export type PublicOutputWork = Readonly<{
    deadline: number;
    allowance: WorkAllowance;
}>;
export type PublicOutputCommandContext = PublicOutputWork & Readonly<{
    pool: Pool;
    at: AuthoritativeTime;
}>;
export type PublicOutputTuple = Readonly<{
    identity: NativePublicOutputIdentity;
    publication: CollectionOutputPublication;
    observation: ListingStamp;
}>;
export type PublicOutputRefusal = Readonly<{
    status: 'changed' | 'unavailable';
    /** An absent owner operand, rather than an assertion that custody was disposed. */
    dependency?: string;
    work: WorkReceipt;
}>;
export type NativePublicOutputBinding = Readonly<{
    captureId: string;
    holdId: string;
    definitionDigest: string;
    bindingDigest: string;
    tuple: PublicOutputTuple;
    accepted: IdentityNativeReceipt;
}>;
export type PublicOutputBindingSelection = Readonly<{
    captureId: string;
    definitionDigest: string;
    publication: CollectionOutputRef & Readonly<{
        activation: NativeOutputActivation;
    }>;
}>;
export type PublicOutputDispositionSelection = Readonly<{
    captureId: string;
    holdId: string;
    bindingDigest: string;
    disposition: IdentityNativeReceipt;
}>;
export type PublicOutputPage = PublicOutputRefusal | Readonly<{
    status: 'ready';
    tuple: PublicOutputTuple;
    rows: readonly CanonicalRangeKey[];
    after: CanonicalRangeKey | null;
    exhausted: boolean;
    work: WorkReceipt;
}>;
/** Native receiving operands consumed ONLY from the Semantic persisted-record lock.
 * The runtime resolves the owning validator on the original command, never caller proof.
 * That validator resolves genuine closure of all enrolled receiving/writer obligations.
 */
export type LockedPublicOutputDisposition = Readonly<{
    status: 'locked';
    binding: NativePublicOutputBinding;
    disposition: IdentityNativeReceipt;
    provenance: 'staged' | 'committed';
    work: WorkReceipt;
}> & (Readonly<{
    kind: 'applied';
    purpose: 'identity-public-output-applied';
    manifestDigest: string;
    seal: IdentityNativeReceipt;
    successorHoldId: string;
    transfer: IdentityNativeReceipt;
}> | Readonly<{
    kind: 'cancelled';
    purpose: 'identity-public-output-cancelled';
    cancellationEpoch: string;
    cancellation: IdentityNativeReceipt;
}>);
export type LockPublicOutputDisposition = (tx: CommandTransaction, selection: PublicOutputDispositionSelection, context: PublicOutputCommandContext) => Promise<PublicOutputRefusal | LockedPublicOutputDisposition>;
