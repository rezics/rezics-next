/** Library-owned ports. Foreign Access, Search, Semantic and Content implement these; Library never imports them. */

import type { LibraryActor } from './actors.ts';
import type { CanonicalCollectionCandidate, CollectionSourceObservation, PreparedCollectionSource } from './source.ts';
import type { NestedAdmissionAccount } from './membership.ts';
import type { WorkAllowance, WorkDimensions, WorkReceipt } from './work-dimensions.ts';

export type IdentityWorkHandle = Readonly<{
  resultByteBound(key: string): number | undefined;
}>;

export type QueryText = Readonly<{ sql: string; params?: readonly string[] }>;

export type AuthorizationDecision = Readonly<{
  authorized: boolean;
  reason?: 'unbound' | 'denied';
}>;

/** Same shape as Content/Semantic cover wire so Collection HTTP, pins, Search recents and Zone pages share one type. */
export type LibraryCoverCredit = {
  rightsHolder: string;
  via: { name: string; url: string };
  license: string;
  obligations: ('cc:Attribution' | 'cc:ShareAlike' | 'cc:Notice' | 'cc:SourceCode')[];
};

export type LibraryCoverSummary = {
  media: string;
  width: number;
  height: number;
  placeholder: { thumbhash: string; color: string };
  variants: { format: 'avif' | 'webp'; width: number }[];
  focalPoint: { x: number; y: number } | null;
  credit: LibraryCoverCredit;
};

export type LibraryRelease = Readonly<{ digest: string; release: unknown }>;

/** Live account/group/action admission. Access implements this at composition. */
export interface AuthorizationCapability {
  admitCollectionRead(input: {
    actor: LibraryActor;
    at: unknown;
    deadline: number;
    route: number;
    collectionId: string;
    curatorAccountId: string | null;
    visibility: 'private' | 'unlisted' | 'public';
    membershipKind: 'curated' | 'dynamic';
    privateOwner: boolean;
  }): Promise<AuthorizationDecision>;
  fenceAccount(tx: unknown, accountId: string): Promise<void>;
  isLifecycleDenied(error: unknown): boolean;
  commandAuthorization(...args: readonly unknown[]): Promise<unknown>;
  deadlineClient<T extends object>(client: T, deadline: number): T;
  within<T>(deadline: number, work: () => Promise<T>): Promise<T>;
}

/** Original and terminal identity/disclosure. Semantic implements this at composition. */
export interface IdentityDisclosureCapability {
  readRelease(source: unknown, digest: string, options?: Readonly<{ composed?: boolean }>): Promise<unknown>;
  readOriginalTerminal(input: {
    actor: LibraryActor;
    subjectId: string;
    deadline: number;
    at: unknown;
  }): Promise<Readonly<{ original: string | null; terminal: string | null }>>;
  readActiveRelease(source: unknown): Promise<LibraryRelease | null>;
  initiatorCommitment(original: unknown): string;
}

export type PreparedSearchScope = Readonly<{
  prepared: Readonly<{ basis: unknown }>;
  work: WorkReceipt;
  scope: {
    sourcePrefix(
      prepared: unknown,
      input: Readonly<{ afterSubjectId: string | null; allowance: WorkAllowance; candidateLimit?: number }>,
    ): Promise<
      Readonly<{
        candidates: readonly CanonicalCollectionCandidate[];
        observation: CollectionSourceObservation;
        exhausted: boolean;
        coveredThrough: string | null;
        work: WorkReceipt;
      }>
    >;
    evaluate(
      prepared: unknown,
      subjects: readonly string[],
      input: unknown,
    ): Promise<Readonly<{ values: readonly unknown[] }>>;
    work(result: unknown): WorkReceipt;
  };
}>;

export type SearchFilterLeafKind = 'catalogue' | 'owner';

/** Search scope preparation. Search implements this at composition through the existing service object. */
export interface SearchPreparationCapability {
  prepareScope(input: {
    search: unknown;
    access: unknown;
    actor: LibraryActor;
    routeKey: Uint8Array;
    nativeT: unknown;
    deadline: number;
    filter: unknown;
    releaseDigest: string;
    identity: unknown;
    allowance: WorkAllowance;
  }): Promise<PreparedSearchScope>;
  ownerFilterHasOwnerLeaf(filter: unknown): boolean;
  filterLeaves(filter: unknown): readonly SearchFilterLeafKind[];
}

