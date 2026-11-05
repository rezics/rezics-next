import type { AuthErasureObligation, AuthErasureObligationPoint } from './auth-erasure-obligations.ts';

/** Trusted composition supplies the actual restored Auth generation and verified inventory
 * binding. These identifiers bind a receiver; they are not physical receiving evidence. */
export type AuthErasureLiveReceiver = Readonly<{
  authGeneration: string;
  databaseIdentity: string;
  inventoryEntry: string;
  inventoryVersion: string;
  cutId: string;
}>;
/** Native ordinal continuation, starting at the original finite partition high water.
 * Tail-end retains this cursor so the same subscription can observe later commits. */
export type AuthErasureLiveCursor = Readonly<{ partition: number; afterOrdinal: string }>;
export type AuthErasureLivePendingReason =
  | 'receiver-unavailable'
  | 'cut-unavailable'
  | 'source-unavailable'
  | 'tail-unavailable'
  | 'original-floor-unavailable';
export type AuthErasureLiveObservation = Readonly<{
  receiver: AuthErasureLiveReceiver;
  partition: number;
  sourceGeneration: string | null;
  sourceEpoch: number | null;
  sourceOwner: string | null;
  highWater: string | null;
  armHighWater: string | null;
  enrolledThrough: string | null;
}>;
export type AuthErasureLivePartition = AuthErasureLiveObservation &
  (Readonly<{ state: 'armed' }> | Readonly<{ state: 'pending'; reason: AuthErasureLivePendingReason }>);
export type AuthErasureLiveVerification = AuthErasureLiveObservation &
  (Readonly<{ state: 'current' }> | Readonly<{ state: 'pending'; reason: AuthErasureLivePendingReason }>);
export type AuthErasureLivePage = Readonly<{
  partition: AuthErasureLiveVerification;
  cursor: AuthErasureLiveCursor;
  obligations: readonly AuthErasureObligation[];
  pending: readonly Extract<AuthErasureObligationPoint, { state: 'pending' }>[];
  /** Always retained, including at tail-end. There is no ACK or consumption capability. */
  next: AuthErasureLiveCursor;
  state: 'page' | 'tail-end' | 'pending';
}>;
/** Additive, closed native capability bound once by trusted composition. All deadlines
 * are absolute Unix milliseconds. Current means durable Source enrollment, never Auth
 * consumption, restore admission, backup/tail custody or final erasure completion. */
export type AuthErasureLivePorts = {
  /** Idempotent for the exact original receiver binding; never a delivery receipt. */
  armAuthErasureLivePartition(input: { partition: number; deadline: number }): Promise<AuthErasureLivePartition>;
  readAuthErasureLivePage(input: { cursor: AuthErasureLiveCursor; deadline: number }): Promise<AuthErasureLivePage>;
  /** Rechecks durable enrollment and native lineage independently of page consumption. */
  verifyAuthErasureLivePartition(input: { partition: number; deadline: number }): Promise<AuthErasureLiveVerification>;
};
