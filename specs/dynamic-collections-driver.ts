/**
 * DYNAMIC_COLLECTIONS_DRIVER is an absolute path or file URL exporting
 * createDynamicCollectionsDriver(): Promise<DynamicCollectionsDriver>. Each call owns an isolated migrated PostgreSQL
 * database, real Auth/Access personas and a real DBOS executor composed from the production kernel work modules.
 * Every request passes through createKernel(...).handle. owner and other are distinct active accounts; anonymous has no
 * token; suspended has real suspended credentials. close stops owned workers/server and removes the database and tokens.
 *
 * The three profiles are real compiled Definitions releases for game, recipe, and record subjects. Subjects are
 * provisioned through semantic's production create path. Profile release changes use the trusted Definitions command.
 * Library facts and Collections are written through production HTTP commands only. The driver may inspect authoritative
 * rows, events, workflows, public projections, Search documents and actual measured PostgreSQL work; it never implements
 * membership, query, cursor, disclosure, or authorization rules and never substitutes a model backend, fake count, or
 * policy map.
 */
export type Persona = 'owner' | 'other' | 'anonymous' | 'suspended';
export type ProfileName = 'game' | 'recipe' | 'record';
export type Visibility = 'private' | 'unlisted' | 'public';
export type BuiltinKey =
  | { kind: 'everything' }
  | {
      kind: 'state';
      profileId: string;
      stateSetId: string;
      stateId: string;
    };

export interface ProfileFixture {
  typeId: string;
  profileId: string;
  stateSetId: string;
  releaseDigest: string;
  /** Actual accepted release labels, not a test-side localization provider. */
  states: readonly { id: string; labels: Readonly<Record<string, string>> }[];
}

export interface SubjectFixture {
  id: string;
  typeId: string;
  profileId: string | null;
}

interface CollectionViewBase {
  id: string;
  curatorAccountId: string;
  description: string | null;
  visibility: Visibility;
  revision: number;
}

export interface DynamicCollectionView extends CollectionViewBase {
  title?: string | null;
  membershipKind: 'dynamic';
  builtinKind: 'everything' | 'state';
  builtinLabels?: Readonly<Record<string, string>>;
  /** Owner discovery only. Never present in public DTOs. */
  builtin?: BuiltinKey;
}

export interface CuratedCollectionView extends CollectionViewBase {
  title: string;
  membershipKind: 'curated';
  createdAt: string;
  updatedAt: string;
  memberCount: number;
  orderEpoch: number;
}
export type CollectionView = CuratedCollectionView | DynamicCollectionView;

export interface CuratedMemberView {
  id: string;
  subjectId: string;
  note: string | null;
  addedAt: string;
  subject?: unknown;
}

export interface DynamicMemberView {
  kind: 'dynamic';
  subjectId: string;
  subject?: unknown;
}

export type CollectionMemberView = CuratedMemberView | DynamicMemberView;
export interface CollectionMembersPage {
  members: readonly CollectionMemberView[];
  next: string | null;
}

export interface Measurement {
  value: Response;
  statements: number;
  rowsExamined: number;
  buffers: number;
  partitionsTouched: number;
  crossPartitionJoins: number;
  candidateIds: readonly string[];
  classifier: string;
}

export interface StateReferenceObservation {
  value: Response;
  /** Actual native reference statements/plans, excluding Access and member-source SQL. */
  sql: readonly string[];
  probes: number;
  rowsExamined: number;
  plans: readonly {
    nodeType: string;
    indexCondition: string;
    rows: number;
    loops: number;
    rowsRemovedByFilter: number;
  }[];
}

export interface DynamicCollectionsInspection {
  collections: readonly {
    id: string;
    curatorAccountId: string;
    membershipKind: 'curated' | 'dynamic';
    builtinKey?: BuiltinKey;
    visibility: Visibility;
    revision: number;
    sourceGeneration: string;
    queryRevision: string;
    frozen: boolean;
  }[];
  curatedOccurrences: readonly { collectionId: string; id: string; subjectId: string; note: string | null }[];
  publicMembership: readonly {
    collectionId: string;
    subjectId: string;
    sourceEpoch: number;
    sourcePosition: string;
    multiplicity: number;
  }[];
  facts: readonly { accountId: string; subjectId: string; kind: 'state' | 'label' | 'session' | 'holding' }[];
  searchDocuments: readonly { subjectId: string; source: 'catalogue' | 'personal' }[];
  events: readonly { id: string; kind: string; sourceEpoch: number; sourcePosition: string }[];
  projections: readonly { collectionId: string; appliedEpoch: number; appliedPosition: string; terminal: boolean }[];
}

