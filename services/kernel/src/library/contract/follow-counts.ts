import type { LibraryAccountActor, LibraryActor } from './actors.ts';

import type { FollowTargetType } from './follow-targets.ts';
export type { FollowTargetType } from './follow-targets.ts';
export type FollowCountTarget = Readonly<{ targetType: Exclude<FollowTargetType, 'zone'>; targetId: string }>;
export type CountKey = Readonly<{ targetType: FollowTargetType; targetId: string; accountId: string }>;
export type CountReplacement = CountKey & { revision: string; eligible: boolean };
export type CountDestination = Readonly<{ targetId: string; route: number; epoch: bigint | null }>;
export type FollowCountPage = Readonly<{ examined: number; complete: boolean }>;
export type FollowCountHealthObservation = Readonly<{
  sampledAt: string;
  oldestPendingAt: string | null;
  consumerObservedAt: string;
  consumerOldestPendingAt: string | null;
}>;

export class FollowCountUnavailableError extends Error {
  constructor(message = 'Private follow counts are not ready') {
    super(message);
    this.name = 'FollowCountUnavailableError';
  }
}
export class FollowCountTargetAbsentError extends Error {}
export class FollowCountReadRefusedError extends Error {
  constructor(readonly reason: 'authentication_required' | 'forbidden') {
    super(reason);
  }
}

/** Consumer-owned read operations. A native time stays opaque to the application and
 * is passed unchanged to every admission that uses it. No pool checkout lives here. */
export interface FollowCountReadPorts<Time> {
  route(id: string): number | null;
  authenticate(owner: LibraryAccountActor, deadline: number): Promise<Time>;
  health(): Promise<FollowCountHealthObservation>;
  within<T>(deadline: number, work: () => Promise<T>): Promise<T>;
  destination(target: FollowCountTarget): Promise<CountDestination>;
  subjectReadable(owner: LibraryAccountActor, id: string, time: Time): Promise<boolean>;
  accountForAgent(id: string): Promise<string | null>;
  collection(
    destination: CountDestination,
    deadline: number,
  ): Promise<Readonly<{
    state: string;
    visibility: string;
    curatorAccountId: string | null;
  }> | null>;
  accountState(id: string, deadline: number): Promise<string | null>;
  spaceExists(id: string, time: Time, deadline: number): Promise<boolean>;
  management(owner: LibraryAccountActor, action: string, id: string, time: Time, deadline: number): Promise<boolean>;
  total(destination: CountDestination, type: FollowTargetType, deadline: number): Promise<string | undefined>;
  outgoing(owner: LibraryAccountActor, deadline: number): Promise<string | undefined>;
}

export type FollowCountReads = Readonly<{
  target(
    actor: LibraryActor,
    target: FollowCountTarget,
    deadline: number,
  ): Promise<FollowCountTarget & { followerCount: number }>;
  outgoing(actor: LibraryActor, deadline: number): Promise<{ followingCount: number }>;
}>;

/** Source custody and native identity admission are retained by the adapters. */
export interface FollowCountDeliveryPorts {
  destination(key: CountKey): Promise<CountDestination>;
  reconcile(key: CountKey): Promise<CountReplacement | null>;
  stage(key: CountKey, replacement: CountReplacement, destination: CountDestination): Promise<boolean>;
  apply(replacement: CountReplacement, destination: CountDestination): Promise<unknown>;
  acknowledge(replacement: CountReplacement): Promise<unknown>;
}

export interface FollowCountPartitionPorts {
  targets(partition: number): Promise<FollowCountPage>;
  discover(partition: number): Promise<FollowCountPage>;
  owner(partition: number): Promise<FollowCountPage>;
  accountKey(partition: number): Promise<string | null>;
  accountPage(accountId: string): Promise<FollowCountPage>;
  pending(partition: number): Promise<readonly CountKey[]>;
  deliver(key: CountKey): Promise<void>;
  sample(partition: number): Promise<void>;
}

/** Native handles are borrowed intact at this adapter boundary. Composition chooses
 * the producers; neither application nor compatibility entries import their implementations. */
export interface FollowCountRuntime {
  reads(pool: object, access: object): FollowCountReads;
  destination(pool: object, target: Pick<CountKey, 'targetType' | 'targetId'>): Promise<CountDestination>;
  admitIdentity(tx: object, input: Readonly<{ original: string; terminal: string; epoch: bigint }>): Promise<void>;
  validAccountEvent(type: (typeof FOLLOW_COUNT_ACCOUNT_EVENTS)[number], data: unknown): boolean;
}

export const FOLLOW_COUNT_ACCOUNT_EVENTS = [
  'com.rezics.access.account.suspended.v1',
  'com.rezics.access.account.reinstated.v1',
  'com.rezics.access.operator.subject-fenced.v1',
  'com.rezics.access.operator.subject-unfenced.v1',
] as const;
