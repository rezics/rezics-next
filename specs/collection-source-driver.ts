import type { AuthoritativeTime } from '../services/kernel/src/command/command.ts';
import type { Actor } from '../services/kernel/src/request/access.ts';
import type {
  CollectionSource,
  CollectionSourceContext,
  WorkAllowance,
  WorkDimensions,
  WorkReceipt,
} from '../services/kernel/src/library/collection-source.ts';

/**
 * COLLECTION_SOURCE_DRIVER: absolute path/file URL exporting createCollectionSourceDriver().
 * This file is a test harness contract, NOT a functional driver or membership backend.
 * Each factory owns an isolated migrated native database, real Auth/Access personas and the production owner factory.
 * Setup uses real kernel HTTP/owner commands, trusted Definitions activation, real merge_member/repoint work,
 * publication and deletion workers. Never use fake Access, policyMap, synthetic SearchHit, stored expected answers,
 * in-memory membership/index, or a test repair that pretends canonical readiness. Native prerequisites may be absent;
 * those cases must stay red until the accepted implementation exists. No skips or conditional green fallbacks.
 * close stops/removes only resources this factory started. Trace/inspect read actual native evidence, not a model.
 */
export type SourcePersona = 'owner' | 'other' | 'anonymous' | 'suspended';
export type FactKind = 'state' | 'label' | 'session' | 'holding';
export interface SourceFixture {
  readonly id: string;
  readonly route: number;
}
export interface ProfileFixture {
  readonly profileId: string;
  readonly stateSetId: string;
  readonly stateId: string;
  readonly releaseDigest: string;
  readonly typeId: string;
}
export interface OccurrenceInspection {
  collectionId: string;
  id: string;
  subjectId: string;
  ordinalKey: string;
  note: string | null;
}

/** Actual EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) nodes; no estimated-row substitution. */
export interface NativePlan {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Index Cond'?: string;
  'Actual Rows': number;
  'Actual Loops': number;
  'Rows Removed by Filter'?: number;
  'Rows Removed by Index Recheck'?: number;
  Plans?: readonly NativePlan[];
}
export interface NativeTrace {
  /** One entry for EVERY candidate read, including rereads, fact drivers, alias windows and lookahead. */
  candidateKeys: readonly { key: string; family: 'curated' | FactKind | 'alias' | 'published' }[];
  /** Actual Semantic metadata rows from BOTH sweeps, including partial/not-ready/error observations. */
  identityMetadataRows: number;
  /** Total charged plan-proved native row-work ceiling; separate from the actual rows/buffers captured below. */
  nativeRows: number;
  identityBasisReads: readonly {
    state: 'ready' | 'not_ready' | 'error';
    reservationId: string;
    beforeMetadataOffset: number;
    metadataRows: number;
    /** Actual core-home observations count in nativePoints, in addition to identity metadata rows. */
    coreHomeObservations: number;
    /** Charged plan-proved row-work reservation settled for this basis operation. */
    nativeRows: number;
  }[];
  /** Actual caller admission events, recorded before dispatch, not reconstructed from completed reads. */
  metadataReservations: readonly { allowance: WorkAllowance; beforeMetadataOffset: number }[];
  /** Actual native group calls and owner processing, captured separately so fetch != settlement. */
  aliasWindows: readonly {
    limit: number;
    examined: number;
    originals: readonly string[];
    after: string | null;
    settledOriginals: readonly string[];
    /** The explicit reservation made BEFORE the Semantic dispatch, including key-only lookahead. */
    allowance: WorkAllowance;
  }[];
  emptySeeks: number;
  nativePoints: number;
  witnessKeys: number;
  statements: number;
  bytes: number;
  /** Actual native SQL rows across every query/pool; identity metadata has its own count; growth checks both. */
  rowsExamined: number;
  buffers: number;
  sql: readonly string[];
  /** Actual EXPLAIN rows/loops/filter removals from every participating query and pool, never estimates. */
  plans: readonly NativePlan[];
  /** Recorded ordinary native Access invocations, including source sink and original/terminal anchors. */
  anchors: readonly { action: string; route: number; id: string; actor: Actor; at: AuthoritativeTime }[];
  /** Before-dispatch reservations observed by the shared caller instrumentation. Not computed after reading. */
  reservations: readonly { allowance: WorkAllowance; beforeCandidateOffset: number }[];
  /** Actual caller settlements, including work spent before a thrown dependency/readiness error. */
  settlements: readonly WorkReceipt[];
  crossPartitionJoins: number;
  renderedSubjectReads: number;
}
export interface SourceInspection {
  occurrences: readonly OccurrenceInspection[];
  /** Exact stored owner-fact keys/pins, read only. Used to prove no identity rewrite or private mirror. */
  privateFacts: readonly { key: string; subjectId: string; kind: FactKind; pin: string | null }[];
  /** Serialized actual Search and public projection rows, for private-value leak assertions. */
  publicRows: readonly unknown[];
  publicDTOs: readonly unknown[];
  pendingPrivatePurge: number;
  repairPages: readonly { candidateKeys: number; nativePoints: number; statements: number; bytes: number }[];
}

