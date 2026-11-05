import type { Pool } from 'pg';
import { createCoverageProjection, observeCoverageHome } from './coverage-projection.ts';
import type { BatchResult } from '../events/log.ts';
import { ProblemError } from '../http/problem.ts';
import { requireAccessDeadline } from '../access/unavailable.ts';
import { readIdentityBasis } from '../semantic/identity-basis.ts';
import { createCoverageStore, type HomeGuard } from './coverage-store.ts';
import * as codec from './coverage-store-codec.ts';
import { createSubjectIndex, subjectAlias, subjectIndexName } from './indices.ts';
import { OpenSearchError, SearchUnavailableError, type OpenSearch } from './opensearch.ts';
import { subjectConsumer } from './consumer-name.ts';
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
  outcome: 'enrolled' | 'visible' | 'ambiguous' | 'completed' | 'aborted' | 'skipped';
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

async function physicalUuid(search: OpenSearch, index: string): Promise<string> {
  const { status, body } = await search.request<Record<string, { settings?: { index?: { uuid?: string } } }>>(
    'GET',
    `/${index}/_settings`,
  );
  const uuid = body[index]?.settings?.index?.uuid;
  if (status !== 200 || Object.keys(body).length !== 1 || typeof uuid !== 'string' || !uuid)
    throw new SearchUnavailableError('Subject physical identity is unavailable');
  return uuid;
}

async function coverHome(
  options: ProjectionOptions,
  incarnation: IndexIncarnation,
  partition: number,
  lineageRevision: bigint,
): Promise<void> {
  const store = createCoverageStore(options.pool);
  const observed = await observeCoverageHome(options.pool, partition);
  if (observed.pending !== 0n) unavailable();
  const existing = await store.readHome(incarnation, partition);
  if (existing?.verified && codec.equal(existing.verified, observed.source)) return;
  if (
    existing?.attempt?.outcome === 'completed' &&
    existing.current &&
    existing.fence &&
    codec.equal(existing.current, observed.source) &&
    existing.fence.epoch === observed.source.epoch &&
    existing.fence.generation === observed.source.generation
  )
    return;
  if (existing?.attempt && ['enrolled', 'ambiguous'].includes(existing.attempt.outcome)) unavailable();
  const guard: HomeGuard = {
    incarnation,
    lineageRevision,
    partition,
    revision: existing?.revision ?? 0n,
  };
  const slot = {
    id: crypto.randomUUID(),
    from: { epoch: observed.fence.epoch, position: 0n },
    through: { epoch: observed.fence.epoch, position: observed.fence.position },
    source: null,
    outcome: 'enrolled' as const,
    checkpoint: 'pending' as const,
  };
  const enrolled = await store.enroll(guard, slot);
  if (!enrolled) unavailable();
  const visible = await store.outcome({ ...guard, revision: enrolled.revision }, slot.id, {
    outcome: 'visible',
    source: observed.source,
    fence: observed.fence,
  });
  if (!visible) {
    await store.settleNoWrite({ ...guard, revision: enrolled.revision }, slot.id, {
      outcome: 'aborted',
      checkpoint: 'pending',
    });
    unavailable();
  }
  if (!(await store.complete({ ...guard, revision: visible.revision }, slot.id, 'advanced'))) unavailable();
}

