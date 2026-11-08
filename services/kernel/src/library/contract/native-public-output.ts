/** Library's native public output contract. This file is a dependency-free boundary for Semantic and adapters. */

import type { CollectionSourceRawKey, NativeOutputActivation, NativePublicOutputIdentity } from './source.ts';
import type { WorkAllowance, WorkReceipt } from './work-dimensions.ts';

export type { NativeOutputActivation, NativePublicOutputIdentity } from './source.ts';

export type NativePublicOutputReceipt = Readonly<{
  partition: number;
  epoch: number;
  position: bigint;
  transactionId: string;
}>;

export type NativePublicOutputStamp = Readonly<{
  partition: number;
  epoch: number;
  position: bigint;
}>;

export type NativePublicOutputPublication = Readonly<{
  generation: string;
  transactionId: string;
  position: string;
  nativeXid: string;
  sourceGeneration: string;
  memberFence: string;
  members: string;
}>;

export type NativePublicOutputRef = Readonly<{ route: number; collectionId: string; generation: string }>;

/** The exact SQL observation the custody adapter consumes; it conveys no disclosure or authorization. */
export type NativePublicOutputMetadata = Readonly<{
  curatorAccountId: string | null;
  incarnation: string;
  sourceGeneration: string;
  state: 'active' | 'deleted';
  membershipKind: 'curated' | 'dynamic';
  visibility: 'private' | 'unlisted' | 'public';
  authority: 'curated' | 'private_builtin' | 'activated_output' | 'unavailable_output';
  outputGeneration: string | null;
  outputPublication: NativePublicOutputPublication | null;
  stamp: NativePublicOutputStamp;
}>;

export type PublicOutputWork = Readonly<{ deadline: number; allowance: WorkAllowance }>;
export type PublicOutputCommandContext<PoolLike = unknown, Time = unknown> = PublicOutputWork &
  Readonly<{ pool: PoolLike; at: Time }>;

export type PublicOutputTuple = Readonly<{
  identity: NativePublicOutputIdentity;
  publication: NativePublicOutputPublication;
  observation: NativePublicOutputStamp;
}>;
export type PublicOutputRefusal = Readonly<{
  status: 'changed' | 'unavailable';
  dependency?: string;
  work: WorkReceipt;
}>;
export type NativePublicOutputBinding = Readonly<{
  captureId: string;
  holdId: string;
  definitionDigest: string;
  bindingDigest: string;
  tuple: PublicOutputTuple;
  accepted: NativePublicOutputReceipt;
}>;
export type PublicOutputBindingSelection = Readonly<{
  captureId: string;
  definitionDigest: string;
  publication: NativePublicOutputRef & Readonly<{ activation: NativeOutputActivation }>;
}>;
export type PublicOutputDispositionSelection = Readonly<{
  captureId: string;
  holdId: string;
  bindingDigest: string;
  disposition: NativePublicOutputReceipt;
}>;
export type PublicOutputReadOptions = PublicOutputWork &
  Readonly<{ after: CollectionSourceRawKey | null; limit: number }>;
export type PublicOutputPage =
  | PublicOutputRefusal
  | Readonly<{
      status: 'ready';
      tuple: PublicOutputTuple;
      rows: readonly CollectionSourceRawKey[];
      after: CollectionSourceRawKey | null;
      exhausted: boolean;
      work: WorkReceipt;
    }>;

export type LockedPublicOutputDisposition = Readonly<{
  status: 'locked';
  binding: NativePublicOutputBinding;
  disposition: NativePublicOutputReceipt;
  provenance: 'staged' | 'committed';
  work: WorkReceipt;
}> &
  (
    | Readonly<{
        kind: 'applied';
        purpose: 'identity-public-output-applied';
        manifestDigest: string;
        seal: NativePublicOutputReceipt;
        successorHoldId: string;
        transfer: NativePublicOutputReceipt;
      }>
    | Readonly<{
        kind: 'cancelled';
        purpose: 'identity-public-output-cancelled';
        cancellationEpoch: string;
        cancellation: NativePublicOutputReceipt;
      }>
  );

/** Supplied by Semantic. It must resolve persisted state on the same live command and never trust caller evidence. */
export type LockPublicOutputDisposition<Tx, PoolLike = unknown, Time = unknown> = (
  tx: Tx,
  selection: PublicOutputDispositionSelection,
  context: PublicOutputCommandContext<PoolLike, Time>,
) => Promise<PublicOutputRefusal | LockedPublicOutputDisposition>;

/** Supplied by Library composition; the actual query client and metered work stay on the native caller. */
export type ObserveNativePublicOutput<Client, Work> = (
  client: Client,
  ref: Readonly<{ route: number; collectionId: string }>,
  work: Work,
) => Promise<NativePublicOutputMetadata | null>;

export type NativePublicOutputApplication<Tx, PoolLike, Time> = Readonly<{
  readNativePublicCollectionOutput(
    pool: PoolLike,
    identity: NativePublicOutputIdentity,
    options: PublicOutputReadOptions,
  ): Promise<PublicOutputPage>;
  lockNativePublicCollectionOutput(
    tx: Tx,
    identity: NativePublicOutputIdentity,
    context: PublicOutputCommandContext<PoolLike, Time>,
  ): Promise<PublicOutputRefusal | Readonly<{ status: 'locked'; tuple: PublicOutputTuple; work: WorkReceipt }>>;
  bindAndHoldNativePublicCollectionOutput(
    tx: Tx,
    selection: PublicOutputBindingSelection,
    context: PublicOutputCommandContext<PoolLike, Time>,
  ): Promise<
    PublicOutputRefusal | Readonly<{ status: 'bound'; binding: NativePublicOutputBinding; work: WorkReceipt }>
  >;
  revalidateNativePublicCollectionOutputHold(
    tx: Tx,
    binding: NativePublicOutputBinding,
    context: PublicOutputCommandContext<PoolLike, Time>,
  ): Promise<
    PublicOutputRefusal | Readonly<{ status: 'locked'; binding: NativePublicOutputBinding; work: WorkReceipt }>
  >;
  transferNativePublicCollectionOutputHold(
    tx: Tx,
    selection: PublicOutputDispositionSelection,
    context: PublicOutputCommandContext<PoolLike, Time>,
  ): Promise<
    | PublicOutputRefusal
    | Readonly<{
        status: 'transferred';
        successorHoldId: string;
        transfer: NativePublicOutputReceipt;
        work: WorkReceipt;
      }>
  >;
  releaseNativePublicCollectionOutputHold(
    tx: Tx,
    selection: PublicOutputDispositionSelection,
    context: PublicOutputCommandContext<PoolLike, Time>,
  ): Promise<
    PublicOutputRefusal | Readonly<{ status: 'released'; release: NativePublicOutputReceipt; work: WorkReceipt }>
  >;
}>;
