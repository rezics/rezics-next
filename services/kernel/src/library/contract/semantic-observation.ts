/**
 * Library's consumer port for Semantic's bounded native observations.
 *
 * The port carries declarations and the work actually reached by each
 * operation. Declarations limit the caller's existing reservation; they do
 * not allocate work or confer authority.
 */

import type { Pool, PoolClient } from 'pg';
import type { NativeSourceIdentity } from './source.ts';
import type { WorkAllowance, WorkDimensions } from './work-dimensions.ts';

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
  pool: Pool;
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
    scopeCommitWork(input: Readonly<{
      route: number;
      collectionId: string;
      sourceFence: string;
      observation: LibrarySemanticScopeObservation;
    }>): WorkDimensions;
    readMappings(pool: Pool, originals: readonly string[]): Promise<LibrarySemanticObservationResult<readonly LibrarySemanticMapping[]>>;
    registerScope(pool: Pool, input: LibrarySemanticScopeRegistration): Promise<LibrarySemanticScopeResult>;
    revalidateScope(pool: Pool, input: LibrarySemanticScopeRevalidation): Promise<LibrarySemanticScopeResult>;
    commitScopeCapture(
      client: Pick<PoolClient, 'query'>,
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
    readMapping(pool: Pool, original: string): Promise<LibrarySemanticObservationResult<LibrarySemanticMapping>>;
    readMappings(
      pool: Pool,
      originals: readonly string[],
    ): Promise<LibrarySemanticObservationResult<readonly LibrarySemanticMapping[]>>;
    readSubjectReference(input: Readonly<{
      pool: Pool;
      subjectId: string;
      check(client: Pick<PoolClient, 'query'>): Promise<boolean>;
    }>): Promise<LibrarySemanticObservationResult<Readonly<
      | { state: 'present' }
      | { state: 'absent' }
      | { state: 'redirect'; from: string; to: string }
    >>>;
    observeSubjects(input: Readonly<{
      context: LibrarySemanticSummaryContext;
      ids: readonly string[];
    }>): Promise<LibrarySemanticObservationResult<LibrarySemanticSummaryObservation>>;
  }>;
  readonly shelf: Readonly<{
    identityVersionWork(subjectId: string): WorkDimensions;
    itemTypesWork(subjectIds: readonly string[], maxTypeBytes?: number): WorkDimensions;
    readIdentityVersion(
      client: Pick<PoolClient, 'query'>,
      subjectId: string,
    ): Promise<LibrarySemanticObservationResult<Readonly<{
      revision: number;
      transactionId: string;
      redirect: string | null;
    }> | null>>;
    readItemTypes(
      client: Pick<PoolClient, 'query'>,
      subjectIds: readonly string[],
      maxTypeBytes?: number,
    ): Promise<LibrarySemanticObservationResult<ReadonlyMap<string, string>>>;
  }>;
}