async function populateSubjectIncarnation(
  options: ProjectionOptions,
  incarnation: IndexIncarnation,
): Promise<{ state: 'more' | 'complete' }> {
  const store = createCoverageStore(options.pool);
  const lineage = await store.readLineage(incarnation);
  if (!lineage || lineage.state === 'retiring' || lineage.state === 'quarantined') unavailable();
  if (lineage.complete) return { state: 'complete' };
  let current = lineage;
  const start = current.partition;
  const nonempty = await options.pool.query<{ partition_no: number }>(
    'SELECT partition_no FROM core.partition WHERE position>0 AND partition_no>=$1 AND partition_no<4096 ORDER BY partition_no LIMIT 1',
    [start],
  );
  const next = nonempty.rows[0]?.partition_no;
  const end = next ?? 4096;
  for (let partition = start; partition < end; partition++)
    await coverHome(options, incarnation, partition, current.revision);
  if (next !== undefined && next > start) {
    const skipped = await store.population(
      { incarnation, lineageRevision: current.revision },
      { partition: next, after: null, complete: false },
    );
    if (!skipped) unavailable();
    current = skipped;
  }
  if (next !== undefined) {
    const projection = createCoverageProjection(options);
    let result: BatchResult;
    do {
      result = await projection.run(incarnation, next);
      if (result.status === 'busy') return { state: 'more' };
      if (result.status === 'stopped') unavailable();
    } while (result.status === 'read' && result.envelopes > 0);
    current = (await store.readLineage(incarnation)) ?? current;
    await coverHome(options, incarnation, next, current.revision);
  }
  const frontier = next === undefined ? 4096 : next + 1;
  const complete = frontier >= 4096;
  const advanced = await store.population(
    { incarnation, lineageRevision: current.revision },
    { partition: complete ? 4096 : frontier, after: null, complete },
  );
  if (!advanced) unavailable();
  return { state: complete ? 'complete' : 'more' };
}

async function homesReady(
  options: Pick<ProjectionOptions, 'pool'>,
  incarnation: IndexIncarnation,
  deadline: number,
  promote: boolean,
): Promise<boolean> {
  const store = createCoverageStore(options.pool);
  for (let partition = 0; partition < 4096; partition++) {
    requireAccessDeadline(deadline);
    const observed = await observeCoverageHome(options.pool, partition);
    if (observed.pending !== 0n) return false;
    let row = await store.readHome(incarnation, partition);
    if (row?.attempt && ['enrolled', 'ambiguous'].includes(row.attempt.outcome) && row.attempt.checkpoint === 'pending')
      return false;
    if (
      promote &&
      row?.attempt?.outcome === 'completed' &&
      row.verified === null &&
      row.current &&
      row.fence &&
      codec.equal(row.current, observed.source) &&
      codec.equal(row.attempt.source, observed.source) &&
      row.fence.epoch === observed.source.epoch &&
      row.fence.generation === observed.source.generation &&
      row.attempt.through.position >= row.fence.position &&
      row.attempt.through.position <= observed.fence.position
    ) {
      const lineage = await store.readLineage(incarnation);
      if (!lineage) return false;
      const promoted = await store.promote(
        { incarnation, lineageRevision: lineage.revision, partition, revision: row.revision },
        row.attempt.id,
        { current: row.current, fence: row.fence, coveredThrough: row.attempt.through },
      );
      if (promoted) row = promoted;
    }
    if (
      !row?.verified ||
      !row.fence ||
      !row.coveredThrough ||
      !codec.equal(row.verified, observed.source) ||
      row.fence.epoch !== observed.source.epoch ||
      row.fence.generation !== observed.source.generation ||
      row.coveredThrough.position < row.fence.position ||
      row.coveredThrough.position > observed.fence.position
    )
      return false;
  }
  return true;
}

async function certifySubjectIncarnation(
  options: ProjectionOptions,
  incarnation: IndexIncarnation,
  read: { deadline: number },
): Promise<CoverageRead> {
  requireAccessDeadline(read.deadline);
  try {
    if ((await physicalUuid(options.search, incarnation.index)) !== incarnation.uuid) return { state: 'not_ready' };
  } catch {
    return { state: 'not_ready' };
  }
  const store = createCoverageStore(options.pool);
  let lineage = await store.readLineage(incarnation);
  if (!lineage || !lineage.complete) return { state: 'not_ready' };
  if (lineage.state === 'populating') {
    const live = await store.transition({ incarnation, lineageRevision: lineage.revision }, 'live');
    if (!live) return { state: 'not_ready' };
    lineage = live;
  }
  if (lineage.state !== 'live') return { state: 'not_ready' };
  const before = await readIdentityBasis(options.pool, { deadline: read.deadline });
  if (before.state !== 'ready') return { state: 'not_ready' };
  if (!(await homesReady(options, incarnation, read.deadline, true))) return { state: 'not_ready' };
  const after = await readIdentityBasis(options.pool, { deadline: read.deadline });
  if (after.state !== 'ready' || after.basis.digest !== before.basis.digest) return { state: 'not_ready' };
  return { state: 'ready', incarnation, basis: before.basis };
}