export interface DynamicCollectionsDriver {
  readonly accounts: Record<Exclude<Persona, 'anonymous'>, { id: string; route: number; partition: number }>;
  readonly profiles: Record<ProfileName, ProfileFixture>;
  readonly unknown: { collectionId: string; subjectId: string };

  setTime(instant: string): Promise<void>;
  now(): string;
  /** Replace the shared list-cursor key ring and retire the key used by issued test cursors. */
  rotateListCursorKey(): Promise<void>;

  /** Raw Response, preserving the production HTTP status, headers, and body. */
  request(
    as: Persona,
    input: {
      method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
      path: string;
      headers?: Record<string, string>;
      body?: unknown;
    },
  ): Promise<Response>;

  /** Create a real subject through semantic's accepted production command. */
  /** unprofiled uses data-only compiler input and real release publish/activate; never fabricated release/grant rows. */
  provisionSubject(
    profile: ProfileName | 'unprofiled',
    options?: { ownerOnlyReadable?: boolean },
  ): Promise<SubjectFixture>;
  /** Compile data-only state/label inputs, publish and activate through Definitions; return its actual immutable digest. */
  activateProfileRelease(
    profile: ProfileName,
    input: {
      states: readonly { id: string; labels: Readonly<Record<string, string>> }[];
    },
  ): Promise<ProfileFixture>;
  retireProfile(profile: ProfileName): Promise<void>;
  /** Add/remove a real viewer grant or eligibility fact through its source owner's production command. */
  setSubjectReadability(subjectId: string, viewer: 'owner' | 'other', readable: boolean): Promise<void>;

  /** Thin HTTP adapters to the co-owned Library facts API; each returns its unmodified production response. */
  setEntryState(subjectId: string, stateId: string): Promise<Response>;
  clearEntryState(subjectId: string): Promise<Response>;
  addLabel(subjectId: string, label: string): Promise<Response>;
  removeLabel(subjectId: string, label: string): Promise<Response>;
  startProgressSession(subjectId: string): Promise<Response>;
  createHolding(subjectId: string): Promise<Response>;
  removeAllPrivateFacts(subjectId: string): Promise<Response>;
  /** Raw terminal account deletion at T; no automatic clock advance or consumer wait. */
  deleteAccount(): Promise<Response>;
  mountCollection(collectionId: string): Promise<Response>;
  exportCollection(collectionId: string, as: Persona): Promise<Response>;
  runCollectionBulkAction(collectionId: string, input: unknown): Promise<Response>;

  /** Hold/resume the actual consumer; HTTP source commands remain live while held. */
  holdProjectionConsumer(): Promise<void>;
  resumeAndSettle(): Promise<void>;
  /** Redeliver the captured production projection events through the real consumer in the selected order. */
  replayProjectionEvents(order: 'forward' | 'reverse'): Promise<void>;
  /** Seed owner facts outside the selected profile/state predicate through production commands. */
  seedUnrelatedFacts(total: number): Promise<void>;
  inspect(): Promise<DynamicCollectionsInspection>;
  /** Measure the real callback's SQL only; setup, inspection and background consumer SQL are excluded. */
  measure(operation: () => Promise<Response>): Promise<Measurement>;
  /** Capture the real opaque-ID reference lookup; never derive a tuple or rewrite a request in the driver. */
  measureStateReference(operation: () => Promise<Response>): Promise<StateReferenceObservation>;
  /** Pause actual bounded native repair after source capture, before its terminal-owner writing guard. */
  holdStateReferenceRepair(): Promise<{ reached: Promise<void>; resume(): void }>;
  /** Dispatch/await the production bounded repair through its real work module, never fixture SQL. */
  repairStateReferences(): Promise<void>;
  close(): Promise<void>;
}
