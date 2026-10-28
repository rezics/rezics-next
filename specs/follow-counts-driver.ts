/**
 * FOLLOW_COUNTS_DRIVER is an absolute path/file URL exporting createFollowCountsDriver.
 * This is a TEST binding, not a production count adapter or permission implementation.
 * Each factory owns an isolated migrated database and real createKernel/Auth/Access.
 * request returns the original Response; do not normalize status, headers or JSON.
 * Fixtures/grants/roles/state changes use native commands, never raw grant SQL,
 * fake Access, modeled policies, in-memory counts or direct follow/projection writes.
 * Failed setup cleans up its resources; close never removes another worker's resources.
 *
 * Dispatch starts held. Captures park a REAL pending per-edge replacement after
 * its source client is released and before its first native target command. deliver
 * invokes native current-source reconciliation, then the target command: it never
 * retargets a saved positive. Revision comparison/count logic stays in native code.
 * Captures are opaque handles to pending native work, not a proposed kernel API.
 */
import type { FollowRow, FollowTargetType } from '../services/kernel/src/library/follow-model.ts';

export const FOLLOW_COUNTS_MISSING_DRIVER = 'Follow count outcome driver is required';
export const FOLLOW_COUNTS_ROUTES = {
  target: '/v1/followCounts/:targetType/:targetId',
  outgoing: '/v1/followCounts/outgoing',
} as const;
export type CountTarget = { targetId: string; targetType: FollowTargetType };
export type TargetCountDTO = CountTarget & { followerCount: number };
export type OutgoingCountDTO = { followingCount: number };
export type Credential = string; // actual bearer credential, not an asserted actor
export type Principal = { accountId: string; credential: Credential };
export type FixtureKind = 'collection' | 'space' | 'person' | 'automated' | 'organization' | 'ordinary';
export interface CountFixture {
  target: CountTarget;
  /** Resolved account id for account agents; intentionally different from targetId. */
  targetAccountId: string | null;
  manager: Principal;
  /** Native collection:update, installed Space manager role, or account:manage grant. */
  granted: Principal;
  follower: Principal;
  other: Principal;
  staff: Principal; // native staff authority without target management
  noScope: Principal;
  suspended: Principal;
  unknown: CountTarget;
}
export interface CountInspection {
  /** Actual native source row, including explicit-unfollow tombstones. */
  source: FollowRow | null;
  /** Persisted rows in stable key order; no synthesized expected counts/empty rows. */
  targetRows: { relation: string; row: unknown }[];
  effects: { transactionId: string; type: string; subject: string | null; data: unknown }[];
  /** Every count-owned payload/receipt/checkpoint; terminal purge must remove these. */
  privatePayloads: { relation: string; row: unknown }[];
  /** Minimal, payload-free terminal evidence; never a retained target directory. */
  terminalFences: { accountId: string }[];
}
export interface ReadTrace {
  /** Observed calls into native Access, not an expected/canned policy answer. */
  managementChecks: { action: string; resource: { route: number; id: string } }[];
  statements: number;
  examinedRows: number; // actual plan rows * loops, including filter removals
  sharedBlocks: number; // actual shared hit + read blocks, not elapsed time
  sequentialRelations: string[]; // exclude only tiny core metadata
}
export interface FollowCountsDriver {
  fixture(kind: FixtureKind): Promise<CountFixture>;
  request(credential: Credential | null, path: string, init?: RequestInit): Promise<Response>;
  /** Native grant/role revocation, retaining the same bearer credential. */
  revokeManagement(fixture: CountFixture): Promise<void>;
  /** Native lifecycle commands; deletion is irreversible, not a new cooling-off API. */
  accountState(accountId: string, state: 'active' | 'suspended' | 'deleted'): Promise<void>;
  reauthenticate(principal: Principal): Promise<Principal>;
  gate(open: boolean): Promise<void>;
  /** Create a different readable target and follow it with a native command. */
  additionalOutgoing(follower: Principal): Promise<CountTarget>;
  /** Real entry command that invokes followFromLibrary in its source transaction. */
  libraryFollow(follower: Principal, target: CountTarget): Promise<void>;
  /** Park real pending per-edge work after source release; no driver-owned snapshot. */
  capture(follower: Principal, target: CountTarget): Promise<string>;
  /** Reconcile current source eligibility natively before invoking the target command. */
  deliver(capture: string): Promise<void>;
  reconcile(follower: Principal, target: CountTarget): Promise<void>;
  /** Redeliver the actual terminal account-tombstoned event through its production consumer. */
  accountSignal(accountId: string): Promise<void>;
  /** Await the event-enqueued bounded Library erasure participant; no time advance/manual cleanup shortcut. */
  purge(accountId: string): Promise<{ pages: number; maxRows: number; complete: boolean }>;
  inspect(follower: Principal, target: CountTarget): Promise<CountInspection>;
  /** Fault actual dependency/maintenance readiness; never fabricate a response. */
  fault(state: 'access_unavailable' | 'projection_unready' | 'clear'): Promise<void>;
  /** Native SQL/outbox/search/notification inspection, not just response filtering. */
  publicArtifacts(): Promise<{ surface: string; value: unknown }[]>;
  /**
   * Cumulative 128*scale fixtures via native commands, scales 1,4,16. Fixed target
   * and reader. History = inactive follows of that reader; target_followers = live
   * OTHER accounts following this target. Other axes never follow this target.
   * Distinct physical source/target partitions, all partition numbers <4096.
   */
  seed(
    fixture: CountFixture,
    scale: number,
    axis: 'unrelated_followers' | 'unrelated_targets' | 'history' | 'target_followers',
  ): Promise<void>;
  measure<T>(read: () => Promise<T>): Promise<{ value: T; trace: ReadTrace }>;
  close(): Promise<void>;
}
