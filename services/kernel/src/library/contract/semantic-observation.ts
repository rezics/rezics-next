/**
 * Library's consumer port for Semantic's bounded native observations.
 *
 * The port carries declarations and the work actually reached by each
 * operation. Declarations limit the caller's existing reservation; they do
 * not allocate work or confer authority.
 */

import type { NativeSourceIdentity } from './source.ts';
import type { WorkAllowance, WorkDimensions } from './work-dimensions.ts';

/** Native storage handles are opaque to Library's contract. Semantic owns their pg interpretation. */
export type LibrarySemanticDatabase = object;
export type LibrarySemanticQueryClient = object;

export type LibrarySemanticMapping =
  | Readonly<{ state: 'mapped'; original: string; terminal: string; epoch: bigint }>
  | Readonly<{ state: 'pending'; original: string; job: Readonly<{ jobId: string; epoch: bigint }> }>
  | Readonly<{ state: 'absent' }>
  | Readonly<{ state: 'unavailable'; reason: 'bootstrap' | 'missing-owner' | 'moved-owner' }>;

export type LibrarySemanticScopeKey = Readonly<{
  source: Readonly<{ kind: 'library'; identity: NativeSourceIdentity }>;
  scopeId: string;
}>;

export type LibrarySemanticScopeObservation = Readonly<{
  key: LibrarySemanticScopeKey;
  captureId: string;
  committedRevision: bigint;
}>;

export type LibrarySemanticScopeResult = Readonly<{
  status: 'registered' | 'pending' | 'current' | 'unavailable' | 'stale';
  observation?: LibrarySemanticScopeObservation;
  work: WorkDimensions;
}>;

export type LibrarySemanticSummaryContext = Readonly<{
  pool: LibrarySemanticDatabase;
  routeKey: Uint8Array;
  access: unknown;
  actor: unknown;
  deadline: number;
  work?: unknown;
}>;

export type LibrarySemanticSummaryObservation = Readonly<{
  summaries: ReadonlyMap<string, unknown | null>;
  current(): Promise<LibrarySemanticObservationResult<boolean>>;
}>;

export type LibrarySemanticObservationResult<T> = Readonly<{
  value: T;
  work: WorkDimensions;
}>;

export type LibrarySemanticScopeRegistration = Readonly<{
  key: LibrarySemanticScopeKey;
  /** Retained predecessor at this stable address; never permission to replace another registration. */
  replaces?: Readonly<{ key: LibrarySemanticScopeKey; captureId: string | null }>;
  deadline: number;
  capture: Readonly<{
    kind: 'library';
    capture: unknown;
    frontier: Readonly<{
      captureId: string;
      driver: string;
      after: string;
      tie: string;
      sessionId: string | null;
      scanned: string;
      version: number;
    }>;
    allowance: WorkAllowance;
  }>;
}>;

export type LibrarySemanticScopeRevalidation = Readonly<{
  key: LibrarySemanticScopeKey;
  expected: LibrarySemanticScopeObservation;
  deadline: number;
}>;

/** The one supplied Semantic capability installed by the production composition root. */
export interface LibrarySemanticObservationCapability {
  readonly canonical: Readonly<{
    mappingWork(originals: readonly string[]): WorkDimensions;
    scopeCommitWork(
      input: Readonly<{
        route: number;
        collectionId: string;
        sourceFence: string;
        observation: LibrarySemanticScopeObservation;
      }>,
    ): WorkDimensions;
    readMappings(
      pool: LibrarySemanticDatabase,
      originals: readonly string[],
    ): Promise<LibrarySemanticObservationResult<readonly LibrarySemanticMapping[]>>;
    registerScope(
      pool: LibrarySemanticDatabase,
      input: LibrarySemanticScopeRegistration,
    ): Promise<LibrarySemanticScopeResult>;
    revalidateScope(
      pool: LibrarySemanticDatabase,
      input: LibrarySemanticScopeRevalidation,
    ): Promise<LibrarySemanticScopeResult>;
    commitScopeCapture(
      client: LibrarySemanticQueryClient,
      input: Readonly<{
        route: number;
        collectionId: string;
        sourceFence: string;
        observation: LibrarySemanticScopeObservation;
      }>,
    ): Promise<LibrarySemanticObservationResult<void>>;
  }>;
  readonly follow: Readonly<{
    mappingWork(originals: readonly string[]): WorkDimensions;
    subjectReferenceWork(subjectId: string): WorkDimensions;
    subjectSummaryWork(subjectIds: readonly string[]): WorkDimensions;
    subjectSummaryCurrentWork(subjectIds: readonly string[]): WorkDimensions;
    readMapping(
      pool: LibrarySemanticDatabase,
      original: string,
    ): Promise<LibrarySemanticObservationResult<LibrarySemanticMapping>>;
    readMappings(
      pool: LibrarySemanticDatabase,
      originals: readonly string[],
    ): Promise<LibrarySemanticObservationResult<readonly LibrarySemanticMapping[]>>;
    readSubjectReference(
      input: Readonly<{
        pool: LibrarySemanticDatabase;
        subjectId: string;
        check(client: LibrarySemanticQueryClient): Promise<boolean>;
      }>,
    ): Promise<
      LibrarySemanticObservationResult<
        Readonly<{ state: 'present' } | { state: 'absent' } | { state: 'redirect'; from: string; to: string }>
      >
    >;
    observeSubjects(
      input: Readonly<{
        context: LibrarySemanticSummaryContext;
        ids: readonly string[];
      }>,
    ): Promise<LibrarySemanticObservationResult<LibrarySemanticSummaryObservation>>;
  }>;
  readonly shelf: Readonly<{
    identityVersionWork(subjectId: string): WorkDimensions;
    itemTypesWork(subjectIds: readonly string[], maxTypeBytes?: number): WorkDimensions;
    readIdentityVersion(
      client: LibrarySemanticQueryClient,
      subjectId: string,
    ): Promise<
      LibrarySemanticObservationResult<Readonly<{
        revision: number;
        transactionId: string;
        redirect: string | null;
      }> | null>
    >;
    readItemTypes(
      client: LibrarySemanticQueryClient,
      subjectIds: readonly string[],
      maxTypeBytes?: number,
    ): Promise<LibrarySemanticObservationResult<ReadonlyMap<string, string>>>;
  }>;
}