export interface CollectionSourceDriver {
  readonly source: CollectionSource;
  readonly accounts: Readonly<Record<Exclude<SourcePersona, 'anonymous'>, SourceFixture>>;
  readonly profiles: readonly [ProfileFixture, ProfileFixture];
  readonly unknownCollectionId: string;
  /** Opaque T comes from the real Core native read framework, never Date -> T or a fabricated read context. */
  read<T>(as: SourcePersona, operation: (context: CollectionSourceContext) => Promise<T>): Promise<T>;
  measure<T>(operation: () => Promise<T>): Promise<{ value: T; trace: NativeTrace }>;
  /** Plan admission's finite extra-dimensional limits; not a second candidate-budget authority. */
  admittedDimensions(): Omit<WorkDimensions, 'candidateKeys'>;
  subject(options?: { profile?: ProfileFixture; unprofiled?: boolean }): Promise<SourceFixture>;
  curated(
    members: readonly { subjectId: string; note: string | null }[],
    visibility?: 'private' | 'unlisted' | 'public',
  ): Promise<SourceFixture>;
  builtin(key: { kind: 'everything' } | { kind: 'state'; profile: ProfileFixture }): Promise<SourceFixture>;
  /** Thin calls to real Library fact commands; clear removes that fact through the owner, not a SQL test mirror. */
  addFact(
    subject: SourceFixture,
    kind: FactKind,
    profile?: ProfileFixture,
  ): Promise<{ key: string; privateValue: string }>;
  clearFact(subject: SourceFixture, kind: FactKind): Promise<void>;
  softDeleteFact(subject: SourceFixture, kind: FactKind): Promise<void>;
  setCollectionVisibility(source: SourceFixture, visibility: 'private' | 'unlisted' | 'public'): Promise<void>;
  softDeleteCollection(source: SourceFixture): Promise<void>;
  /** Actual grant/revoke commands on the named resource anchor; no replacement authorization implementation. */
  grant(
    resource: SourceFixture,
    action: 'collection:read' | 'subject:read',
    as: SourcePersona,
    allowed: boolean,
  ): Promise<void>;
  mount(source: SourceFixture): Promise<void>;
  merge(from: SourceFixture, survivor: SourceFixture): Promise<void>;
  unmerge(from: SourceFixture): Promise<void>;
  /** Hold the actual native canonical maintenance consumer, then run finite bounded real owner repair. */
  holdIdentityRepair(): Promise<void>;
  repairIdentity(): Promise<void>;
  /**
   * One-shot real native barrier AFTER witness discovery and BEFORE its final current authorization/use.
   * The callback is a separate native request; its own work does not enter the measured source request's receipt.
   */
  beforePositiveUse(operation: () => Promise<void>): Promise<void>;
  /** Mutate a different native key on the same partition; no structural meaning change. */
  unrelatedWrite(source: SourceFixture): Promise<void>;
  activateProfile(profile: ProfileFixture, change: 'labels_only' | 'meaning'): Promise<ProfileFixture>;
  retireProfile(profile: ProfileFixture): Promise<void>;
  /** Real publication generation control: private pending work cannot become a complete activated output. */
  holdPublication(): Promise<void>;
  publishAndSettle(): Promise<void>;
  replayOldPublicationEvents(): Promise<void>;
  deleteOwnerAccount(): Promise<void>;
  settlePrivatePurge(): Promise<void>;
  /** Fault injection at real dependency composition/availability, never a fake empty backend. */
  unavailable(dependency: 'runtime' | 'canonical_index' | 'publication' | 'profile'): Promise<() => Promise<void>>;
  /** Actual shared Zone composition, direct membership and full admitted Boolean native evaluation. */
  union(input: {
    as: SourcePersona;
    sources: readonly SourceFixture[];
    limit: number;
    cursor?: string;
    filter?: unknown;
    /** Actual admitted saved catalogue filter IDs, composed by the real Zone owner. */
    scopes?: readonly string[];
  }): Promise<Response>;
  /** Test-only decode with the real union request binding and keyring; never synthesize cursor positions. */
  inspectUnionContinuation(input: {
    as: SourcePersona;
    sources: readonly SourceFixture[];
    limit: number;
    cursor: string;
  }): Promise<{ epoch: number; after: readonly (string | number)[] }>;
  /** Closed shared AST and actual native facts admitted by the real shared compiler, no copied filter evaluator. */
  booleanFixture(
    subject: SourceFixture,
    settledSubject?: SourceFixture,
  ): Promise<{
    trueFilter: unknown;
    falseFilter: unknown;
    unknownFilter: unknown;
    notUnknownFilter: unknown;
    /** Native full Boolean expression: settledSubject is true, subject requires unresolved evidence. */
    settledThenUnknownFilter: unknown;
    unknownScopeId: string;
  }>;
  directMembership(
    as: SourcePersona,
    sources: readonly SourceFixture[],
    subjectId: string,
    options?: { filter?: unknown; scopes?: readonly string[]; cursor?: string },
  ): Promise<Response>;
  /** Decode the real POST :readPage continuation with its actual request/target binding and keyring. */
  inspectDirectContinuation(input: {
    as: SourcePersona;
    sources: readonly SourceFixture[];
    subjectId: string;
    cursor: string;
  }): Promise<{ epoch: number; after: readonly (string | number)[] }>;
  rotateCursorKey(): Promise<void>;
  advanceClock(milliseconds: number): Promise<void>;
  inspect(): Promise<SourceInspection>;
  /** Existing native growth framework/classifier, fed the actual samples below. Must assert admitted cost. */
  checkGrowth(
    samples: readonly { scale: number; position: 'first' | 'deep'; quota: number; trace: NativeTrace }[],
  ): Promise<void>;
  close(): Promise<void>;
}
