import type { Pool } from 'pg';
import { ProblemError } from '../http/problem.ts';
import type {
  ApplyAttempt,
  CoverageCheckpoint,
  CoverageHome,
  CoveragePrefixControl,
  HomeCoverage,
  IndexIncarnation,
  PopulationLineage,
  StructuralFence,
} from './coverage.ts';

/** Coordinator observations, not a certificate or permission to publish; observed native generation 0 is valid. */
export type CoverageObservation = Readonly<{
  current: CoverageHome;
  fence: StructuralFence;
  coveredThrough: CoverageCheckpoint;
}>;

/** Every mutation compares the complete physical identity and lifecycle revision. */
export type CoverageGuard = Readonly<{ incarnation: IndexIncarnation; lineageRevision: bigint }>;
export type HomeGuard = CoverageGuard & Readonly<{ partition: number; revision: bigint }>;

/**
 * Current state only. null means absent/CAS lost, false means CAS lost; invalid input rejects.
 * Revisions start at 1 and increment on every successful mutation. Missing home revision is 0.
 * No method reads native identity, performs engine I/O, advances core checkpoints or certifies Scope.
 */
export interface CoverageStore {
  readPrefix(prefix: string): Promise<CoveragePrefixControl | null>;
  /** Missing prefix has revision 0; generation must exceed the retained allocation fence. */
  allocate(prefix: string, revision: bigint, generation: number): Promise<CoveragePrefixControl | null>;
  readLineage(incarnation: IndexIncarnation): Promise<PopulationLineage | null>;
  /** Exact latest allocation revision; at most three retained incarnations, including retiring ones. */
  register(
    control: CoveragePrefixControl,
    incarnation: IndexIncarnation,
    origin: PopulationLineage['origin'],
  ): Promise<PopulationLineage | null>;
  /** CAS frontier; only populating, partition 0..4095 (4096 only for complete), after UUID or null. */
  population(
    guard: CoverageGuard,
    frontier: Pick<PopulationLineage, 'partition' | 'after' | 'complete'>,
  ): Promise<PopulationLineage | null>;
  /** populating -> live only when complete; populating/live -> quarantined; any nonretired -> retiring. */
  transition(guard: CoverageGuard, state: 'live' | 'quarantined' | 'retiring'): Promise<PopulationLineage | null>;
  /** Only retiring, with no new enroll/settle/promote possible; deletes <=4096 homes and the lineage. */
  reclaim(guard: CoverageGuard): Promise<boolean>;
  readHome(incarnation: IndexIncarnation, partition: number): Promise<HomeCoverage | null>;
  /** Only populating/live; pending or ambiguous slot cannot be replaced, even by the same ID. */
  enroll(guard: HomeGuard, attempt: ApplyAttempt): Promise<HomeCoverage | null>;
  /** Exact attempt ID; enrolled -> visible/ambiguous, ambiguous -> visible on actual resolution only. */
  outcome(
    guard: HomeGuard,
    attemptId: string,
    observation: { outcome: 'visible' | 'ambiguous'; source: CoverageHome | null; fence: StructuralFence | null },
  ): Promise<HomeCoverage | null>;
  /** Visible only; records actual core CAS result, including loss, and completes this attempt. */
  complete(
    guard: HomeGuard,
    attemptId: string,
    checkpoint: 'advanced' | 'lost' | 'stopped',
  ): Promise<HomeCoverage | null>;
  /** Live only, completed attempt ID; exact source/current/fence/barrier agreement, no unresolved slot. */
  promote(guard: HomeGuard, attemptId: string, observation: CoverageObservation): Promise<HomeCoverage | null>;
}

/** Honest unavailable specification stub; never returns simulated durable state. */
export function createCoverageStore(_pool: Pool): CoverageStore {
  const unavailable = async (): Promise<never> => {
    throw new ProblemError('index_not_ready', { headers: { 'retry-after': '1' } });
  };
  return {
    readPrefix: unavailable,
    allocate: unavailable,
    readLineage: unavailable,
    register: unavailable,
    population: unavailable,
    transition: unavailable,
    reclaim: unavailable,
    readHome: unavailable,
    enroll: unavailable,
    outcome: unavailable,
    complete: unavailable,
    promote: unavailable,
  };
}
