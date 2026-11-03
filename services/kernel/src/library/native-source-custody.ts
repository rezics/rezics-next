import {
  nativeIdentityPartitionQuery,
  isNativeIdentitySourceBasisSQL,
  nativeIdentitySourceBasisFootprint,
} from './identity-native-planner-selected-pricing.ts';
import type { Pool, QueryResultRow } from 'pg';
import type { KernelClock } from '../clock.ts';
import {
  authoritativeTimeValue,
  commandTime,
  currentCommand,
  currentCommandResources,
  type AuthoritativeTime,
  type CommandTransaction,
} from '../command/command.ts';
import { currentOperationalResources, hasLiveOperationalTransaction } from '../command/operational.ts';
import { withConnection, discardConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import { routeOf, partitionOf } from '../route/route.ts';
import { NativeCollectionWork, instrumentNativeCollectionWork } from './collection-source-work.ts';
import {
  assertLibraryIdentityResources,
  revalidateBoundLibraryIdentityWork,
  withLibraryIdentityWork,
} from './identity-native-planner-work.ts';
import type { WorkAllowance, WorkDimensions, WorkReceipt } from './collection-source.ts';

import type { NativePublicOutputIdentity } from './native-source-output-types.ts';
export type { NativeOutputActivation, NativePublicOutputIdentity } from './native-source-output-types.ts';

/** Lookup hints only. Native records, not possession of this value, establish custody. */
type AccountSourceIdentity = Readonly<
  {
    route: number;
    collectionId: string;
    accountId: string;
    incarnation: string;
    generation: string;
    ownerEpoch: number;
    receivingEpoch: string;
    effectKey: string;
  } & (
    | {
        scope: 'curated' | 'private_builtin';
        outputGeneration?: never;
        publicationTransactionId?: never;
        publicationPosition?: never;
      }
    | {
        scope: 'active_explicit_output';
        outputGeneration: string;
        publicationTransactionId: string;
        publicationPosition: string;
      }
  )
>;
export type NativeSourceIdentity = AccountSourceIdentity | NativePublicOutputIdentity;
export type NativeSourceDriver =
  | 'member'
  | 'entry'
  | 'entry_deleted'
  | 'label'
  | 'assignment'
  | 'session'
  | 'unit'
  | 'change'
  | 'copy'
  | 'output'
  | 'done';
export type NativeSourceFrontier = Readonly<{
  captureId: string;
  driver: NativeSourceDriver;
  after: string;
  tie: string;
  sessionId: string | null;
  scanned: string;
  version: number;
}>;
const captureEvidence: unique symbol = Symbol('native source capture');
export type NativeSourceCapture = Readonly<{
  [captureEvidence]: true;
  identity: NativeSourceIdentity;
  captureId: string;
  transactionId: string;
  position: string;
  scanned: string;
}>;
const custodyEvidence: unique symbol = Symbol('native source custody');
export type NativeSourceCustody = Readonly<{
  [custodyEvidence]: true;
  identity: NativeSourceIdentity;
  captureId: string;
  holdId: string;
  transactionId: string;
}>;
export type NativeSourceCaptureWork = Readonly<{ allowance: WorkAllowance; deadline: number }>;
/** Exact current owner episode, independently reread under native locks. Never an allow flag. */
export type NativeSourceRetirement = Readonly<{
  sourceGeneration: string;
  episode: { kind: 'deleted'; deletionId: string; revision: number; purgeAfter: string } | { kind: 'terminal' };
}>;
export type NativeSourceRetirementResult =
  | Unavailable
  | { status: 'blocked'; reason: 'live_hold' | 'release_uncommitted' | 'source' | 'public_custody'; work: WorkReceipt }
  | { status: 'retired' | 'progress'; removed: number; work: WorkReceipt };
export type NativeSourceDependency = Readonly<{
  driver: NativeSourceDriver;
  key: string;
  tie: string;
  subjectId: string | null;
  transactionId: string | null;
}>;
type Unavailable = {
  status: 'unavailable';
  reason: 'binding' | 'writer' | 'allowance' | 'output_authority';
  work: WorkReceipt;
};
export interface NativeLibrarySourceCustody {
  retireCapture(
    input: NativeSourceCaptureWork &
      NativeSourceRetirement & {
        client: CommandTransaction;
        at: AuthoritativeTime;
        identity: NativeSourceIdentity;
        captureId: string;
      },
  ): Promise<NativeSourceRetirementResult>;
  capturePage(
    input: NativeSourceCaptureWork & {
      identity: NativeSourceIdentity;
      frontier: NativeSourceFrontier | null;
      limit: number;
    },
  ): Promise<
    | Unavailable
    | { status: 'pending'; frontier: NativeSourceFrontier; rows: readonly NativeSourceDependency[]; work: WorkReceipt }
  >;
  finishCapture(
    input: NativeSourceCaptureWork & {
      identity: NativeSourceIdentity;
      frontier: NativeSourceFrontier;
    },
  ): Promise<
    | Unavailable
    | {
        status: 'complete';
        capture: NativeSourceCapture & Readonly<{ identity: AccountSourceIdentity }>;
        work: WorkReceipt;
      }
  >;
  /** Same live native command or admitted operational client and T; never a foreign checkout/callback. */
  readAndHold(
    input: NativeSourceCaptureWork & {
      client: CommandTransaction;
      at: AuthoritativeTime;
      identity: NativeSourceIdentity;
      captureId: string;
      holdId: string;
    },
  ): Promise<Unavailable | { status: 'held'; custody: NativeSourceCustody; work: WorkReceipt }>;
  /** Existing committed custody only; never a fresh read or a new hold. Same live command client and T. */
  revalidateHold: NativeLibrarySourceCustody['readAndHold'];
  releaseHold(
    input: NativeSourceCaptureWork & {
      client: CommandTransaction;
      at: AuthoritativeTime;
      identity: NativeSourceIdentity;
      captureId: string;
      holdId: string;
    },
  ): Promise<Unavailable | { status: 'released'; work: WorkReceipt }>;
}

import partitionQuery from './native-source-custody-partition.sql';
import sourceQuery from './native-source-custody-source.sql';
import accountQuery from './native-source-custody-account.sql';
import ensureQuery from './native-source-custody-ensure.sql';
import fencesQuery from './native-source-custody-fences.sql';
import readQuery from './native-source-custody-read.sql';
import startQuery from './native-source-custody-start.sql';
import advanceQuery from './native-source-custody-advance.sql';
import finishQuery from './native-source-custody-finish.sql';
import proofQuery from './native-source-custody-proof.sql';
import holdQuery from './native-source-custody-hold.sql';
import heldQuery from './native-source-custody-held.sql';
import retainedQuery from './native-source-custody-retained.sql';
import releaseQuery from './native-source-custody-release.sql';
import retireSource from './native-source-custody-retire-source.sql';
import retireReceipt from './native-source-custody-retire-receipt.sql';
import retireActive from './native-source-custody-retire-active.sql';
import retireHolds from './native-source-custody-retire-holds.sql';
import retireChildren from './native-source-custody-retire-children.sql';
import retireProof from './native-source-custody-retire-proof.sql';
import retireCapture from './native-source-custody-retire-capture.sql';
import nextCapture from './native-source-custody-next.sql';
import identityCapture from './identity-native-planner-source.sql';
import identityRetention from './identity-native-planner-retention.sql';
import terminalScope from './erasure-scope.sql';
import rawMember from './native-source-custody-raw-member.sql';
import rawEntry from './native-source-custody-raw-entry.sql';
import rawEntryDeleted from './native-source-custody-raw-entry_deleted.sql';
import rawLabel from './native-source-custody-raw-label.sql';
import rawAssignment from './native-source-custody-raw-assignment.sql';
import rawSession from './native-source-custody-raw-session.sql';
import rawUnit from './native-source-custody-raw-unit.sql';
import rawChange from './native-source-custody-raw-change.sql';
import rawCopy from './native-source-custody-raw-copy.sql';
import rawOutput from './native-source-custody-raw-output.sql';
import rawExplicitOutput from './native-source-custody-raw-explicit-output.sql';
import outputQuery from './native-source-custody-output.sql';

const rawQueries = {
  member: rawMember,
  entry: rawEntry,
  entry_deleted: rawEntryDeleted,
  label: rawLabel,
  assignment: rawAssignment,
  session: rawSession,
  unit: rawUnit,
  change: rawChange,
  copy: rawCopy,
  output: rawOutput,
};
const zeroId = '00000000-0000-0000-0000-000000000000';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Query = { sql: string; params: readonly string[] };
// Identity capture only consumes the move target's nullness. Keep that native fact
// under the same row lock without projecting an unbounded node address.
const identityPartitionQuery = nativeIdentityPartitionQuery;
type Parameters = Record<string, unknown>;
type State = NativeSourceIdentity &
  NativeSourceFrontier & { collectionFence: string; accountFence: string; complete: boolean };
type Reason = Unavailable['reason'];
class Refused extends Error {
  constructor(readonly reason: Reason) {
    super(reason);
  }
}
const identityKeys = [
  'route',
  'collectionId',
  'accountId',
  'incarnation',
  'generation',
  'scope',
  'ownerEpoch',
  'receivingEpoch',
  'effectKey',
  'outputGeneration',
  'publicationTransactionId',
  'publicationPosition',
] as const;
const frontierKeys = ['captureId', 'driver', 'after', 'tie', 'sessionId', 'scanned', 'version'] as const;
function sameIdentity(state: NativeSourceIdentity, identity: NativeSourceIdentity): boolean {
  if (state.scope === 'public_output' || identity.scope === 'public_output') return false;
  return identityKeys.every((key) => (state[key] ?? undefined) === (identity[key] ?? undefined));
}
function sameFrontier(state: NativeSourceFrontier, frontier: NativeSourceFrontier): boolean {
  return frontierKeys.every((key) => state[key] === frontier[key]);
}
function validate(identity: NativeSourceIdentity): asserts identity is AccountSourceIdentity {
  // Public output custody is supplied by its native producer, never the account predicate.
  if (identity.scope === 'public_output') throw new Refused('output_authority');
  const accountRoute = routeOf(identity.accountId);
  if (
    !uuid.test(identity.collectionId) ||
    !uuid.test(identity.accountId) ||
    routeOf(identity.collectionId) !== identity.route ||
    accountRoute === null ||
    accountRoute === undefined ||
    partitionOf(accountRoute) !== partitionOf(identity.route) ||
    !Number.isSafeInteger(identity.ownerEpoch) ||
    identity.ownerEpoch < 1 ||
    !/^(0|[1-9][0-9]{0,18})$/.test(identity.generation) ||
    !/^[1-9][0-9]{0,18}$/.test(identity.receivingEpoch) ||
    BigInt(identity.generation) > 9223372036854775807n ||
    BigInt(identity.receivingEpoch) > 9223372036854775807n ||
    !identity.incarnation ||
    Buffer.byteLength(identity.incarnation) > 128 ||
    !identity.effectKey ||
    Buffer.byteLength(identity.effectKey) > 256 ||
    !['curated', 'private_builtin', 'active_explicit_output'].includes(identity.scope)
  )
    throw new Refused('binding');
  if (identity.scope === 'active_explicit_output') {
    if (
      !uuid.test(identity.outputGeneration) ||
      !uuid.test(identity.publicationTransactionId) ||
      !/^[1-9][0-9]{0,18}$/.test(identity.publicationPosition) ||
      BigInt(identity.publicationPosition) > 9223372036854775807n
    )
      throw new Refused('binding');
  } else if (
    identity.outputGeneration != null ||
    identity.publicationTransactionId != null ||
    identity.publicationPosition != null
  ) {
    throw new Refused('binding');
  }
}
/** Structural native bind validation only; this grants no Source or original authority. */
export function validateNativeIdentitySource(identity: NativeSourceIdentity): void {
  validate(identity);
}
function parameters(identity: NativeSourceIdentity): Parameters {
  validate(identity);
  return {
    route: identity.route,
    collection_id: identity.collectionId,
    account_id: identity.accountId,
    account_route: routeOf(identity.accountId),
    partition_no: partitionOf(identity.route),
    incarnation: identity.incarnation,
    generation: identity.generation,
    scope: identity.scope,
    owner_epoch: identity.ownerEpoch,
    receiving_epoch: identity.receivingEpoch,
    effect_key: identity.effectKey,
    output_generation: identity.outputGeneration ?? null,
    publication_transaction_id: identity.publicationTransactionId ?? null,
    publication_position: identity.publicationPosition ?? null,
  };
}
/** Fixed projections and primary-key/route-leading range plans only; no observed row-count cost classifier. */
function footprint(text: string, values: unknown[], rows: number, points: number, keys = 0, metadata = 0) {
  const projection = sameSQL(text) === sameSQL(readQuery.sql) ? captureProjectionBytes : 4096;
  return {
    nativeRows: rows,
    nativePoints: points,
    candidateKeys: keys,
    identityMetadataRows: metadata,
    witnessKeys: 0,
    statements: 1,
    bytes:
      Buffer.byteLength(text) +
      Buffer.byteLength(JSON.stringify(values)) +
      (rows || points ? projection : 0) +
      keys * 1024,
    // Native point probes can miss even without a returned raw key. Keep these
    // admitted slots inclusive; a positive outer join result cannot measure inner misses.
    emptySeeks: keys ? 1 : points,
  };
}
const sameSQL = (sql: string) =>
  sql
    .replace(/--[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/;$/, '');
const boundId = 'f'.repeat(36),
  boundDecimal = '9'.repeat(20),
  boundText = String.fromCharCode(1);
const captureProjectionBytes = Buffer.byteLength(
  JSON.stringify({
    route: 65535,
    captureId: boundId,
    collectionId: boundId,
    accountId: boundId,
    incarnation: boundText.repeat(128),
    generation: boundDecimal,
    scope: 'active_explicit_output',
    ownerEpoch: 2147483647,
    receivingEpoch: boundDecimal,
    effectKey: boundText.repeat(256),
    outputGeneration: boundId,
    publicationTransactionId: boundId,
    publicationPosition: boundDecimal,
    collectionFence: boundDecimal,
    accountFence: boundDecimal,
    driver: 'entry_deleted',
    after: boundText.repeat(512),
    tie: boundText.repeat(64),
    sessionId: boundId,
    scanned: boundDecimal,
    version: 2147483647,
    complete: false,
  }),
);
/** Literal reached capture/basis declarations; no table-prefix or arbitrary observer callback. */
export function nativeSourceCustodyFootprint(sql: string, values: readonly unknown[]): WorkDimensions | undefined {
  const text = sameSQL(sql);
  if (isNativeIdentitySourceBasisSQL(sql)) return nativeIdentitySourceBasisFootprint(sql, values);
  if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(text)) return footprint(sql, [...values], 0, 0);
  for (const [query, rows, points, metadata, keys = 0] of [
    [identityPartitionQuery, 16, 1, 1],
    [accountQuery, 16, 1, 0],
    [sourceQuery, 16, 1, 0],
    [outputQuery, 56, 7, 1],
    [ensureQuery, 32, 2, 0],
    [fencesQuery, 32, 2, 0],
    [readQuery, 16, 1, 0],
    [startQuery, 32, 1, 0],
    [advanceQuery, 32, 1, 0],
    [identityCapture, 32, 1, 0],
    [proofQuery, 64, 3, 1],
    [finishQuery, 80, 3, 1],
    [holdQuery, 48, 1, 0],
    [heldQuery, 16, 1, 0],
    [retainedQuery, 16, 1, 0],
    [releaseQuery, 32, 1, 0],
    [retireSource, 16, 1, 0],
    [retireReceipt, 16, 1, 0],
    [terminalScope, 48, 3, 0],
    [identityRetention, 2, 1, 0, 1],
    [retireActive, 16, 1, 0, 1],
    [retireHolds, 16 * 80 + 32, 1, 0, 80],
    [retireChildren, 16 * 80, 80, 0],
    [retireProof, 32, 2, 0],
    [retireCapture, 32, 2, 0],
    [nextCapture, 32, 2, 0, 1],
  ] as const) {
    if (sameSQL(query.sql) === text && query.params.length === values.length) {
      if (query === retireChildren) {
        const ids = values[query.params.indexOf('hold_ids')];
        if (!Array.isArray(ids) || ids.length > 80 || ids.some((id) => typeof id !== 'string' || !uuid.test(id)))
          return undefined;
      }
      const work = footprint(sql, [...values], rows, points, keys, metadata);
      const projection = query === readQuery ? captureProjectionBytes : undefined;
      if (projection !== undefined) work.bytes += projection - 4096;
      return work;