/** Shared coordinator: population, guarded projection and independent certification. */
export function createSubjectProjectionCoordinator(options: ProjectionOptions): SubjectProjectionCoordinator {
  const projection = createCoverageProjection(options);
  return {
    run: projection.run,
    populate: (incarnation) => populateSubjectIncarnation(options, incarnation),
    certify: (incarnation, read) => certifySubjectIncarnation(options, incarnation, read),
  };
}

/** Must create a never-used physical target and persist observed UUID/protocol before any writer starts. */
export async function initializeSubjectIncarnation(
  options: ProjectionOptions,
  generation: number,
): Promise<IndexIncarnation> {
  const prefix = codec.prefix(options.prefix);
  const issued = codec.integer(generation, 1, Number.MAX_SAFE_INTEGER);
  const index = subjectIndexName(prefix, issued);
  try {
    await options.search.request('HEAD', `/${index}`);
    unavailable();
  } catch (error) {
    if (error instanceof ProblemError) throw error;
    if (!(error instanceof OpenSearchError) || error.status !== 404) throw error;
  }
  const store = createCoverageStore(options.pool);
  const retained = await options.pool.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM search.index_incarnation WHERE partition_no=0 AND prefix=$1',
    [prefix],
  );
  if ((retained.rows[0]?.n ?? 0) >= 3) unavailable();
  const current = await store.readPrefix(prefix);
  const allocated = await store.allocate(prefix, current?.revision ?? 0n, issued);
  if (!allocated) unavailable();
  await createSubjectIndex(options.search, prefix, issued);
  const incarnation: IndexIncarnation = {
    prefix,
    generation: issued,
    index,
    uuid: await physicalUuid(options.search, index),
    protocol: 'subject-coverage-v1',
    consumer: subjectConsumer(prefix, issued),
  };
  const lineage = await store.register(allocated, incarnation, 'created-empty');
  if (!lineage) unavailable();
  return incarnation;
}

/** Reader only: no replay, drain, source enumeration or raw engine search. */
export async function readSubjectCoverage(
  options: Pick<ProjectionOptions, 'pool' | 'search' | 'prefix'>,
  read: { deadline: number },
): Promise<CoverageRead> {
  requireAccessDeadline(read.deadline);
  const prefix = codec.prefix(options.prefix);
  let index: string;
  let uuid: string;
  try {
    const settings = await options.search.request<Record<string, { settings?: { index?: { uuid?: string } } }>>(
      'GET',
      `/${subjectAlias(prefix)}/_settings`,
    );
    const names = Object.keys(settings.body);
    index = names[0] ?? '';
    uuid = settings.body[index]?.settings?.index?.uuid ?? '';
    if (settings.status !== 200 || names.length !== 1 || !uuid) return { state: 'not_ready' };
  } catch {
    return { state: 'not_ready' };
  }
  const store = createCoverageStore(options.pool);
  const control = await store.readPrefix(prefix);
  if (!control) return { state: 'not_ready' };
  let incarnation: IndexIncarnation | undefined;
  for (let generation = 1; generation <= control.issuedGeneration; generation++) {
    const candidate: IndexIncarnation = {
      prefix,
      generation,
      index: subjectIndexName(prefix, generation),
      uuid,
      protocol: 'subject-coverage-v1',
      consumer: subjectConsumer(prefix, generation),
    };
    if (candidate.index !== index) continue;
    if (await store.readLineage(candidate)) {
      incarnation = candidate;
      break;
    }
  }
  if (!incarnation) return { state: 'not_ready' };
  const lineage = await store.readLineage(incarnation);
  if (!lineage || !lineage.complete || lineage.state !== 'live') return { state: 'not_ready' };
  const basis = await readIdentityBasis(options.pool, { deadline: read.deadline });
  if (basis.state !== 'ready') return { state: 'not_ready' };
  if (!(await homesReady(options, incarnation, read.deadline, false))) return { state: 'not_ready' };
  const after = await readIdentityBasis(options.pool, { deadline: read.deadline });
  if (after.state !== 'ready' || after.basis.digest !== basis.basis.digest) return { state: 'not_ready' };
  return { state: 'ready', incarnation, basis: basis.basis };
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