/** Content publication side effects remain Content-owned; Library admits the Source hold. */
export interface ContentPublicationCapability {
  admitActivatedOutput(input: {
    observation: CollectionSourceObservation;
    privateWorking: boolean;
  }): Readonly<{ admitted: boolean; reason: 'private_working' | 'activated_public' | 'unavailable' }>;
  readableCover(input: {
    actor: LibraryActor;
    mediaId: string;
    deadline: number;
    routeKey?: Uint8Array;
    clock?: () => Date;
  }): Promise<LibraryCoverSummary | null>;
}

export type IdentitySqlWork = Readonly<{
  sql: string;
  nativeRows: number;
  nativePoints: number;
  identityMetadataRows: number;
  emptySeeks: number;
  resultBytes: number;
  candidateKeys?: number;
  rangeLimitParameter?: number;
}>;

export type IdentityNativeCatalog = Readonly<{
  libraryIdentitySQL: Readonly<Record<string, string>>;
  sqlWork: Readonly<Record<string, IdentitySqlWork>>;
  selected: Readonly<
    Record<
      string,
      Readonly<{
        sql: string;
        values: readonly unknown[];
        rows: number;
        points: number;
        metadata: number;
        output: number;
        seeks?: number;
        candidates?: number;
      }>
    >
  >;
  basisQueries: readonly QueryText[];
  basisWork: readonly Readonly<{
    sql: string;
    nativeRows: number;
    nativePoints: number;
    identityMetadataRows: number;
    emptySeeks: number;
    resultBytes: number;
  }>[];
  plan: QueryText;
  job: QueryText;
  time: QueryText;
  fence: QueryText;
  noEffectFence: QueryText;
  partition: QueryText;
  account: QueryText;
  commit: QueryText;
  savedJob: QueryText;
  libraryTransform: QueryText;
  identityEpochLibraryInputsSQL: string;
  inputs: QueryText;
  originals: QueryText;
  owners: QueryText;
  sources: QueryText;
  pending: QueryText;
  mapping: QueryText;
  facts: QueryText;
  labels: QueryText;
  libraryIdentityJobSizeSQL: string;
  libraryIdentityBoundedPlanSQL: string;
  planResultBytes: number;
  selectedBindCeiling: (sql: string, values: readonly unknown[]) => boolean;
}>;

export interface IdentityNativeCapability {
  bound(sql: string, values: readonly unknown[], work?: IdentityWorkHandle): unknown;
  footprint(sql: string, values: readonly unknown[], work?: IdentityWorkHandle): WorkDimensions | undefined;
  selectedFootprint(sql: string, values: readonly unknown[]): WorkDimensions | undefined;
  isFullPartitionSQL(sql: string): boolean;
  isSourceBasisSQL(sql: string): boolean;
  sourceBasisFootprint(sql: string, values: readonly unknown[]): WorkDimensions | undefined;
  sourceBasisBound(sql: string, values: readonly unknown[]): unknown;
  selectedBound(sql: string, values: readonly unknown[]): unknown;
  basisStatements(): readonly Readonly<{
    sql: string;
    values: readonly unknown[];
    work: WorkDimensions;
    engineRequests: 0;
  }>[];
  jobSizeSQL: string;
}

export interface SourceCaptureCapability {
  prepare(input: {
    actor: LibraryActor;
    collectionId: string;
    deadline: number;
    at: unknown;
    allowance: WorkAllowance;
    logical?: boolean;
    ordinaryPage?: boolean;
  }): Promise<{ source: PreparedCollectionSource; work: WorkReceipt }>;
}

export type LibraryCapabilities = Readonly<{
  authorization: AuthorizationCapability;
  identityDisclosure: IdentityDisclosureCapability;
  searchPreparation: SearchPreparationCapability;
  contentPublication: ContentPublicationCapability;
  identityNative: IdentityNativeCapability;
  sourceCapture: SourceCaptureCapability;
  accountAdmission: NestedAdmissionAccount;
}>;
