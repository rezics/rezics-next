import type { Pool } from 'pg';
import type { BatchResult } from '../events/log.ts';
import { ProblemError } from '../http/problem.ts';
import type { OpenSearch } from './opensearch.ts';
import type { SubjectListingSource, SubjectSource } from './source.ts';

/** Physical identity is observed from the engine; names and numeric generations are insufficient. */
export type IndexIncarnation = Readonly<{
  prefix: string;
  generation: number;
  index: string;
  uuid: string;
  protocol: 'subject-coverage-v1';
  consumer: string;
}>;

/** Derived observation only. Native generation/pending remain the identity authority. */
export type CoverageHome = Readonly<{
  partition: number;
  epoch: number;
  home: string;
  generation: bigint;
}>;

export type StructuralFence = Readonly<{ epoch: number; position: bigint; generation: bigint }>;
export type CoverageCheckpoint = Readonly<{ epoch: number; position: bigint }>;

/** One current slot per home/incarnation, never an append-only attempt history. */
export type ApplyAttempt = Readonly<{
  id: string;
  from: CoverageCheckpoint;
  through: CoverageCheckpoint;
  source: CoverageHome | null;
  outcome: 'enrolled' | 'visible' | 'ambiguous' | 'completed';
  checkpoint: 'pending' | 'advanced' | 'lost' | 'stopped';
}>;

export type HomeCoverage = Readonly<{
  partition: number;
  incarnation: IndexIncarnation;
  revision: bigint;
  current: CoverageHome | null;
  fence: StructuralFence | null;
  verified: CoverageHome | null;
  coveredThrough: CoverageCheckpoint | null;
  attempt: ApplyAttempt | null;
}>;

/** One allocation fence per controlled prefix, retained when retired generation rows are reclaimed. */
export type CoveragePrefixControl = Readonly<{
  prefix: string;
  revision: bigint;
  issuedGeneration: number;
}>;

/** Bounded lifecycle lineage; complete means actual replay/audit completed, never equal counts. */
export type PopulationLineage = Readonly<{
  incarnation: IndexIncarnation;
  revision: bigint;
  state: 'populating' | 'live' | 'quarantined' | 'retiring' | 'retired';
  origin: 'created-empty' | 'replay' | 'audit';
  partition: number;
  after: string | null;
  complete: boolean;
}>;

export type CoverageRead =
  | { state: 'not_ready' }
  | { state: 'ready'; incarnation: IndexIncarnation; basis: { digest: string } };

export type ProjectionOptions = Readonly<{
  pool: Pool;
  search: OpenSearch;
  source: SubjectSource;
  listing: SubjectListingSource;
  prefix: string;
}>;

export interface SubjectProjectionCoordinator {
  /** One existing projectBatch path, including enrollment before any source read or external I/O. */
  run(incarnation: IndexIncarnation, partition: number): Promise<BatchResult>;
  /** One durable bounded population step; no caller-supplied subjects, checkpoints or ready evidence. */
  populate(incarnation: IndexIncarnation): Promise<{ state: 'more' | 'complete' }>;
  /** Capture/revalidate real native metadata and conditionally promote completed home evidence. */
  certify(incarnation: IndexIncarnation, options: { deadline: number }): Promise<CoverageRead>;
}

function unavailable(): never {
  throw new ProblemError('index_not_ready', { headers: { 'retry-after': '1' } });
}

/** Honest specification stub. Neither helper nor worker can mint provenance through this module yet. */
export function createSubjectProjectionCoordinator(_options: ProjectionOptions): SubjectProjectionCoordinator {
  return {
    async run(_incarnation, _partition) {
      unavailable();
    },
    async populate(_incarnation) {
      unavailable();
    },
    async certify(_incarnation, _options) {
      unavailable();
    },
  };
}

/** Must create a never-used physical target and persist observed UUID/protocol before any writer starts. */
export async function initializeSubjectIncarnation(
  _options: ProjectionOptions,
  _generation: number,
): Promise<IndexIncarnation> {
  unavailable();
}

/** Reader only: no replay, drain, source enumeration or raw engine search. */
export async function readSubjectCoverage(
  _options: Pick<ProjectionOptions, 'pool' | 'search' | 'prefix'>,
  _read: { deadline: number },
): Promise<CoverageRead> {
  unavailable();
}

/** Lifecycle publication checks real coverage and exact physical identity before switching the alias. */
export async function activateSubjectIncarnation(
  _options: ProjectionOptions,
  _incarnation: IndexIncarnation,
): Promise<void> {
  unavailable();
}

/** Conditional retirement fences writers and publication; uncertain requests never authorize name reuse. */
export async function retireSubjectIncarnation(
  _options: ProjectionOptions,
  _incarnation: IndexIncarnation,
): Promise<void> {
  unavailable();
}
