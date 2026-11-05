/** Proposed native ports; only the two pure helpers implement behavior. See listing-freshness-contract.md. */
import type { Pool } from 'pg';
import type { CommandEvent, CommandTransaction } from '../command/command.ts';

export interface ListingStamp {
  readonly partition: number;
  readonly epoch: number;
  readonly position: bigint;
}

/** Positions are local to an immutable source partition, never UUID/time ordered. */
export function compareListingStamp(a: ListingStamp, b: ListingStamp): -1 | 0 | 1 {
  if (a.partition !== b.partition) throw new Error('Cannot compare listing stamps from different source partitions');
  if (a.epoch !== b.epoch) return a.epoch < b.epoch ? -1 : 1;
  return a.position < b.position ? -1 : a.position > b.position ? 1 : 0;
}

export interface ListingPublicHistory {
  readonly currentlyPublic: boolean;
  readonly everPublic: boolean;
  readonly knownPublicPair: boolean;
}

/** Public-history evidence is required even for a zero version or Collection fence. */
export function mayRetainListingVersion(history: ListingPublicHistory): boolean {
  return history.currentlyPublic || history.everPublic || history.knownPublicPair;
}

export interface ListingKey {
  readonly subjectId: string;
  readonly collectionId: string;
}

/** Trusted, released source snapshot, not a request payload or disclosure authority. */
export interface ListingObservation extends ListingKey {
  readonly collectionRoute: number;
  readonly stamp: ListingStamp;
  readonly multiplicity: number;
  readonly currentlyPublic: boolean;
  readonly everPublic: boolean;
}

export interface ListingVersion extends ListingKey {
  readonly collectionRoute: number;
  readonly stamp: ListingStamp;
  readonly multiplicity: number; // zero is a retained ordering tombstone
}

/** Per-Collection zero fence at one target partition; contains no private holder identities. */
export interface ListingSourceFence {
  readonly collectionId: string;
  readonly collectionRoute: number;
  readonly stamp: ListingStamp;
}

export type ListingApplyResult = {
  readonly status: 'applied' | 'stale' | 'duplicate' | 'unretained';
  readonly projectionChanged: boolean;
  readonly events: readonly CommandEvent[];
};

/** Source producer hook, inside the Collection command before commit; never clears provenance. */
export async function recordListingPublicHistory(
  _tx: CommandTransaction,
  _input: { collectionId: string; collectionRoute: number; publicBefore: boolean; publicAfter: boolean },
): Promise<void> {
  throw new Error('Listing public-history producer is not implemented');
}

/** readPartition and Collection/member truth use ONE authoritative RR client, released before return. */
export async function observeListingSource(_pool: Pool, _key: ListingKey): Promise<ListingObservation> {
  throw new Error('Listing source observation is not implemented');
}

/** Caller owns the subject runCommand; version, pair, aggregate and outbox commit together. */
export async function applyListingObservation(
  _tx: CommandTransaction,
  _input: { targetRoute: number; observation: ListingObservation; time: string; transactionId: string },
): Promise<ListingApplyResult> {
  throw new Error('Monotonic listing apply is not implemented');
}

/** Purge must prove public history and source terminal zero before installing this fence. */
export async function fenceListingSource(
  _tx: CommandTransaction,
  _input: { targetPartition: number; fence: ListingSourceFence; everPublic: true },
): Promise<void> {
  throw new Error('Listing source fence is not implemented');
}
