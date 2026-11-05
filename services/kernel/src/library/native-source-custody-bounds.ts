import { BOUND_AXES, declareBound, repeatBound, sumBounds, withinCeiling, type Bound } from '@rezics/bounds';
import type { WorkDimensions } from './collection-source.ts';
import {
  nativeIdentityPartitionQuery,
  nativeIdentitySourceBasisFootprint,
} from './identity-native-planner-selected-pricing.ts';
import accountQuery from './native-source-custody-account.sql';
import advanceQuery from './native-source-custody-advance.sql';
import ensureQuery from './native-source-custody-ensure.sql';
import fencesQuery from './native-source-custody-fences.sql';
import finishQuery from './native-source-custody-finish.sql';
import heldQuery from './native-source-custody-held.sql';
import holdQuery from './native-source-custody-hold.sql';
import nextCapture from './native-source-custody-next.sql';
import outputQuery from './native-source-custody-output.sql';
import partitionQuery from './native-source-custody-partition.sql';
import proofQuery from './native-source-custody-proof.sql';
import rawAssignment from './native-source-custody-raw-assignment.sql';
import rawChange from './native-source-custody-raw-change.sql';
import rawCopy from './native-source-custody-raw-copy.sql';
import rawEntryDeleted from './native-source-custody-raw-entry_deleted.sql';
import rawEntry from './native-source-custody-raw-entry.sql';
import rawExplicitOutput from './native-source-custody-raw-explicit-output.sql';
import rawLabel from './native-source-custody-raw-label.sql';
import rawMember from './native-source-custody-raw-member.sql';
import rawOutput from './native-source-custody-raw-output.sql';
import rawSession from './native-source-custody-raw-session.sql';
import rawUnit from './native-source-custody-raw-unit.sql';
import readQuery from './native-source-custody-read.sql';
import releaseQuery from './native-source-custody-release.sql';
import retireActive from './native-source-custody-retire-active.sql';
import retireCapture from './native-source-custody-retire-capture.sql';
import retireChildren from './native-source-custody-retire-children.sql';
import retireHolds from './native-source-custody-retire-holds.sql';
import retireProof from './native-source-custody-retire-proof.sql';
import retireReceipt from './native-source-custody-retire-receipt.sql';
import retireSource from './native-source-custody-retire-source.sql';
import retainedQuery from './native-source-custody-retained.sql';
import sourceQuery from './native-source-custody-source.sql';
import startQuery from './native-source-custody-start.sql';
import identityCapture from './identity-native-planner-source.sql';
import identityRetention from './identity-native-planner-retention.sql';
import terminalScope from './erasure-scope.sql';
import type { NativeSourceDriver } from './native-source-custody.ts';

type Query = Readonly<{ sql: string; params: readonly string[] }>;
type StatementId =
  | 'account'
  | 'advance'
  | 'ensure'
  | 'fences'
  | 'finish'
  | 'held'
  | 'hold'
  | 'identityCapture'
  | 'identityPartition'
  | 'output'
  | 'proof'
  | 'rawAssignment'
  | 'rawChange'
  | 'rawCopy'
  | 'rawEntry'
  | 'rawEntryDeleted'
  | 'rawExplicitOutput'
  | 'rawLabel'
  | 'rawMember'
  | 'rawOutput'
  | 'rawSession'
  | 'rawUnit'
  | 'retireActive'
  | 'retireCaptureRow'
  | 'retireChildren'
  | 'retireHolds'
  | 'retireProofRow'
  | 'retireReceipt'
  | 'retireSource'
  | 'identityRetention'
  | 'nextCapture'
  | 'read'
  | 'release'
  | 'retained'
  | 'source'
  | 'start'
  | 'terminalScope';
type CustodyOperation =
  | 'capturePage'
  | 'finishCapture'
  | 'readAndHold'
  | 'revalidateHold'
  | 'releaseHold'
  | 'retireCapture';
type CostDetail = Readonly<{
  bound: Bound;
  requestBytes: number;
  projectionBytes: number;
}>;
type StatementSpec = Readonly<{
  id: StatementId;
  query: Query;
  rows: number | ((values: readonly unknown[]) => number | undefined);
  points: number;
  metadata: number;
  keys: number | ((values: readonly unknown[]) => number | undefined);
  projectionBytes: number | ((values: readonly unknown[]) => number | undefined);
  maxOverrides?: Readonly<Record<string, unknown>>;
  valid?: (values: Readonly<Record<string, unknown>>) => boolean;
}>;

const maxInt = 2147483647;
const maxBigint = '9223372036854775807';
const maxUuid = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
const maxEscapedText = (octets: number) => String.fromCharCode(1).repeat(octets);
const maxScope = 'active_explicit_output';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const bigintText = /^(0|[1-9][0-9]{0,18})$/;
const positiveBigintText = /^[1-9][0-9]{0,18}$/;
const allowedDrivers = new Set<NativeSourceDriver>([
  'member',
  'entry',
  'entry_deleted',
  'label',
  'assignment',
  'session',
  'unit',
  'change',
  'copy',
  'output',
  'done',
]);

const captureProjectionBytes = Buffer.byteLength(
  JSON.stringify({
    route: 65535,
    captureId: maxUuid,
    collectionId: maxUuid,
    accountId: maxUuid,
    incarnation: maxEscapedText(128),
    generation: maxBigint,
    scope: maxScope,
    ownerEpoch: maxInt,
    receivingEpoch: maxBigint,
    effectKey: maxEscapedText(256),
    outputGeneration: maxUuid,
    publicationTransactionId: maxUuid,
    publicationPosition: maxBigint,
    collectionFence: maxBigint,
    accountFence: maxBigint,
    driver: 'entry_deleted',
    after: maxEscapedText(512),
    tie: maxEscapedText(64),
    sessionId: maxUuid,
    scanned: maxBigint,
    version: maxInt,
    complete: false,
  }),
);
const dependencyProjectionBytes = Buffer.byteLength(
  JSON.stringify({
    driver: 'entry_deleted',
    key: maxEscapedText(128),
    tie: maxEscapedText(64),
    subjectId: maxUuid,
    transactionId: maxUuid,
  }),
);
const receiptProjectionBytes = Buffer.byteLength(JSON.stringify({ transactionId: maxUuid, position: maxBigint }));
const holdProjectionBytes = Buffer.byteLength(JSON.stringify({ transactionId: maxUuid, released: false }));
const retainedProjectionBytes = Buffer.byteLength(JSON.stringify({ transactionId: maxUuid }));
const terminalProjectionBytes = Buffer.byteLength(JSON.stringify({ version: maxInt, outcome: maxEscapedText(32) }));
const retireSourceProjectionBytes = Buffer.byteLength(
  JSON.stringify([
    {
      accountId: maxUuid,
      incarnation: `${maxUuid}:9223372036854.775807`,
      generation: maxBigint,
      state: 'deleted',
      kind: 'curated',
      builtin: 'everything',
      visibility: 'unlisted',
      deletionId: maxUuid,
      revision: maxInt,
      deadlineMatches: false,
      due: false,
      publicCustody: false,
    },
  ]),
);
const retirementHoldProjectionBytes = Buffer.byteLength(
  JSON.stringify([{ id: maxUuid, transactionId: maxUuid, released: false, committed: false }]),
);
const retirementUuidProjectionBytes = Buffer.byteLength(JSON.stringify([{ capture_id: maxUuid }]));
const retirementPlanKeyProjectionBytes = Buffer.byteLength(JSON.stringify([{ plan_key: '0'.repeat(64) }]));

const rawQueries: Readonly<{
  member: typeof rawMember;
  entry: typeof rawEntry;
  entry_deleted: typeof rawEntryDeleted;
  label: typeof rawLabel;
  assignment: typeof rawAssignment;
  session: typeof rawSession;
  unit: typeof rawUnit;
  change: typeof rawChange;
  copy: typeof rawCopy;
  output: typeof rawOutput;
}> = Object.freeze({
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
});

/** Explicit Query names so the producer declaration does not leak pg protocol types. */
type NativeSourceCustodyQueries = Readonly<{
  partition: Query;
  source: Query;
  account: Query;
  output: Query;
  ensure: Query;
  fences: Query;
  read: Query;
  start: Query;
  advance: Query;
  identityCapture: Query;
  proof: Query;
  finish: Query;
  hold: Query;
  held: Query;
  retained: Query;
  release: Query;
  terminalScope: Query;
  raw: Readonly<{
    member: Query;
    entry: Query;
    entry_deleted: Query;
    label: Query;
    assignment: Query;
    session: Query;
    unit: Query;
    change: Query;
    copy: Query;
    output: Query;
  }>;
  rawExplicitOutput: Query;
  retirement: Readonly<{
    partition: Query;
    source: Query;
    receipt: Query;
    active: Query;
    holds: Query;
    children: Query;
    proof: Query;
    capture: Query;
    identityRetention: Query;
    nextCapture: Query;
  }>;
}>;

/** The canonical SQL objects used by the native adapter and the executable plan. */
