import {
  advanceNativeGenerationSource,
  PUBLIC_FILTER_PREPARATION_INPUT_LIMIT,
  PUBLIC_FILTER_PREPARATION_INPUT_RESERVE,
} from './public-filter-consumer.ts';
import {
  advanceNativePublicFilterPreparation,
  captureHeldSubjectRange,
  planColdSubjectEnrollment,
  prepareHeldSubjectRange,
  reconcileHeldSubjectPage,
  reserveHeldSubjectPreparation,
} from './native-bindings.ts';
import {
  bindSearchWriterPublicationReader,
  nativeSourceForHeldPublication,
  readSearchWriterGenerationActions,
} from './writer-guard.ts';
import {
  matchSparseSubjectKeys,
  readSparseSubjectCut,
  SPARSE_SUBJECT_KEYS,
  type SparseSubjectCut,
} from './generation-publication-sparse.ts';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { releaseDigest } from '@rezics/definitions';
import { hasNativePublicFilterMeaning } from './public-filter-meaning.ts';
import { bookPreparationTiming } from './book-preparation-timing.ts';
import { publicFilterCatalogue } from './discovery-catalogue.ts';
import type { Pool, PoolClient } from 'pg';
import type { KernelClock } from '../clock.ts';
import { withBoundedReadLifetime } from '../database/bounded-read-lifetime.ts';
import { withBoundedReadConnection } from '../database/pool.ts';
import { withRequestDeadline } from '../request/deadline.ts';
import { routeOf, partitionOf } from '../route/route.ts';
import { readAccountDiscoveryWitness } from './native-bindings.ts';
import { subjectListingSource } from '../library/listing-counts.ts';
import type { ColdEnrollmentStage } from '../semantic/public-filter-coverage-baseline.ts';
import type { PublicFilterConsumer } from '../semantic/index.ts';
import { IdentityEpochStoreError } from '../semantic/contract/identity-errors.ts';
import type {
  SearchNativePublicationCompletionReader,
  SearchPublicFilterCost,
  SearchPublicFilterProjectionMeaning,
  SearchPublicFilterSource,
  SearchPublicFilterSourceBinding,
  SearchPublicFilterSourceDefinition,
  SearchPublicFilterSourceKeyCursor,
  SearchPublicFilterSourceKeyPages,
} from './semantic-source-port.ts';
import type {
  PublicCanonicalCaptureInput,
  PublicFilterConsumerCaptureInput,
  PublicFilterConsumerContext,
  PublicFilterConsumerUnavailable,
} from './public-filter-consumer-contract.ts';
import type { SearchWriterPublicationFence, SearchWriterPublicationGuard } from './writer-guard.ts';
import type { DiscoveryConsumerCaptureInput, DiscoveryKey, DiscoveryRegistry, DiscoveryUnionKey } from './discovery.ts';
import { createDiscoveryProjection, validateAccountPage } from './account-discovery.ts';
import { parseDiscoveryHitIdentity, discoveryDocumentId, validateDiscoveryDocument } from './discovery-documents.ts';
import {
  nativeGenerationActions,
  observedWrite,
  assertNativeGenerationActionsVisible,
  GenerationReconciliationMismatch,
} from './generations.ts';
import {
  encodePublicFilterNativeState,
  readGenerationPublicationCustody,
  readWithPublicationWriterRepair,
} from './public-filter-custody.ts';
import {
  classifyGenerationCoverage,
  decodeGenerationPublicationQueried,
  encodeGenerationPublicationQueried,
  publicationPinFromNative,
  sameGenerationPublicationPin,
  type GenerationPublicationPin,
} from './generation-publication-pin.ts';
import { discoveryAlias } from './indices.ts';
import {
  discoveryIndexName,
  discoveryIndexUuid,
  markSubjectCalendarReady,
  subjectAlias,
  subjectIndexName,
  subjectGenerations,
  readSubjectSortFormat,
  readSubjectActivationTime,
  setSubjectPublicationRefresh,
  SUBJECT_SORT_FORMAT,
} from './indices.ts';
import { discoveryGenerations } from './generations.ts';
import { OpenSearchError, SearchUnavailableError, type OpenSearch } from './opensearch.ts';
import { assertCompleteSearch } from './complete-search.ts';
import { validateObservation } from './indexer.ts';
import { validateRefreshResponse } from './write-actions.ts';
import type { CreditSearchSource } from './credit-search.ts';

export type GenerationPublicationJob = Readonly<{ consumer: PublicFilterConsumer; job: string }>;
type HeldLane = 'capture' | 'source';
export type SearchGenerationPublication = Readonly<{
  prepare(
    consumer: PublicFilterConsumer,
    context: PublicFilterConsumerContext,
  ): Promise<
    | { status: 'preparing'; job: GenerationPublicationJob; cost: SearchPublicFilterCost }
    | PublicFilterConsumerUnavailable
  >;
  step(
    job: GenerationPublicationJob,
    context: PublicFilterConsumerContext,
    options?: Readonly<{ enrollSource: boolean; batchSource?: boolean; heldOffers?: number; heldLane?: HeldLane }>,
  ): Promise<
    | {
        status: 'progress' | 'reconciled';
        job: GenerationPublicationJob;
        cost: SearchPublicFilterCost;
        sourceAdvanced?: boolean;
        additionalEnrollmentCosts?: readonly SearchPublicFilterCost[];
      }
    | (PublicFilterConsumerUnavailable & { additionalEnrollmentCosts?: readonly SearchPublicFilterCost[] })
  >;
  activate(
    job: GenerationPublicationJob,
    context: PublicFilterConsumerContext,
    options?: Readonly<{ batchSource: boolean }>,
  ): Promise<
    | { status: 'activated'; consumer: PublicFilterConsumer; cost: SearchPublicFilterCost }
    | { status: 'superseded'; consumer: PublicFilterConsumer; cost: SearchPublicFilterCost }
    | {
        status: 'preparing';
        job: GenerationPublicationJob;
        cost: SearchPublicFilterCost;
        next?: 'step' | 'activate';
        advanced?: boolean;
        sourceAdvanced?: boolean;
        additionalSourceCosts?: readonly SearchPublicFilterCost[];
      }
    | PublicFilterConsumerUnavailable
  >;
  close(): Promise<void>;
}>;
export type SearchGenerationPublicationConfig = Readonly<{
  pool: Pool;
  search: OpenSearch;
  source: SearchPublicFilterSource;
  sourceKeys: SearchPublicFilterSourceKeyPages;
  binding: SearchPublicFilterSourceBinding;
  readPublicationCompletion: SearchNativePublicationCompletionReader;
  clock: KernelClock;
  meaning: SearchPublicFilterProjectionMeaning;
  writerGuard: SearchWriterPublicationGuard;
  subjectAckProtocol?: 1;
  subjectSubscriptionProtocol?: 1;
  creditSearch?: CreditSearchSource;
  registry?: DiscoveryRegistry;
}>;

const validationBytes = Symbol('validationBytes');
const enrollmentOffers = Symbol('enrollmentOffers');
type Meter = { -readonly [K in keyof SearchPublicFilterCost]: number } & {
  [validationBytes]: number;
  [enrollmentOffers]?: Meter[];
};
const cost = (): Meter => ({
  inputKeys: 0,
  candidates: 0,
  accessPoints: 0,
  dependencyPoints: 0,
  engineSearches: 0,
  engineIteratorSteps: 0,
  outputSlots: 0,
  resultWrites: 0,
  frontierWrites: 0,
  [validationBytes]: 0,
});
const PAGE = 50;
const SUBJECT_ENROLLMENT_PAGES = 32;
const SUBJECT_ENROLLMENT_FRONTIER_INPUTS = 7;
const SUBJECT_ENROLLMENT_TARGET_INPUTS = 4;
const SUBJECT_ENROLLMENT_CHECKPOINT_INPUTS = SUBJECT_ENROLLMENT_FRONTIER_INPUTS + SUBJECT_ENROLLMENT_TARGET_INPUTS;
const SUBJECT_ENROLLMENT_SCAN_INPUTS =
  5 * PAGE + SUBJECT_ENROLLMENT_FRONTIER_INPUTS + SUBJECT_ENROLLMENT_CHECKPOINT_INPUTS;
const SUBJECT_ENROLLMENT_SCAN_TURNS = 4;
const SUBJECT_SETTLEMENT_TURNS = 8;
const SUBJECT_VALIDATION_HOMES = 256;
const SUBJECT_VALIDATION_SLICES = 4;
const VALIDATION_BYTE_LIMIT = 4 * 1024 * 1024;
// Three native target reads and the frontier checkpoint. The SQL comparison
// only returns fixed-width heads, revisions, ownership state and refresh flags.
const SUBJECT_VALIDATION_TRAILING_INPUTS = 4;
const SUBJECT_VALIDATION_ROW_BYTES = 512;
const SUBJECT_VALIDATION_SQL_BYTES = 4096;
const SUBJECT_VALIDATION_CHECKPOINT_BYTES = 4096;
// One bounded writer inventory, one Source page, and keyed proof with one engine lookahead.
const SUBJECT_VALIDATION_RECHECK_INPUTS = 6 * PAGE + 1;
const SUBJECT_VALIDATION_RECHECK_SQL_BYTES = 4096;
const SUBJECT_VALIDATION_REPLAY = 'subject-validation-replay';
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const same = isDeepStrictEqual;
class Pending extends Error {
  constructor(readonly reason: PublicFilterConsumerUnavailable['reason']) {
    super(reason);
  }
}
class ChangedSparseCut extends Pending {
  constructor(readonly cut: SparseSubjectCut) {
    super('source_pending');
  }
}
const publicationLifetime = {
  deadlineError: () => new Pending('deadline'),
  mapError: (error: unknown) =>
    error instanceof Error && error.message === 'Query read timeout' ? new Pending('deadline') : error,
  // A native timeout or transport failure may settle before the absolute-deadline timer fires.
  isUncertainSettledQueryError: () => true,
};
function requireValue(value: unknown): asserts value {
  if (!value) throw new TypeError('Invalid generation publication input');
}
function check(context: PublicFilterConsumerContext) {
  requireValue(Number.isFinite(context.deadline));
  if (context.deadline <= Date.now()) throw new Pending('deadline');
}
function add(meter: Meter, value: SearchPublicFilterCost) {
  for (const key of Object.keys(meter) as (keyof SearchPublicFilterCost)[]) {
    requireValue(Number.isSafeInteger(value[key]) && value[key] >= 0);
    meter[key] += value[key];
  }
  if ('bytes' in value && typeof value.bytes === 'number') meter[validationBytes] += value.bytes;
  if (meter.inputKeys > 1000 || meter.resultWrites > 1000) throw new Pending('dependency_unavailable');
}
function locator(consumer: PublicFilterConsumer) {
  requireValue(object(consumer));
  const keys = Object.keys(consumer);
  const expected = new Set([
    'physicalTarget',
    'incarnation',
    'consumerGeneration',
    'projectionGeneration',
    'meaningDigest',
    'readDefinition',
    ...(Object.hasOwn(consumer, 'catalogue') ? ['catalogue'] : []),
  ]);
  requireValue(
    keys.length === expected.size &&
      keys.every((key) => expected.has(key)) &&
      Buffer.byteLength(JSON.stringify(consumer)) <= 2048,
  );
  publicFilterCatalogue(consumer);
  for (const key of ['physicalTarget', 'incarnation', 'consumerGeneration', 'projectionGeneration'] as const)
    requireValue(typeof consumer[key] === 'string' && consumer[key].length > 0 && consumer[key].length <= 255);
  requireValue(
    typeof consumer.meaningDigest === 'string' &&
      consumer.meaningDigest.length <= 128 &&
      typeof consumer.readDefinition === 'string' &&
      consumer.readDefinition.length > 0 &&
      consumer.readDefinition.length <= 1024,
  );
  const match = /^([a-z0-9][a-z0-9-]{0,47})(subjects|discovery)-g([1-9][0-9]*)$/.exec(consumer.physicalTarget);
  requireValue(match && match[0] === consumer.physicalTarget);
  const prefix = match[1]!,
    family = match[2] as 'subjects' | 'discovery',
    generation = Number(match[3]);
  requireValue(Number.isSafeInteger(generation) && generation > 0);
  requireValue(
    (family === 'subjects' ? subjectIndexName : discoveryIndexName)(prefix, generation) === consumer.physicalTarget,
  );
  return { prefix, family, generation, readDefinition: consumer.readDefinition };
}
function bindingKey(definition: SearchPublicFilterSourceDefinition) {
  return {
    source: definition.source,
    meaning: { digest: definition.meaning.digest },
    readDefinition: definition.readDefinition,
  };
}
type Job = {
  subscription_protocol: number;
  subject_fenced_cut: Buffer | null;
  job: string;
  physical_target: string;
  consumer: PublicFilterConsumer;
  prefix: string;
  generation: string;
  family: 'subjects' | 'discovery';
  native_incarnation: string;
  pass: string;
  activated_at: string;
  kinds: string[];
  source_home: number;
  binding: ReturnType<typeof bindingKey>;
  phase: 'subject' | 'account' | 'engine' | 'validate' | 'reconciled' | 'fencing' | 'intent' | 'active';
  home: number;
  after_route: number | null;
  after_id: string | null;
  engine_after: Record<string, unknown> | null;
  pit: string | null;
  fence: string | null;
  fenced_pass: boolean;
  observation: string | null;
  previous_target: string | null;
  previous_uuid: string | null;
  bootstrap: string | null;
  queried: string | null;
  execution: string | null;
  revision: string;
};
type Home = { partition: number; epoch: number; position: string; account_revision: string; claim_revision: string };
type SubjectEnrollmentFrontier = { registration: string; bootstrap: string; end: number };

/** Preserve released projection metadata when publishing the durable activation timestamp. */
export async function publishSubjectActivationMetadata(search: OpenSearch, index: string, activatedAt: string) {
  const mapping = async () => {
    const response = await search.request<Record<string, { mappings?: { _meta?: Record<string, unknown> } }>>(
      'GET',
      `/${index}/_mapping`,
    );
    const meta = response.body[index]?.mappings?._meta;
    if (response.status !== 200 || Object.keys(response.body).length !== 1 || !object(meta))
      throw new Error('Generation activation mapping is missing or malformed');
    return meta;
  };
  const current = await mapping();
  if (current.name_sort_format === SUBJECT_SORT_FORMAT && current.activated_at === activatedAt) return;
  const metadata = { ...current, name_sort_format: SUBJECT_SORT_FORMAT, activated_at: activatedAt };
  await observedWrite(
    () => search.request('PUT', `/${index}/_mapping`, { _meta: metadata }),
    async () => same(await mapping(), metadata),
    'Generation activation metadata could not be established',
  );
}

/** A single native publication port for worker and CLI composition. It owns no supplied resources. */
export function createSearchGenerationPublication(
  config: SearchGenerationPublicationConfig,
): SearchGenerationPublication {
  requireValue(
    config &&
      config.pool &&
      config.search &&
      config.source &&
      config.sourceKeys &&
      config.binding &&
      typeof config.readPublicationCompletion === 'function' &&
      typeof config.clock === 'function' &&
      config.writerGuard &&
      typeof config.writerGuard.write === 'function',
  );
  const nativeMeaning = hasNativePublicFilterMeaning(config.meaning);
  if (!nativeMeaning) requireValue(config.meaning.digest === releaseDigest(config.meaning.release));
  const { pool, search, source, sourceKeys, binding, readPublicationCompletion, writerGuard, registry } = config;
  bindSearchWriterPublicationReader(writerGuard, readPublicationCompletion, async (request, context) => {
    // Reopen the exact terminal verification under the native Subject maintenance allowance.
    // An outstanding ordinary write can only be repaired after releasing this fence.
    const { result, writer } = await readWithPublicationWriterRepair(request.job, () =>
      readPublicationCompletion(request, context),
    );
    return writer && result.status === 'pending' ? { ...result, advanced: false } : result;
  });
  const meaning = nativeMeaning ? config.meaning : structuredClone(config.meaning);
  const kinds = registry
    ? registry.entries.map(({ kind, owner }) => ({ kind, owner })).sort((a, b) => a.kind.localeCompare(b.kind))
    : Object.keys(meaning.release.types)
        .sort()
        .map((kind) => ({ kind, owner: 'semantic' as const }));
  if (registry) {
    requireValue(registry.get('account').owner === 'accounts');
    for (const entry of registry.entries)
      requireValue(
        registry.get(entry.kind) === entry &&
          (entry.owner === 'accounts' ? entry.kind === 'account' : Object.hasOwn(meaning.release.types, entry.kind)),
      );
    requireValue(new Set(kinds.map(({ kind }) => kind)).size === kinds.length);
  }
  const producers = registry?.entries.map(({ kind, owner, source }) => ({ kind, owner, source }));
  let closed = false;
  const pending = new Set<Promise<unknown>>();
  async function run<T>(
    context: PublicFilterConsumerContext,
    work: (meter: Meter) => Promise<T>,
  ): Promise<T | PublicFilterConsumerUnavailable> {
    const meter = cost();
    if (closed) return { status: 'unavailable', reason: 'dependency_unavailable', cost: meter };
    const operation = withRequestDeadline(context.deadline, async () => {
      try {
        check(context);
        const result = await work(meter);
        add(meter, cost());
        return result;
      } catch (error) {
        if (error instanceof TypeError || error instanceof RangeError) throw error;
        const reason =
          error instanceof Pending
            ? error.reason
            : error instanceof OpenSearchError && error.status === 404
              ? 'incarnation_changed'
              : 'dependency_unavailable';
        return {
          status:
            reason === 'deadline' || reason === 'dependency_unavailable'
              ? ('unavailable' as const)
              : ('unready' as const),
          reason,
          cost: meter,
          ...(meter[enrollmentOffers]?.length ? { additionalEnrollmentCosts: meter[enrollmentOffers] } : {}),
        };
      }
    });
    pending.add(operation);
    try {
      return await operation;
    } finally {
      pending.delete(operation);
    }
  }
  async function engine<T>(
    context: PublicFilterConsumerContext,
    meter: Meter,
    method: Parameters<OpenSearch['request']>[0],
    path: string,
    body?: unknown,
  ) {
    check(context);
    const searching = path.endsWith('/_search') || path === '/_search';
    if (searching) meter.engineSearches++;
    return search.request<T>(method, path, body, {
      ...(searching ? { query: { allow_partial_search_results: false } } : {}),
      timeoutMs: Math.max(1, context.deadline - Date.now()),
    });
  }
  async function native(consumer: PublicFilterConsumer, context: PublicFilterConsumerContext, transport = search) {
    const target = locator(consumer);
    check(context);
    if (consumer.meaningDigest !== meaning.digest) throw new Pending('registration_missing');
    if (target.family === 'discovery' && !registry) throw new Pending('registration_missing');
    if (
      registry &&
      producers &&
      (registry.entries.length !== producers.length ||
        producers.some((producer) => {
          const entry = registry.get(producer.kind);
          return (
            entry.owner !== producer.owner || entry.source !== producer.source || !registry.entries.includes(entry)
          );
        }))
    )
      throw new Pending('registration_missing');
    if ((await discoveryIndexUuid(transport, consumer.physicalTarget)) !== consumer.incarnation)
      throw new Pending('incarnation_changed');
    let incarnation = consumer.incarnation;
    let activeSubjectGeneration: number | null = null;
    if (target.family === 'discovery') {
      const generations = await discoveryGenerations(pool, target.prefix);
      const row = generations.find((row) => row.generation === target.generation);
      if (
        !row ||
        ['allocated', 'retiring', 'retired', 'quarantined'].includes(row.state) ||
        row.uuid !== consumer.incarnation ||
        !same(row.kinds, kinds.map(({ kind }) => kind).sort())
      )
        throw new Pending('registration_missing');
      const response = await transport.request<Record<string, { mappings?: { _meta?: { incarnation?: string } } }>>(
        'GET',
        `/${consumer.physicalTarget}/_mapping`,
      );
      if (
        response.status !== 200 ||
        Object.keys(response.body).length !== 1 ||
        response.body[consumer.physicalTarget]?.mappings?._meta?.incarnation !== row.incarnation
      )
        throw new Pending('incarnation_changed');
      incarnation = row.incarnation;
    } else {
      const generations = await subjectGenerations(transport, target.prefix);
      activeSubjectGeneration = generations.active;
      if (
        !generations.generations.includes(target.generation) ||
        (await readSubjectSortFormat(transport, target.prefix, target.generation)) !== SUBJECT_SORT_FORMAT
      )
        throw new Pending('registration_missing');
    }
    check(context);
    return { ...target, incarnation, activeSubjectGeneration };
  }
  function publicationCapture(
    capture: PublicCanonicalCaptureInput,
  ): PublicFilterConsumerCaptureInput | DiscoveryConsumerCaptureInput {
    // Suggestion custody has its own canonical prefix semantics and cannot certify all-key population.
    if (!('sort' in capture)) throw new Pending('registration_missing');
    return capture;
  }
  function populationDefinition(definition: SearchPublicFilterSourceDefinition) {
    const capture = publicationCapture(definition.capture);
    if (
      capture.filterDocument !== undefined ||
      capture.text !== undefined ||
      capture.filter !== undefined ||
      capture.query !== undefined ||
      capture.boost !== undefined ||
      capture.after !== undefined
    )
      throw new Pending('source_pending');
    if (definition.meaning.digest !== meaning.digest) throw new Pending('registration_missing');
    return capture;
  }
  async function adopt(
    job: Job,
    context: PublicFilterConsumerContext,
    meter: Meter,
    physical?: Awaited<ReturnType<typeof native>>,
  ) {
    const current = physical ?? (await native(job.consumer, context));
    if (
      current.incarnation !== job.native_incarnation ||
      !same(
        job.kinds,
        kinds.map(({ kind, owner }) => `${owner}:${kind}`),
      )
    )
      throw new Pending('incarnation_changed');
    const custody = await readGenerationPublicationCustody(
      pool,
      job.consumer,
      job.source_home,
      context,
      job.observation ?? undefined,
    );
    add(meter, custody.cost);
    if ('status' in custody) throw new Pending(custody.reason === 'deadline' ? 'deadline' : 'registration_missing');
    // Preparation registered this definition before the job was created.
    const resolved = binding.readDefinition
      ? await binding.readDefinition({ source, id: current.readDefinition }, context)
      : await binding.resolve(
          { source, meaning: structuredClone(meaning), capture: publicationCapture(custody.definition.capture) },
          context,
        );
    add(meter, resolved.cost);
    if (resolved.status !== 'resolved')
      throw new Pending(resolved.reason === 'deadline' ? 'deadline' : 'source_pending');
    const capture = populationDefinition(resolved.definition);
    if (
      !same(bindingKey(resolved.definition), job.binding) ||
      resolved.definition.readDefinition !== job.consumer.readDefinition ||
      !same(resolved.definition.capture, custody.definition.capture) ||
      !same(resolved.definition.dependencyKeys, custody.definition.dependencyKeys)
    )
      throw new Pending('source_pending');
    return { capture, definition: resolved.definition };
  }
  // A separately funded receiver turn can fold ready children without
  // opening another Source observation. A miss releases the lane to repair.
  async function prepareHeldReceiverAck(job: Job, client: PoolClient, meter: Meter) {
    const inputLimit = 824;
    const byteLimit = 848 * 1024;
    meter.inputKeys += inputLimit;
    meter.dependencyPoints += inputLimit;
    meter[validationBytes] += byteLimit;
    meter.resultWrites += 34;
    const ranges = Math.floor(inputLimit / 64);
    meter.frontierWrites += ranges;
    const ack = await client.query<{
      points: number;
      proof_bytes: number;
      range_writes: number;
      result_writes: number;
    }>('SELECT * FROM search.prepare_subject_ack_prefix_v1($1,$2,$3)', [job.job, inputLimit, byteLimit]);
    const page = ack.rows[0]!;
    meter.inputKeys -= inputLimit - page.points;
    meter.dependencyPoints -= inputLimit - page.points;
    meter[validationBytes] -= byteLimit - page.proof_bytes;
    meter.resultWrites -= 34 - page.result_writes;
    meter.frontierWrites -= ranges - page.range_writes;
    return page.range_writes > 0;
  }

  async function completeSource(
    job: Job,
    client: PoolClient,
    context: PublicFilterConsumerContext,
    meter: Meter,
    capture: ReturnType<typeof populationDefinition> | undefined,
    enrollmentOnly = false,
  ) {
    // This turn already adopted the immutable registration. Source still reads its
    // own current custody for enrollment, repair and every original-job ACK.
    if (!capture) throw new Pending('registration_missing');
    const remainingInputs = PUBLIC_FILTER_PREPARATION_INPUT_LIMIT - meter.inputKeys;
    if (remainingInputs <= 0 || (enrollmentOnly && remainingInputs <= PUBLIC_FILTER_PREPARATION_INPUT_RESERVE))
      return { complete: false, advanced: false, sourceAdvanced: false };
    const completion = await advanceNativeGenerationSource(
      {
        pool,
        search,
        source,
        binding,
        clock: config.clock,
        meaning,
        context,
        physicalTarget: job.physical_target,
        ...(config.creditSearch === undefined ? {} : { creditSearch: config.creditSearch }),
        ...(registry ? { registry } : {}),
      },
      {
        job: job.job,
        consumer: job.consumer,
        capture,
        ...(job.observation ? { observation: job.observation } : {}),
        inputLimit: remainingInputs,
        enrollmentOnly,
      },
      context,
    );
    add(meter, completion.cost);
    if ('publication' in completion) {
      const pin = publicationPinFromNative(completion.publication);
      const retained = jobPin(job);
      if (retained && !sameGenerationPublicationPin(retained, pin)) throw new Pending('source_pending');
      if (!retained || !job.observation) {
        if (!retained) persistPin(job, pin);
        if (!job.observation) job.observation = completion.publication.queried.snapshot.observation;
        await save(client, job, meter);
      }
    }
    return {
      complete: completion.status === 'complete',
      advanced: completion.advanced === true,
      sourceAdvanced:
        completion.advanced === true && (completion.enrollmentAdvanced === true || 'publication' in completion),
    };
  }

  function canEnrollSubject(job: Job) {
    return (
      job.subscription_protocol !== 1 &&
      !registry &&
      job.family === 'subjects' &&
      !job.fence &&
      !job.fenced_pass &&
      !job.observation &&
      (job.phase === 'subject' || job.phase === 'engine' || job.phase === 'validate')
    );
  }

  async function continueSubjectEnrollment(
    job: Job,
    client: PoolClient | null,
    context: PublicFilterConsumerContext,
    meter: Meter,
    capturingOnly = false,
    reservedInputs = 0,
  ) {
    const inputs = capturingOnly ? 4 : 2;
    const reserve = Math.max(
      reservedInputs,
      capturingOnly && job.phase === 'validate' ? SUBJECT_VALIDATION_HOMES : PUBLIC_FILTER_PREPARATION_INPUT_RESERVE,
    );
    if (
      !nativeMeaning ||
      registry ||
      job.source_home !== 0 ||
      job.subscription_protocol === 1 ||
      job.bootstrap ||
      (capturingOnly && !hasPublicationGuard()) ||
      !advanceNativePublicFilterPreparation ||
      meter.inputKeys + inputs >= PUBLIC_FILTER_PREPARATION_INPUT_LIMIT - reserve
    )
      return null;
    guardAvailable();
    meter.inputKeys += inputs;
    meter.dependencyPoints += inputs;
    const registration = (connection: PoolClient) =>
      connection.query<{ id: string; bootstrap: string }>(
        `SELECT r.id,r.consumer_bootstrap AS bootstrap FROM search.public_filter_registration r
       JOIN search.public_filter_target t USING(partition_no,physical_target)
       WHERE r.partition_no=0 AND r.physical_target=$1 AND md5(r.consumer)=md5($2) AND r.consumer=$2
         AND r.state='active' AND t.incarnation=$3 AND r.consumer_work IS NOT NULL
         AND r.consumer_bootstrap IS NOT NULL
         AND (NOT $4::boolean OR (
           NOT EXISTS (SELECT FROM search.public_filter_observation o
             WHERE (o.partition_no,o.registration)=(r.partition_no,r.id) AND o.state<>'closed')
           AND NOT EXISTS (SELECT FROM search.identity_writer_gate g
             WHERE (g.partition_no,g.physical_target)=(0,r.physical_target) AND g.publication_fence IS NOT NULL)
         )) LIMIT 2`,
        [job.physical_target, encodePublicFilterNativeState(job.consumer), job.native_incarnation, capturingOnly],
      );
    const { rows } = client
      ? await registration(client)
      : await withBoundedReadConnection(pool, context.deadline, registration, publicationLifetime);
    if (rows.length !== 1) return null;
    const { id, bootstrap } = rows[0]!;
    const result = await advanceNativePublicFilterPreparation(
      binding,
      {
        bootstrap,
        inputLimit: PUBLIC_FILTER_PREPARATION_INPUT_LIMIT - reserve - meter.inputKeys,
        subjectEnrollment: {
          consumer: job.consumer,
          source: job.binding.source,
          registration: { partition: 0, id },
          ...(capturingOnly ? { capturingOnly: true } : {}),
        },
      },
      context,
    );
    if (!result) return null;
    add(meter, result.cost);
    if (result.status === 'enrollment-sealed') return 'sealed' as const;
    if (capturingOnly) {
      if ('reason' in result && result.reason === 'deadline') throw new Pending('deadline');
      return (result.status === 'preparing' || result.status === 'begun') && result.enrollmentAdvanced === true;
    }
    if (
      (result.status === 'begun' && !result.enrollmentAdvanced) ||
      ('reason' in result && (result.reason === 'binding_mismatch' || result.reason === 'observation_lost'))
    )
      return null;
    if (result.status !== 'preparing' && result.status !== 'begun')
      throw new Pending('reason' in result && result.reason === 'deadline' ? 'deadline' : 'source_pending');
    return result.enrollmentAdvanced === true;
  }

  async function subjectEnrollmentFrontier(job: Job, client: PoolClient, meter: Meter) {
    // Source commits the Search preparation edge and both Source cursors together.
    // This keyed read admits work behind that edge. The Subject proof uses current native evidence.
    meter.inputKeys += SUBJECT_ENROLLMENT_FRONTIER_INPUTS;
    meter.dependencyPoints += SUBJECT_ENROLLMENT_FRONTIER_INPUTS;
    const { rows } = await client.query<SubjectEnrollmentFrontier>(
      `SELECT r.id AS registration,r.consumer_bootstrap AS bootstrap,c.after_home AS "end"
       FROM search.public_filter_registration r
       JOIN search.public_filter_target t USING (partition_no,physical_target)
       JOIN search.public_filter_coverage_preparation c
         ON (c.partition_no,c.registration,c.bootstrap)=(r.partition_no,r.id,
           substring(r.consumer_bootstrap FROM '^0:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$')::uuid)
       JOIN semantic.public_filter_bootstrap b ON (b.partition_no,b.bootstrap)=(c.partition_no,c.bootstrap)
       JOIN core.partition p ON (p.partition_no,p.epoch)=(b.partition_no,b.owner_epoch)
       WHERE r.partition_no=0 AND r.physical_target=$1 AND t.incarnation=$2
         AND md5(r.consumer)=md5($3) AND r.consumer=$3 AND r.state='active' AND r.consumer_work IS NOT NULL
         AND c.consumer=r.consumer AND c.definition=$4 AND b.read_definition=c.definition
         AND c.population_protocol=1 AND c.after_home=b.account_after AND c.after_home=b.coverage_after
         AND c.root=b.coverage_root AND c.generation=b.coverage_generation
         AND b.snapshot_kind='prepared' AND b.state IN ('capturing','begun') AND b.coverage_publication IS NULL
         AND b.owner_epoch=$5 AND p.write_state='active' AND b.queried IS NULL AND b.publication_job IS NULL
         AND NOT EXISTS (SELECT FROM search.public_filter_observation o
           WHERE (o.partition_no,o.registration)=(r.partition_no,r.id) AND o.state<>'closed')
         AND NOT EXISTS (SELECT FROM search.identity_writer_gate g
           WHERE (g.partition_no,g.physical_target)=(0,r.physical_target) AND g.publication_fence IS NOT NULL)
       LIMIT 2`,
      [
        job.physical_target,
        job.native_incarnation,
        encodePublicFilterNativeState(job.consumer),
        job.binding.readDefinition,
        job.binding.source.epoch,
      ],
    );
    return rows.length === 1 ? rows[0]! : null;
  }

  async function enrollHeldRange(
    ref: GenerationPublicationJob,
    client: PoolClient,
    context: PublicFilterConsumerContext,
    meter: Meter,
    limit: number,
    lane?: HeldLane,
  ) {
    // Read all three committed edges under the publication session lock. A torn
    // handoff returns to the existing single-page recovery from its original.
    meter.inputKeys += 10;
    meter.dependencyPoints += 10;
    const {
      rows: [job],
    } = await client.query<
      Job & {
        birth: string;
        original: string;
        next_home: number;
        next_ordinal: number;
        end_home: number | null;
        coverage_after: number;
      }
    >(
      `SELECT j.*,m.birth::text,m.bootstrap AS original,s.next_home,s.next_ordinal,p.end_home,b.coverage_after
       FROM search.generation_publication j JOIN core.subject_subscription_v1 m ON m.job=j.job
       JOIN semantic.subject_source_preparation_v1 s USING(birth)
       JOIN semantic.public_filter_bootstrap b ON (b.partition_no,b.bootstrap)=(0,m.bootstrap)
       JOIN search.public_filter_coverage_preparation c ON c.bootstrap=b.bootstrap AND c.ack_protocol=1
       LEFT JOIN semantic.subject_access_page_v1 p ON (p.birth,p.first_home)=(m.birth,s.next_home)
       WHERE (j.partition_no,j.job,j.consumer)=(0,$1,$2::jsonb) AND j.subscription_protocol=1 AND j.pass=1
         AND j.phase='subject' AND j.fence IS NULL AND NOT j.fenced_pass AND j.observation IS NULL
         AND j.bootstrap IS NULL AND j.pit IS NULL AND j.previous_uuid IS NULL
         AND b.state IN ('capturing','begun') AND b.subscription_protocol=1 AND c.subscription_protocol=1
         AND NOT c.ack_retired AND (b.coverage_after,b.coverage_root)=(c.after_home,c.root)
         AND b.coverage_after>0 AND ($3::boolean OR b.coverage_after=(SELECT end_home FROM semantic.subject_access_page_v1
           WHERE birth=m.birth ORDER BY first_home DESC LIMIT 1))
         AND (b.coverage_after<4096 OR s.next_home<4096)`,
      [ref.job, ref.consumer, lane === 'source'],
    );
    if (
      !job ||
      (lane === 'capture' && job.coverage_after === 4096) ||
      (lane === 'source' && (job.end_home === null || job.next_home >= job.coverage_after))
    )
      return;
    const member = { job: job.job, birth: job.birth, bootstrap: job.original };
    const offers: Meter[] = [];
    meter[enrollmentOffers] = offers;
    const reserve = (inputs: number, writes: number) => {
      if (offers.length + 1 >= limit) throw new RangeError('Held Subject offer exhausted');
      const offer = cost();
      offer.inputKeys = offer.dependencyPoints = inputs;
      offer.frontierWrites = writes;
      offer[validationBytes] = 2 * 65536;
      offers.push(offer);
      return offer;
    };
    let checked: Promise<void> | undefined;
    const checkTarget = () =>
      (checked ??= (async () => {
        const physical = await native(job.consumer, context, validationSearch(context, meter));
        if (physical.activeSubjectGeneration !== null) throw new Pending('observation_lost');
        await adopt(job, context, meter, physical);
      })());
    if (job.next_home === 0 && job.next_ordinal === 0) await checkTarget();
    const available = limit - 1;
    const captureCount =
      lane === 'source'
        ? 0
        : Math.min(Math.floor(available / (lane === 'capture' ? 2 : 4)), Math.ceil((4096 - job.coverage_after) / 32));
    const sourceCount = Math.min(8, Math.floor((available - 2 * captureCount) / 2));
    const captured = captureCount
      ? (async () => {
          for (let i = 0; i < captureCount; i++)
            reserve(176 + 18 * Math.min(32, 4096 - job.coverage_after - 32 * i), 2);
          await captureHeldSubjectRange(client, member, job.coverage_after, captureCount);
        })()
      : Promise.resolve();
    const receive = async () => {
      await captured;
      for (let i = 0; i < captureCount; i++) {
        reserve(192 + 24 * Math.min(32, 4096 - job.coverage_after - 32 * i), 3);
        // A transaction may accept the committed predecessor and append the next original.
        const result = await client.query<{ homes: number }>(
          i === 0
            ? 'SELECT search.advance_subject_receiver_v1($1,32) AS homes'
            : `WITH accepted AS MATERIALIZED (SELECT semantic.accept_subject_receiver_page_v1($1) AS homes)
           SELECT search.advance_subject_receiver_v1($1,32) AS homes FROM accepted WHERE homes>0`,
          [job.job],
        );
        if (!result.rows[0]?.homes) throw new Pending('source_pending');
      }
      if (captureCount) await client.query('SELECT semantic.accept_subject_receiver_page_v1($1)', [job.job]);
    };
    const settle = async (
      obligations: readonly { partition: number; position: string; ids: readonly string[] }[],
      offer: Meter,
    ) => {
      try {
        await checkTarget();
        for (const { partition, ids, position } of obligations)
          await reconcile(job, partition, ids, undefined, BigInt(position), context, offer, true);
        return true;
      } catch (error) {
        if (error instanceof Pending && error.reason === 'source_pending') return false;
        throw error;
      }
    };
    const scan = async () => {
      if (job.next_home >= job.coverage_after) await captured;
      if (job.next_ordinal === 0)
        return prepareHeldSubjectRange(
          pool,
          member,
          job.next_home,
          sourceCount,
          context,
          (homes) => reserve(176 + 18 * homes, 2),
          settle,
          (homes) => reserve(176 + 18 * homes, 3),
        );
      if (job.end_home === null) throw new Pending('source_pending');
      const offer = reserve(176 + 18 * (job.end_home - job.next_home), 2);
      try {
        await reconcileHeldSubjectPage(
          pool,
          { ...member, firstHome: job.next_home, endHome: job.end_home, ordinal: job.next_ordinal },
          context,
          async (obligation) => {
            if (!(await settle([obligation], offer))) throw new Pending('source_pending');
          },
        );
        return true;
      } catch (error) {
        if (error instanceof Pending && error.reason === 'source_pending') return false;
        throw error;
      }
    };
    const [receiver, source] = await Promise.allSettled([receive(), lane === 'capture' ? false : scan()]);
    if (receiver.status === 'rejected') throw receiver.reason;
    if (source.status === 'rejected') throw source.reason;
    if (!captureCount && !source.value) throw new Pending('source_pending');
    return job;
  }

  async function subjectEnrollmentPage(
    job: Job,
    definition: SearchPublicFilterSourceDefinition,
    frontier: SubjectEnrollmentFrontier,
    context: PublicFilterConsumerContext,
    meter: Meter,
    reserve: number,
    separateAdoption = false,
  ) {
    const advance = advanceNativePublicFilterPreparation;
    if (!planColdSubjectEnrollment || !advance) return null;
    const inputLimit = () => PUBLIC_FILTER_PREPARATION_INPUT_LIMIT - reserve - meter.inputKeys;
    const byteLimit = () => VALIDATION_BYTE_LIMIT - meter[validationBytes];
    const ranges = planColdSubjectEnrollment(
      definition.dependencyKeys,
      frontier.end,
      inputLimit(),
      byteLimit(),
      separateAdoption,
    );
    if (!ranges) return null;
    const end = ranges.at(-1)!.end;
    const submit = async (stage: ColdEnrollmentStage) => {
      const result = await advance(
        binding,
        {
          bootstrap: frontier.bootstrap,
          subjectEnrollment: {
            consumer: job.consumer,
            source: job.binding.source,
            registration: { partition: 0, id: frontier.registration },
            capturingOnly: true,
          },
          inputLimit: inputLimit(),
          coldEnrollment: { version: 1, job: job.job, byteLimit: byteLimit(), ...stage },
        },
        context,
      );
      if (result) add(meter, result.cost);
      if (result && 'reason' in result && result.reason === 'deadline') throw new Pending('deadline');
      return result;
    };
    let adoption: ColdEnrollmentStage = { action: 'prepare-and-adopt', ranges };
    if (separateAdoption) {
      const prepared = await submit({ action: 'prepare', ranges });
      if (prepared?.status !== 'ranges-prepared') return null;
      adoption = { action: 'adopt', ranges: prepared.ranges };
    }
    return {
      frontier: { ...frontier, end },
      async adopt() {
        if ((await submit(adoption))?.status !== 'range-adopted') return false;
        if (frontier.end < 40 || end === 4096) bookPreparationTiming?.mark('enrollmentRangeAdopted', end);
        return true;
      },
    };
  }

  async function checkpointEnrolledSubjects(
    job: Job,
    client: PoolClient,
    context: PublicFilterConsumerContext,
    meter: Meter,
    enrollment: SubjectEnrollmentFrontier,
  ) {
    meter.inputKeys += SUBJECT_ENROLLMENT_TARGET_INPUTS;
    if ((await native(job.consumer, context, validationSearch(context, meter))).activeSubjectGeneration !== null)
      throw new Pending('observation_lost');
    const retained = await subjectEnrollmentFrontier(job, client, meter);
    if (
      !retained ||
      retained.bootstrap !== enrollment.bootstrap ||
      retained.registration !== enrollment.registration ||
      retained.end < enrollment.end
    )
      throw new Pending('registration_missing');
    check(context);
    await save(client, job, meter);
  }

  async function advanceEnrolledSubjects(
    job: Job,
    client: PoolClient,
    context: PublicFilterConsumerContext,
    meter: Meter,
    frontier: SubjectEnrollmentFrontier,
  ) {
    let longest = 0;
    for (let turn = 0; turn < SUBJECT_ENROLLMENT_SCAN_TURNS && job.home < frontier.end; turn++) {
      const started = Date.now();
      if (started + 2 * longest >= context.deadline || earlySubjectPageLimit(meter) <= 0) break;
      const { home, after_id, revision } = job;
      try {
        await advance(job, client, context, meter, false, frontier);
      } catch (error) {
        if (!(error instanceof Pending) || error.reason !== 'source_pending') throw error;
        if (job.revision === revision && (job.home !== home || job.after_id !== after_id))
          await checkpointEnrolledSubjects(job, client, context, meter, frontier);
        return;
      }
      if (job.home > home && (home === 0 || Math.floor(job.home / 512) > Math.floor(home / 512)))
        bookPreparationTiming?.mark('enrolledSubjectReconciled', job.home);
      longest = Math.max(longest, Date.now() - started);
    }
  }

  function earlySubjectPageLimit(meter: Meter) {
    // Reserve the Source page, settled writer inputs and keyed engine hits,
    // plus the target and enrollment checks before checkpointing.
    const remaining = SUBJECT_ENROLLMENT_SCAN_INPUTS - meter.inputKeys - SUBJECT_ENROLLMENT_CHECKPOINT_INPUTS;
    return Math.min(PAGE, Math.floor(remaining / 5));
  }

  function jobPin(job: Job): GenerationPublicationPin | null {
    if (!job.bootstrap || !job.queried || !job.execution) return null;
    return {
      job: job.job,
      bootstrap: job.bootstrap,
      queried: decodeGenerationPublicationQueried(job.queried),
      execution: job.execution,
    };
  }
  function persistPin(job: Job, pin: GenerationPublicationPin) {
    if (pin.job !== job.job) throw new Pending('source_pending');
    job.bootstrap = pin.bootstrap;
    job.queried = encodeGenerationPublicationQueried(pin.queried);
    job.execution = pin.execution;
    job.observation = pin.queried.snapshot.observation;
  }

  const reference = (job: Job): GenerationPublicationJob => ({ consumer: structuredClone(job.consumer), job: job.job });
  const fence = (job: Job): SearchWriterPublicationFence => ({
    consumer: job.consumer,
    job: job.job,
    fence: job.fence!,
  });
  function hasPublicationGuard() {
    return (
      typeof writerGuard.fencePublication === 'function' &&
      typeof writerGuard.drainPublication === 'function' &&
      typeof writerGuard.adoptPublication === 'function' &&
      typeof writerGuard.releasePublication === 'function'
    );
  }
  function guardAvailable() {
    if (!hasPublicationGuard()) throw new Pending('source_pending');
  }
  async function held(job: Job, context: PublicFilterConsumerContext, meter: Meter) {
    guardAvailable();
    if (!job.fence) throw new Pending('source_pending');
    const result = await writerGuard.adoptPublication(fence(job), context);
    add(meter, result.cost);
    if (result.status !== 'held') throw new Pending(result.reason);
    if (!same(result.fence, fence(job))) throw new Pending('incarnation_changed');
    return nativeSourceForHeldPublication(result);
  }
  async function adoptHeld(job: Job, client: PoolClient, context: PublicFilterConsumerContext, meter: Meter) {
    let pin = await held(job, context, meter);
    await adopt(job, context, meter);
    if (!pin) {
      const completion = await readPublicationCompletion({ job: job.job }, context);
      add(meter, completion.cost);
      if (completion.status !== 'complete') throw new Pending('source_pending');
      pin = publicationPinFromNative(completion.publication);
    }
    if (pin.job !== job.job || !same(pin.queried.consumer, job.consumer)) throw new Pending('source_pending');
    const retained = jobPin(job);
    if (retained && !sameGenerationPublicationPin(retained, pin)) throw new Pending('source_pending');
    if (!retained) persistPin(job, pin);
    if (job.subject_fenced_cut) {
      const current = await sparseCut(job, client, context, meter);
      if (!current || current === 'dense') throw new Pending('source_pending');
      if (!current.digest.equals(job.subject_fenced_cut)) throw new ChangedSparseCut(current);
    }
    return pin.queried;
  }
  async function confirmHeldIntent(
    job: Job,
    client: PoolClient,
    context: PublicFilterConsumerContext,
    meter: Meter,
    currentAlias: string | null,
    proofCosts?: Meter[],
  ): Promise<boolean> {
    let opened: SparseSubjectCut;
    try {
      await adoptHeld(job, client, context, meter);
      return true;
    } catch (error) {
      // An exposed or replaced alias retains its rollback intent.
      if (!(error instanceof ChangedSparseCut) || currentAlias !== null) throw error;
      opened = error.cut;
    }
    if (proofCosts) {
      const physical = cost();
      proofCosts.push(physical);
      let cut: Buffer | null = null;
      try {
        cut = await reconcileSparseSubject(job, client, context, physical, opened);
      } catch (error) {
        if (
          !(error instanceof SearchUnavailableError || (error instanceof Pending && error.reason === 'source_pending'))
        )
          throw error;
      }
      if (cut) {
        // Reopen the original Source between matching physical cuts before switching.
        const confirmation = cost();
        proofCosts.push(confirmation);
        job.subject_fenced_cut = cut;
        try {
          await adoptHeld(job, client, context, confirmation);
        } catch (error) {
          if (!(error instanceof ChangedSparseCut)) throw error;
          cut = null;
        }
        if (cut) {
          await save(client, job, confirmation);
          return true;
        }
      }
    }
    // The absent alias needs no rollback. Continue with the paged physical proof
    // on this drained fence. A required ordinary write still cancels through restart.
    if ((await aliasTarget(job, context, meter)) !== null) throw new Pending('source_pending');
    job.subject_fenced_cut = null;
    job.home = 0;
    job.phase = 'subject';
    await save(client, job, meter);
    return false;
  }
  async function save(client: PoolClient, job: Job, meter: Meter) {
    // A stale publication or a released/replaced writer must never commit a sparse frontier.
    const gate =
      job.subject_fenced_cut && job.fence
        ? ` AND EXISTS (
         SELECT FROM search.identity_writer_gate g JOIN core.partition p ON p.partition_no=0
           AND p.write_state='active' AND p.epoch=g.owner_epoch
         WHERE (g.partition_no,g.physical_target,g.incarnation,g.publication_job,g.publication_fence,
                g.publication_consumer,g.publication_home) =
               (0,j.physical_target,j.native_incarnation,j.job,$9::text::uuid,j.consumer,4096)
           AND g.publication_after IS NULL FOR SHARE OF g,p)`
        : '';
    const result = await client.query(
      `UPDATE search.generation_publication AS j SET phase=$3,home=$4,after_route=$5,after_id=$6,engine_after=$7,
       pit=$8,fence=$9,fenced_pass=$10,observation=$11,previous_target=$12,previous_uuid=$13,pass=$14,activated_at=$15,
       bootstrap=$16,queried=$17,execution=$18,subject_fenced_cut=$19,revision=revision+1
       WHERE j.partition_no=0 AND j.job=$1 AND j.revision=$2${gate} RETURNING j.revision::text`,
      [
        job.job,
        job.revision,
        job.phase,
        job.home,
        job.after_route,
        job.after_id,
        job.engine_after,
        job.pit,
        job.fence,
        job.fenced_pass,
        job.observation,
        job.previous_target,
        job.previous_uuid,
        job.pass,
        job.activated_at,
        job.bootstrap,
        job.queried,
        job.execution,
        job.subject_fenced_cut,
      ],
    );
    if (!result.rows[0]) throw new Pending('observation_lost');
    job.revision = result.rows[0].revision;
    meter.frontierWrites++;
  }
  async function locked<T>(
    input: GenerationPublicationJob,
    context: PublicFilterConsumerContext,
    meter: Meter,
    phase: 'step' | 'step-enroll' | 'activate',
    work: (
      job: Job,
      client: PoolClient,
      current: string | null,
      capture?: ReturnType<typeof populationDefinition>,
      enrollment?: boolean | 'sealed',
      additionalEnrollmentCosts?: readonly SearchPublicFilterCost[],
    ) => Promise<T>,
    batchHeld = false,
    heldOffers = 16,
    heldLane?: HeldLane,
  ): Promise<T> {
    const ref = structuredClone(input);
    const target = locator(ref.consumer);
    requireValue(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(ref.job));
    // Separate Subject jobs can replace the same read alias. Serialize both their switch and rollback.
    const lockKey = target.family === 'subjects' ? subjectAlias(target.prefix) : ref.job;
    // This is a maintenance session lock, not a command transaction. Native owners acquire their own
    // bounded snapshot connections; do not wrap them in withConnection's single-command checkout scope.
    // The two enrollment owners may run together. Each has one writer per alias,
    // and every ordinary publication operation still requires exclusive custody.
    const aliasMode = heldLane ? '_shared' : '';
    const laneKey = heldLane ? JSON.stringify([lockKey, heldLane]) : undefined;
    let connection: PoolClient | undefined;
    let released = false;
    let broken: Error | undefined;
    let mayOwnLock = false;
    const dispose = () => {
      if (!connection || released) return;
      released = true;
      connection.release(
        broken ?? (mayOwnLock ? new Error('Generation publication session lock ownership is uncertain') : undefined),
      );
    };
    try {
      return await withBoundedReadLifetime(
        async (read) => {
          const raw = await pool.connect();
          connection = raw;
          try {
            return await read(raw);
          } finally {
            // A checkout arriving after expiry is retired before it can dispatch SQL.
            dispose();
          }
        },
        (_client, error) => {
          broken ??= error;
        },
        context.deadline,
        (client) =>
          // Keep owner snapshots on this deadline until the callback itself settles, even if the
          // lifetime has already retired its session and returned the turn's deadline failure.
          withRequestDeadline(context.deadline, async () => {
            mayOwnLock = true;
            const lock = await client.query<{ locked: boolean }>(
              `SELECT pg_try_advisory_lock${aliasMode}(hashtextextended($1,2)) AS locked`,
              [lockKey],
            );
            mayOwnLock = lock.rows[0]?.locked !== false;
            if (lock.rows[0]?.locked !== true) throw new Pending('source_pending');
            let laneLocked = false;
            try {
              if (laneKey) {
                // A lost query reply can leave this session owning the lane.
                laneLocked = true;
                const lane = await client.query<{ locked: boolean }>(
                  'SELECT pg_try_advisory_lock(hashtextextended($1,2)) AS locked',
                  [laneKey],
                );
                laneLocked = lane.rows[0]?.locked !== false;
                if (lane.rows[0]?.locked !== true) throw new Pending('source_pending');
              }
              if (batchHeld && phase === 'step-enroll' && heldOffers >= 5) {
                const enrolled = await enrollHeldRange(ref, client, context, meter, heldOffers, heldLane);
                if (enrolled) return work(enrolled, client, null, undefined, true, meter[enrollmentOffers]);
              }
              // Only the exclusive owner may recover a torn receipt or change phase.
              if (heldLane) throw new Pending('source_pending');
              const {
                rows: [job],
              } = await client.query<
                Job & {
                  held_birth: string | null;
                  held_bootstrap: string | null;
                  coverage_after: number | null;
                  next_home: number | null;
                  next_ordinal: number | null;
                  end_home: number | null;
                }
              >(
                `SELECT * FROM search.generation_publication j
                 LEFT JOIN LATERAL (
                   SELECT m.birth::text AS held_birth,m.bootstrap AS held_bootstrap,
                     s.next_home,s.next_ordinal,p.end_home,b.coverage_after
                   FROM core.subject_subscription_v1 m
                   JOIN semantic.public_filter_bootstrap b ON (b.partition_no,b.bootstrap)=(0,m.bootstrap)
                   JOIN semantic.subject_source_preparation_v1 s ON (s.birth,s.bootstrap)=(m.birth,m.bootstrap)
                   LEFT JOIN semantic.subject_access_page_v1 p ON (p.birth,p.first_home)=(s.birth,s.next_home)
                   WHERE m.job=j.job LIMIT 1
                 ) held ON true
                 WHERE (j.partition_no,j.job)=(0,$1)`,
                [ref.job],
              );
              if (!job || !same(job.consumer, ref.consumer)) throw new Pending('registration_missing');
              const receiveCut = async (homes: number, receiver: Meter) => {
                // Search's committed comparison and Source's acceptance trigger
                // each reopen the original interval. Reserve both before dispatch.
                receiver.inputKeys += 192 + homes * 24;
                receiver.dependencyPoints += 192 + homes * 24;
                const page = await client.query<{ homes: number }>(
                  'SELECT search.advance_subject_receiver_v1($1,$2) AS homes',
                  [job.job, homes],
                );
                const covered = page.rows[0]!.homes;
                receiver.inputKeys -= (homes - covered) * 24;
                receiver.dependencyPoints -= (homes - covered) * 24;
                if (covered) receiver.frontierWrites += 3;
                return covered;
              };
              if (job.subscription_protocol === 1 && job.pass === '1' && job.phase === 'subject') {
                if (!job.held_birth || job.coverage_after === null || job.next_home === null)
                  throw new Pending('source_pending');
                const pin = await client.query<{ ready: boolean }>(
                  'SELECT search.begin_subject_receiver_v1($1,$2) AS ready',
                  [job.job, encodePublicFilterNativeState(job.consumer)],
                );
                meter.inputKeys += 16;
                meter.dependencyPoints += 16;
                if (!pin.rows[0]?.ready) throw new Pending('source_pending');
                // Recover the same retained page if either owner's previous
                // reply was lost. A fresh page starts with Source capture below.
                if (
                  job.coverage_after < job.next_home ||
                  (job.coverage_after === job.next_home && job.end_home !== null)
                ) {
                  const homes = Math.min(32, Math.floor((1000 - meter.inputKeys - 192) / 24));
                  if (await receiveCut(homes, meter)) {
                    await client.query('SELECT semantic.accept_subject_receiver_page_v1($1)', [job.job]);
                    return work(job, client, null, undefined, true);
                  }
                }
              }
              if (job.held_birth != null && (job.subscription_protocol !== 1 || job.next_home !== 4096)) {
                if (
                  phase === 'activate' ||
                  job.family !== 'subjects' ||
                  job.phase !== 'subject' ||
                  job.pass !== '1' ||
                  job.fence ||
                  job.observation ||
                  job.bootstrap ||
                  job.pit ||
                  !job.held_bootstrap ||
                  job.next_home === null ||
                  job.next_home === 4096 ||
                  job.next_ordinal === null
                )
                  throw new Pending('source_pending');
                // Source reopens the job and the original Core/Access page on every ordinal.
                // After admission, reopen physical custody on the first writer obligation of each turn.
                let checkedWriterTarget = false;
                const checkWriterTarget = async () => {
                  if (checkedWriterTarget) return;
                  const physical = await native(job.consumer, context, validationSearch(context, meter));
                  if (physical.activeSubjectGeneration !== null) throw new Pending('observation_lost');
                  await adopt(job, context, meter, physical);
                  checkedWriterTarget = true;
                };
                if (job.subscription_protocol !== 1 || (job.next_home === 0 && job.next_ordinal === 0))
                  await checkWriterTarget();
                // Reserve the capture, original owner checks, 32 inventory keys or
                // event slots and the closing custody comparison before dispatch.
                const fixedInputs = 176;
                const perHomeInputs = 18;
                const available = PUBLIC_FILTER_PREPARATION_INPUT_LIMIT - meter.inputKeys - 5 * 32;
                const width = Math.min(32, Math.floor((available - fixedInputs) / perHomeInputs));
                // A retained short cut can end inside an authority interval.
                // Close that suffix before capturing further full intervals.
                const remaining = batchHeld && job.subscription_protocol === 1 ? 32 - (job.next_home % 32) : 32;
                const endHome = job.end_home ?? Math.min(4096, job.next_home + Math.min(width, remaining));
                const inputs = fixedInputs + perHomeInputs * (endHome - job.next_home);
                if (endHome <= job.next_home || inputs > available) throw new Pending('source_pending');
                meter.inputKeys += inputs;
                meter.dependencyPoints += inputs;
                const frontier = {
                  job: job.job,
                  bootstrap: job.held_bootstrap,
                  birth: job.held_birth,
                  firstHome: job.next_home,
                  endHome,
                  ordinal: job.next_ordinal,
                };
                const additional: Meter[] = [];
                await reconcileHeldSubjectPage(
                  pool,
                  frontier,
                  context,
                  async (obligation) => {
                    await checkWriterTarget();
                    await reconcile(
                      job,
                      obligation.partition,
                      obligation.ids,
                      undefined,
                      BigInt(obligation.position),
                      context,
                      meter,
                      true,
                    );
                  },
                  batchHeld && job.subscription_protocol === 1 && job.coverage_after === job.next_home
                    ? () => {
                        const receiver = cost();
                        additional.push(receiver);
                        return receiveCut(endHome - frontier.firstHome, receiver);
                      }
                    : undefined,
                );
                meter.frontierWrites++;
                return work(job, client, null, undefined, true, additional);
              }
              if (
                job.subscription_protocol === 1 &&
                job.next_home === 4096 &&
                job.phase === 'subject' &&
                job.pass === '1' &&
                job.home === 0 &&
                !job.fence &&
                !job.pit &&
                !job.after_id &&
                !job.previous_uuid
              ) {
                const sealed = await client.query(
                  "SELECT 1 FROM semantic.public_filter_bootstrap WHERE (partition_no,bootstrap)=(0,$1) AND coverage_sealed AND state='begun'",
                  [job.held_bootstrap],
                );
                if (!sealed.rowCount) throw new Pending('source_pending');
                // The producer reconciled the complete original inventory through finite creation ends.
                // The engine pass and the subsequent held pass still compare the ordinary physical target.
                job.phase = 'engine';
                await save(client, job, meter);
              }
              const earlyEnrollment =
                phase === 'step-enroll' && canEnrollSubject(job) && !job.bootstrap && !job.queried && !job.execution;
              const physical =
                (phase === 'activate' || earlyEnrollment) && target.family === 'subjects' && job.phase !== 'active'
                  ? await native(job.consumer, context)
                  : undefined;
              // The native inventory already proves absence during cold preparation. An existing
              // alias still needs exact options and target readback, as does every switch or rollback.
              const current =
                phase === 'activate' && (job.phase === 'active' || (physical?.activeSubjectGeneration ?? null) !== null)
                  ? await aliasTarget(job, context, meter)
                  : null;
              if (job.phase !== 'active' && newerSubjectAlias(job, current)) throw new Pending('source_pending');
              if (
                physical?.incarnation === job.native_incarnation &&
                job.phase === 'reconciled' &&
                current === null &&
                !job.fence &&
                !job.fenced_pass &&
                !job.observation &&
                !job.bootstrap
              ) {
                const enrollmentAdvanced = await continueSubjectEnrollment(job, client, context, meter);
                if (enrollmentAdvanced !== null) return work(job, client, current, undefined, enrollmentAdvanced);
              }
              let adopted: Awaited<ReturnType<typeof adopt>> | undefined;
              if (job.phase === 'active') {
                // Settled publication may still need idempotent fence release after a lost response.
                // A later Source change must not strand the ordinary repair writer behind that old fence.
                await native(job.consumer, context);
              } else {
                try {
                  adopted = await adopt(job, context, meter, physical);
                } catch (error) {
                  if (
                    error instanceof Pending &&
                    (job.fence || job.phase === 'fencing') &&
                    ['source_pending', 'routing_incomplete', 'registration_missing'].includes(error.reason)
                  ) {
                    // Definition/observation changes can be discovered before entering the publication body.
                    // Recover an outstanding alias intent under the same native fence before returning unready.
                    await native(job.consumer, context);
                    if (!job.fence) await installFence(job, client, context, meter);
                    await restart(job, client, context, meter);
                  }
                  throw error;
                }
              }
              // A committed enrollment prefix admits a first-pass Subject slice alongside
              // future Source pages. The publication session remains the only cursor writer.
              if (earlyEnrollment && physical?.activeSubjectGeneration === null && adopted) {
                const { capture, definition } = adopted;
                const canPrepareRanges =
                  nativeMeaning &&
                  hasPublicationGuard() &&
                  job.source_home === 0 &&
                  job.pass === '1' &&
                  !job.pit &&
                  job.previous_uuid === null;
                let frontier = canPrepareRanges ? await subjectEnrollmentFrontier(job, client, meter) : null;
                const enrollPage = async (connection: PoolClient | null, pageMeter: Meter, reservedInputs = 0) => {
                  if (frontier) {
                    const reserve = Math.max(
                      reservedInputs,
                      job.phase === 'validate' ? SUBJECT_VALIDATION_HOMES : PUBLIC_FILTER_PREPARATION_INPUT_RESERVE,
                    );
                    const page = await subjectEnrollmentPage(job, definition, frontier, context, pageMeter, reserve);
                    frontier = page && (await page.adopt()) ? page.frontier : null;
                    if (frontier) return true;
                  }
                  return continueSubjectEnrollment(job, connection, context, pageMeter, true, reservedInputs);
                };
                const enrollment = await enrollPage(client, meter);
                if (enrollment === 'sealed') return work(job, client, current, capture, enrollment);
                if (enrollment === false) throw new Pending('source_pending');
                if (enrollment !== true) return work(job, client, current, capture);
                const preparedFirstPage = frontier !== null;
                const subjectMeter = cost();
                if (canPrepareRanges && !frontier)
                  frontier = await subjectEnrollmentFrontier(job, client, subjectMeter);
                const scan = job.phase === 'subject' && frontier && job.home < frontier.end ? frontier : null;
                const additionalEnrollmentCosts: Meter[] = [];
                const enroll = async () => {
                  let duration = 0;
                  if (preparedFirstPage && frontier) {
                    const prepare = (start: SubjectEnrollmentFrontier, page: number) => {
                      const pageMeter = cost();
                      additionalEnrollmentCosts.push(pageMeter);
                      const reserve = Math.max(
                        page === 1 && scan ? SUBJECT_ENROLLMENT_SCAN_INPUTS : 0,
                        job.phase === 'validate' ? SUBJECT_VALIDATION_HOMES : PUBLIC_FILTER_PREPARATION_INPUT_RESERVE,
                      );
                      return subjectEnrollmentPage(job, definition, start, context, pageMeter, reserve, true);
                    };
                    // A staged page exposes original receipts. Only its ordered adoption advances the prefix.
                    const firstStart = Date.now();
                    let staged: Awaited<ReturnType<typeof prepare>> = await prepare(frontier, 1);
                    duration = Date.now() - firstStart;
                    for (let page = 1; staged; page++) {
                      const started = Date.now();
                      const more =
                        page + 1 < SUBJECT_ENROLLMENT_PAGES &&
                        staged.frontier.end < 4096 &&
                        started + 2 * duration < context.deadline;
                      const [committed, next] = await Promise.allSettled([
                        staged.adopt(),
                        more ? prepare(staged.frontier, page + 1) : null,
                      ]);
                      if (committed.status === 'rejected') throw committed.reason;
                      if (next.status === 'rejected') throw next.reason;
                      if (!committed.value) return;
                      staged = next.value;
                      duration = Math.max(duration, Date.now() - started);
                    }
                    return;
                  }
                  for (let page = 1; page < SUBJECT_ENROLLMENT_PAGES; page++) {
                    const started = Date.now();
                    if (started + 2 * duration >= context.deadline) break;
                    const pageMeter = cost();
                    additionalEnrollmentCosts.push(pageMeter);
                    const advanced = await enrollPage(
                      scan ? null : client,
                      pageMeter,
                      page === 1 && scan ? SUBJECT_ENROLLMENT_SCAN_INPUTS : 0,
                    );
                    if (advanced !== true) break;
                    duration = Math.max(duration, Date.now() - started);
                  }
                };
                const results = await Promise.allSettled([
                  enroll(),
                  scan ? advanceEnrolledSubjects(job, client, context, subjectMeter, scan) : undefined,
                ]);
                add(additionalEnrollmentCosts[0] ?? meter, subjectMeter);
                // The initial enrollment page committed even if either lane stopped.
                for (const result of results)
                  if (result.status === 'rejected' && !(result.reason instanceof Pending)) throw result.reason;
                return work(job, client, current, capture, true, additionalEnrollmentCosts);
              }
              const sealed =
                batchHeld &&
                job.subscription_protocol === 1 &&
                job.pass === '1' &&
                job.phase === 'validate' &&
                job.next_home === 4096 &&
                job.coverage_after === 4096;
              return await work(job, client, current, adopted?.capture, sealed ? 'sealed' : undefined);
            } finally {
              if (laneLocked) {
                const released = await client.query<{ unlocked: boolean }>(
                  'SELECT pg_advisory_unlock(hashtextextended($1,2)) AS unlocked',
                  [laneKey],
                );
                if (!released.rows[0]?.unlocked) throw new Error('Held enrollment lane lock was not released');
              }
              const unlocked = await client.query<{ unlocked: boolean }>(
                `SELECT pg_advisory_unlock${aliasMode}(hashtextextended($1,2)) AS unlocked`,
                [lockKey],
              );
              if (unlocked.rows[0]?.unlocked !== true)
                throw new Error('Generation publication session lock was not released');
              mayOwnLock = false;
            }
          }),
        publicationLifetime,
      );
    } finally {
      // Expiry can win while an owner is using its own snapshot. Drop our lock before returning;
      // the retired callback cannot reuse this session or release it a second time.
      dispose();
    }
  }
  async function head(partition: number, context: PublicFilterConsumerContext): Promise<Home> {
    const {
      rows: [row],
    } = await withBoundedReadConnection(
      pool,
      context.deadline,
      (client) =>
        client.query<{ epoch: number; position: string }>(
          'SELECT epoch,position::text FROM core.partition WHERE partition_no=$1',
          [partition],
        ),
      publicationLifetime,
    );
    if (!row) throw new Pending('routing_incomplete');
    const witness = registry ? (await readAccountDiscoveryWitness(pool, [partition])).get(partition) : undefined;
    if (registry && !witness) throw new Pending('source_pending');
    return {
      partition,
      ...row,
      account_revision: (witness?.revision ?? 0n).toString(),
      claim_revision: (witness?.claimRevision ?? 0n).toString(),
    };
  }
  /** Certify the empty interval following a complete Subject page in the same snapshot as its next occupied home. */
  async function nextSubjectHome(
    job: Job,
    client: PoolClient,
    context: PublicFilterConsumerContext,
    meter: Meter,
    end = 4096,
  ) {
    check(context);
    const result = await client.query<{ next_home: number; witnessed: number }>(
      `WITH frontier AS (
         SELECT coalesce((
           SELECT partition_no FROM semantic.partition_subjects
           WHERE visible>0 AND partition_no>$3 AND partition_no<$5 ORDER BY partition_no LIMIT 1
         ),$5) AS next_home
       ), homes AS (
         SELECT p.partition_no,p.epoch,p.position
         FROM frontier f JOIN core.partition p ON p.partition_no>$3 AND p.partition_no<f.next_home
         WHERE p.write_state='active'
       ), witnessed AS (
         INSERT INTO search.generation_publication_home AS prior
           (partition_no,job,epoch,position,account_revision,claim_revision,pass)
         SELECT h.partition_no,$1,h.epoch,h.position,0,0,$2
         FROM homes h,frontier f WHERE (SELECT count(*) FROM homes)=f.next_home-$3-1
         ON CONFLICT(partition_no,job) DO UPDATE SET epoch=EXCLUDED.epoch,position=EXCLUDED.position,
           account_revision=EXCLUDED.account_revision,claim_revision=EXCLUDED.claim_revision,pass=EXCLUDED.pass
         WHERE NOT $4::boolean OR prior.pass<EXCLUDED.pass OR
           (prior.pass=EXCLUDED.pass AND prior.epoch=EXCLUDED.epoch AND prior.position<=EXCLUDED.position)
         RETURNING partition_no
       )
       SELECT next_home,(SELECT count(*)::integer FROM witnessed) AS witnessed FROM frontier`,
      [job.job, job.pass, job.home, job.fenced_pass, end],
    );
    const { next_home, witnessed } = result.rows[0]!;
    meter.frontierWrites += witnessed;
    if (witnessed !== next_home - job.home - 1) throw new Pending('source_pending');
    return next_home;
  }
  async function rewindSubjectHome(job: Job, home: number, client: PoolClient, meter: Meter) {
    if (job.phase === 'validate') {
      // Keep the witness until replay starts so a lost checkpoint can retry validation.
      // Older workers ignore previous_uuid during reconciliation and replace it before alias intent.
      // Leaving both PIT and cursor null lets those workers continue their full scan.
      job.previous_uuid = SUBJECT_VALIDATION_REPLAY;
    } else {
      const removed = await client.query(
        'DELETE FROM search.generation_publication_home WHERE partition_no=$1 AND job=$2',
        [home, job.job],
      );
      meter.frontierWrites += removed.rowCount ?? 0;
    }
    job.phase = 'subject';
    job.home = home;
    job.after_route = null;
    job.after_id = null;
    await save(client, job, meter);
  }

  function advancedUnderSubjectFence(job: Job, before: Home, epoch: number | null, position: bigint) {
    return job.family === 'subjects' && job.fenced_pass && before.epoch === epoch && BigInt(before.position) < position;
  }

  async function remember(
    job: Job,
    before: Home,
    client: PoolClient,
    meter: Meter,
    verifyChanged?: () => Promise<Home | undefined>,
  ) {
    const {
      rows: [old],
    } = await client.query<Home>(
      `SELECT partition_no AS partition,epoch,position::text,account_revision::text,claim_revision::text
      FROM search.generation_publication_home WHERE partition_no=$1 AND job=$2 AND pass=$3 ${
        job.subscription_protocol === 1 && job.pass === '1'
          ? `UNION ALL
        SELECT home,epoch,command_base::text,'0','0' FROM search.subject_original_physical_homes_v1($2,$1,$1+1)
        WHERE NOT EXISTS (SELECT FROM search.generation_publication_home WHERE partition_no=$1 AND job=$2 AND pass=$3)`
          : ''
      }`,
      [before.partition, job.job, job.pass],
    );
    const changed = old && !same(old, before);
    // With no cursor, the Subject scan is already about to replay this home from its first key.
    const sameOwnerAdvance = old && advancedUnderSubjectFence(job, old, before.epoch, BigInt(before.position));
    const startsSubjectHome =
      job.family === 'subjects' && job.phase === 'subject' && !job.after_id && (!job.fenced_pass || sameOwnerAdvance);
    const verified =
      changed && verifyChanged && old.epoch === before.epoch && BigInt(old.position) < BigInt(before.position)
        ? await verifyChanged()
        : undefined;
    const missingCursorWitness =
      !old && job.family === 'subjects' && job.phase === 'subject' && !job.fenced_pass && job.after_id !== null;
    if (missingCursorWitness || (changed && !startsSubjectHome && !verified)) {
      if (sameOwnerAdvance) {
        await rewindSubjectHome(job, before.partition, client, meter);
        return 'rewound';
      }
      const deleted = await client.query(
        'DELETE FROM search.generation_publication_home WHERE partition_no=$1 AND job=$2',
        [before.partition, job.job],
      );
      meter.frontierWrites += deleted.rowCount ?? 0;
      job.phase = 'subject';
      job.home = before.partition;
      job.after_route = null;
      job.after_id = null;
      throw new Pending('source_pending');
    }
    if (!old || changed) {
      const witness = verified ?? before;
      const stored = await client.query(
        `INSERT INTO search.generation_publication_home
      (partition_no,job,epoch,position,account_revision,claim_revision,pass) VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT(partition_no,job) DO UPDATE SET epoch=EXCLUDED.epoch,position=EXCLUDED.position,
        account_revision=EXCLUDED.account_revision,claim_revision=EXCLUDED.claim_revision,pass=EXCLUDED.pass`,
        [
          witness.partition,
          job.job,
          witness.epoch,
          witness.position,
          witness.account_revision,
          witness.claim_revision,
          job.pass,
        ],
      );
      meter.frontierWrites += stored.rowCount ?? 0;
    }
    return verified ? 'verified' : 'retained';
  }
  function cursor(job: Job): SearchPublicFilterSourceKeyCursor | null {
    return job.after_id === null ? null : { route: job.after_route!, id: job.after_id };
  }
  async function keysFor(partition: number, ids: readonly string[]): Promise<DiscoveryKey[] | undefined> {
    if (!registry) return undefined;
    const entry = registry.entries.find((entry) => entry.owner === 'semantic');
    if (!entry || entry.owner !== 'semantic') throw new Pending('registration_missing');
    const snapshot = await entry.source.read(partition, ids);
    validateObservation(snapshot, partition, ids, 0n, true);
    const byId = new Map(snapshot.subjects.map((row) => [row.id, row.type]));
    // Native enumeration includes deleted/redirected rows. Their old copies are removed in the engine pass.
    return ids.flatMap((id) => {
      const kind = byId.get(id);
      return kind === undefined ? [] : [registry.key({ owner: 'semantic', kind, id, route: routeOf(id)! })];
    });
  }
  async function verifySubjectKeys(
    job: Job,
    partition: number,
    ids: readonly string[],
    position: bigint,
    meter: Meter,
    workContext?: PublicFilterConsumerContext,
    scope: 'keys' | 'original' | 'home' = 'keys',
  ): Promise<'matched' | 'writer-pending' | 'engine-mismatch'> {
    meter.inputKeys += ids.length * 3; // Publication inputs, current Source inputs and settled native copies.
    const wholeHome = scope === 'home';
    const started = Date.now();
    const retryHomeAdvance = () => {
      // Keep the remaining 32-key original and its physical comparisons funded.
      // Only the raced home repeats its Source, listing and custody reads.
      const inputs = 3 * ids.length;
      if (
        meter.inputKeys + inputs + 4 * 32 > PUBLIC_FILTER_PREPARATION_INPUT_LIMIT ||
        !workContext ||
        Date.now() + (Date.now() - started) >= workContext.deadline
      )
        return false;
      meter.inputKeys += inputs;
      return true;
    };
    const work = workContext && (() => validationWork(workContext, meter));
    const actions =
      wholeHome && !ids.length
        ? []
        : await readSearchWriterGenerationActions(
            writerGuard,
            partition,
            ids,
            position,
            work,
            scope === 'original' ? retryHomeAdvance : undefined,
          );
    if (!actions) {
      return 'writer-pending';
    }
    if (wholeHome && actions.some(({ op }) => op !== 'index')) return 'engine-mismatch';
    if (workContext) meter.inputKeys += actions.length + Number(wholeHome);
    meter.engineSearches++;
    try {
      const hits = await assertNativeGenerationActionsVisible(
        workContext ? validationSearch(workContext, meter) : search,
        job.physical_target,
        actions,
        wholeHome ? partition : undefined,
      );
      if (!workContext) meter.inputKeys += hits;
      return 'matched';
    } catch (error) {
      if (!(error instanceof GenerationReconciliationMismatch)) throw error;
      return 'engine-mismatch';
    }
  }
  async function verifyChangedEngineHome(
    job: Job,
    before: Home,
    ids: readonly string[],
    context: PublicFilterConsumerContext,
    meter: Meter,
  ): Promise<Home | undefined> {
    // A complete Source page can fit in this turn only if there is room for a lookahead
    // key, the exact writer comparison and the remaining turn's ordinary engine keys.
    const inputLimit = ids.length + 1;
    if (inputLimit > PAGE || meter.inputKeys + inputLimit + 4 * PAGE > 1000) return;
    const page = await sourceKeys.read({ partition: before.partition, after: null, inputLimit }, context);
    add(meter, page.cost);
    const originalPass = job.subscription_protocol === 1 && job.pass === '1' && !job.fenced_pass;
    if (
      page.status !== 'eligible' ||
      !page.complete ||
      page.partition !== before.partition ||
      page.epoch !== before.epoch ||
      (originalPass ? page.position < BigInt(before.position) : page.position !== BigInt(before.position)) ||
      !same([...page.ids].sort(), [...ids].sort())
    ) {
      return;
    }
    check(context);
    const verified = await verifySubjectKeys(job, before.partition, ids, page.position, meter);
    if (verified !== 'matched') return;
    const witness = { ...before, position: page.position.toString() };
    const after = await head(before.partition, context);
    // Validation reopens every original home. Preserve exactly the verified Source
    // position so any concurrent command still owes that later comparison.
    if (originalPass && after.epoch === witness.epoch && BigInt(after.position) >= page.position) return witness;
    return same(witness, after) ? witness : undefined;
  }
  async function reconcile(
    job: Job,
    partition: number,
    ids: readonly string[],
    keys: readonly DiscoveryKey[] | undefined,
    position: bigint,
    context: PublicFilterConsumerContext,
    meter: Meter,
    checkingEnrollment = false,
  ) {
    if (!ids.length) return;
    check(context);
    if (job.family === 'subjects') {
      const verified = await verifySubjectKeys(
        job,
        partition,
        ids,
        position,
        meter,
        checkingEnrollment ? context : undefined,
        checkingEnrollment ? 'original' : 'keys',
      );
      if (verified === 'matched') return;
      if (checkingEnrollment || job.fenced_pass) throw new Pending('source_pending');
      // Enrollment advances the native head. Replay the home before adopting a frontier or witness.
      try {
        if (job.phase === 'subject' && verified === 'writer-pending') {
          // Recover only a retained ordinary dispatch. The next page read must verify the changed home.
          if (await writerGuard.recoverRelayDispatch?.(partition, ids, context)) meter.resultWrites++;
          throw new Pending('source_pending');
        }
        await writerGuard.write(partition, ids, position);
      } catch (error) {
        if (error instanceof IdentityEpochStoreError && error.code === 'identity_epoch_unavailable')
          throw new Pending('source_pending');
        throw error;
      }
      meter.resultWrites += ids.length;
      throw new Pending('source_pending');
    }
    meter.inputKeys += ids.length;
    if (!job.fenced_pass) {
      const projection = createDiscoveryProjection({
        pool,
        search,
        registry: registry!,
        listing: subjectListingSource(pool),
        target: {
          prefix: job.prefix,
          generation: Number(job.generation),
          uuid: job.consumer.incarnation,
          incarnation: job.native_incarnation,
        },
      });
      await projection.project(partition, keys!, position, true);
      meter.resultWrites += ids.length;
    }
    await native(job.consumer, context);
    const actions = await nativeGenerationActions({
      pool,
      search,
      index: job.physical_target,
      partition,
      ids,
      keys: keys!,
      registry: registry!,
      obligation: position,
    });
    meter.inputKeys += ids.length;
    meter.engineSearches++;
    try {
      meter.inputKeys += await assertNativeGenerationActionsVisible(search, job.physical_target, actions);
    } catch (error) {
      if (error instanceof GenerationReconciliationMismatch) throw new Pending('source_pending');
      throw error;
    }
  }
  async function discardPit(job: Job, context: PublicFilterConsumerContext, meter: Meter) {
    if (!job.pit) return;
    try {
      await engine(context, meter, 'DELETE', '/_search/point_in_time', { pit_id: [job.pit] });
    } catch (error) {
      if (!(error instanceof OpenSearchError && error.status === 404)) throw error;
    }
    job.pit = null;
    job.engine_after = null;
  }
  function validationWork(context: PublicFilterConsumerContext, meter: Meter) {
    return {
      bytes: VALIDATION_BYTE_LIMIT - meter[validationBytes] - SUBJECT_VALIDATION_CHECKPOINT_BYTES,
      deadline: context.deadline,
      settle: (bytes: number) => (meter[validationBytes] += bytes),
    };
  }
  function validationSearch(context: PublicFilterConsumerContext, meter: Meter): OpenSearch {
    return {
      ...search,
      request: (method, path, body, options) =>
        search.request(method, path, body, {
          ...options,
          work: validationWork(context, meter),
        }),
    };
  }

  async function refreshChangedSubjectHome(
    job: Job,
    before: Home,
    currentPosition: string,
    client: PoolClient,
    context: PublicFilterConsumerContext,
    meter: Meter,
  ) {
    // Generic commands share this position. A complete current Source and physical
    // home proof can retain the completed PIT traversal when its writer did not move.
    const inventory = await client.query<{ retained: number; stable: boolean }>(
      `SELECT count(*)::integer AS retained,
              bool_and(coalesce(owner_epoch=$3 AND incarnation=$4 AND dispatch_state='settled'
                AND writer_token IS NULL AND closed_job IS NULL
                AND writer_position<=$5 AND source_position<=$5
                AND visible_position<=$5 AND visible_position=settled_position,false)) IS TRUE AS stable
       FROM (SELECT owner_epoch,incarnation,dispatch_state,writer_token,closed_job,
                    writer_position,source_position,visible_position,settled_position
             FROM search.identity_writer
             WHERE partition_no=$1 AND physical_target=$2 ORDER BY original_id LIMIT $6) AS writers`,
      [before.partition, job.physical_target, before.epoch, job.native_incarnation, before.position, PAGE],
    );
    const { retained, stable } = inventory.rows[0]!;
    meter.inputKeys += retained;
    if (!stable || retained >= PAGE) return false;
    const page = await sourceKeys.read({ partition: before.partition, after: null, inputLimit: PAGE }, context);
    add(meter, page.cost);
    if (
      page.status !== 'eligible' ||
      !page.complete ||
      page.partition !== before.partition ||
      page.epoch !== before.epoch ||
      page.position !== BigInt(currentPosition)
    ) {
      return false;
    }
    try {
      const result = await verifySubjectKeys(job, before.partition, page.ids, page.position, meter, context, 'home');
      if (result !== 'matched') return false;
    } catch (error) {
      if (error instanceof SearchUnavailableError) return false;
      throw error;
    }
    check(context);
    const refreshed = await client.query(
      `UPDATE search.generation_publication_home h SET position=$6
       FROM core.partition p
       WHERE h.partition_no=$1 AND h.job=$2 AND h.pass=$3 AND h.epoch=$4 AND h.position=$5
         AND p.partition_no=h.partition_no AND p.write_state='active' AND p.epoch=h.epoch AND p.position=$6`,
      [before.partition, job.job, job.pass, before.epoch, before.position, currentPosition],
    );
    meter.frontierWrites += refreshed.rowCount ?? 0;
    return refreshed.rowCount === 1;
  }

  async function compareHomes(
    job: Job,
    client: PoolClient,
    context: PublicFilterConsumerContext,
    meter: Meter,
    validationHomes: number,
    beforeRewind?: () => Promise<unknown>,
  ) {
    const end = Math.min(4096, job.home + validationHomes);
    // An empty Subject home without writer custody can be witnessed at its current position.
    // The completed engine pass accounted for existing keys. Occupied homes and homes that
    // may own an engine copy still replay on any change.
    const originalHomes = job.subscription_protocol === 1 && job.pass === '1';
    const query = `WITH homes AS (
         SELECT h.partition_no AS partition,h.epoch,h.position,h.account_revision,h.claim_revision,
                p.epoch AS current_epoch,p.position AS current_position,p.write_state
           FROM ${
             originalHomes
               ? `(
             SELECT partition_no,job,pass,epoch,position,account_revision,claim_revision
               FROM search.generation_publication_home WHERE partition_no >= $1 AND partition_no < $2 AND job=$3 AND pass=$4
             UNION ALL SELECT home,$3,$4,epoch,command_base,0,0 FROM search.subject_original_physical_homes_v1($3,$1,$2) original
               WHERE NOT EXISTS (SELECT FROM search.generation_publication_home changed
                 WHERE (changed.partition_no,changed.job,changed.pass)=(original.home,$3,$4))
           )`
               : 'search.generation_publication_home'
           } h
           LEFT JOIN core.partition p ON p.partition_no=h.partition_no
          WHERE h.partition_no >= $1 AND h.partition_no < $2 AND h.job=$3 AND h.pass=$4
       ),
       refreshed AS (
         ${
           originalHomes
             ? `INSERT INTO search.generation_publication_home AS h
               (partition_no,job,pass,epoch,position,account_revision,claim_revision)
              SELECT homes.partition,$3,$4,homes.epoch,homes.current_position,homes.account_revision,homes.claim_revision`
             : `UPDATE search.generation_publication_home h SET position=homes.current_position`
         }
           FROM homes
           LEFT JOIN semantic.partition_subjects s ON s.partition_no=homes.partition
          WHERE $5::text IS NOT NULL
            ${originalHomes ? '' : 'AND h.job=$3 AND h.pass=$4 AND h.partition_no=homes.partition'}
            AND homes.epoch=homes.current_epoch AND homes.write_state='active'
            AND homes.position<homes.current_position AND coalesce(s.visible,0)=0
            AND NOT EXISTS (
              SELECT 1 FROM search.identity_writer w
              WHERE w.physical_target=$5 AND w.partition_no=homes.partition
            )
          ${
            originalHomes
              ? `ON CONFLICT (partition_no,job) DO UPDATE SET position=EXCLUDED.position
             WHERE h.pass=EXCLUDED.pass AND h.epoch=EXCLUDED.epoch AND h.position<EXCLUDED.position`
              : ''
          }
         RETURNING h.partition_no
       )
       SELECT homes.partition,homes.epoch,
              (CASE WHEN refreshed.partition_no IS NULL THEN homes.position ELSE homes.current_position END)::text
                AS position,
              homes.account_revision::text,homes.claim_revision::text,homes.current_epoch,
              homes.current_position::text,homes.write_state,(refreshed.partition_no IS NOT NULL) AS refreshed
         FROM homes LEFT JOIN refreshed ON refreshed.partition_no=homes.partition
        ORDER BY homes.partition`;
    const parameters = [job.home, end, job.job, job.pass, job.family === 'subjects' ? job.physical_target : null];
    const compared = await client.query<
      Home & {
        current_epoch: number | null;
        current_position: string | null;
        write_state: string | null;
        refreshed: boolean;
      }
    >(query, parameters);
    if (beforeRewind || (job.family === 'subjects' && job.fenced_pass))
      meter[validationBytes] +=
        Buffer.byteLength(query) +
        Buffer.byteLength(encodePublicFilterNativeState(parameters)) +
        Buffer.byteLength(encodePublicFilterNativeState(compared.rows));
    meter.inputKeys += compared.rows.length;
    meter.frontierWrites += compared.rows.filter(({ refreshed }) => refreshed).length;
    if (compared.rows.length !== end - job.home) throw new Pending('routing_incomplete');
    for (const { current_epoch, current_position, write_state, refreshed: _refreshed, ...row } of compared.rows) {
      if (write_state !== 'active') throw new Pending('routing_incomplete');
      // The subject pass compares every native home in one statement snapshot. Mixed
      // publication additionally needs the Account owner's current reduction witness.
      const matches =
        job.family === 'subjects'
          ? row.epoch === current_epoch &&
            row.position === current_position &&
            row.account_revision === '0' &&
            row.claim_revision === '0'
          : same(row, await head(row.partition, context));
      if (matches) continue;
      if (
        job.family === 'subjects' &&
        current_epoch === row.epoch &&
        current_position !== null &&
        BigInt(current_position) > BigInt(row.position) &&
        row.account_revision === '0' &&
        row.claim_revision === '0'
      ) {
        const reserveBytes = SUBJECT_VALIDATION_RECHECK_SQL_BYTES + SUBJECT_VALIDATION_CHECKPOINT_BYTES;
        if (
          meter.inputKeys + SUBJECT_VALIDATION_RECHECK_INPUTS + SUBJECT_VALIDATION_TRAILING_INPUTS >
            PUBLIC_FILTER_PREPARATION_INPUT_LIMIT ||
          meter[validationBytes] + reserveBytes >= VALIDATION_BYTE_LIMIT
        ) {
          job.home = row.partition;
          return true;
        }
        // During the held pass, advance has already verified this job's Source and drained writer fence.
        // Retain completed PIT coverage only after proving the entire changed home against settled copies.
        check(context);
        meter[validationBytes] += SUBJECT_VALIDATION_RECHECK_SQL_BYTES;
        if (await refreshChangedSubjectHome(job, row, current_position, client, context, meter)) continue;
      }
      const sameOwnerAdvance =
        current_position !== null &&
        row.account_revision === '0' &&
        row.claim_revision === '0' &&
        advancedUnderSubjectFence(job, row, current_epoch, BigInt(current_position));
      if (job.family === 'subjects' && (!job.fenced_pass || sameOwnerAdvance)) {
        if (beforeRewind) await beforeRewind();
        await rewindSubjectHome(job, row.partition, client, meter);
        if (sameOwnerAdvance) return false;
      } else {
        await client.query('DELETE FROM search.generation_publication_home WHERE partition_no=$1 AND job=$2', [
          row.partition,
          job.job,
        ]);
        job.phase = 'subject';
        job.home = row.partition;
        job.after_id = null;
        job.after_route = null;
        await save(client, job, meter);
      }
      throw new Pending('source_pending');
    }
    job.home = end;
    if (job.home === 4096) job.phase = 'reconciled';
    return true;
  }

  async function validateSealedSubject(
    job: Job,
    client: PoolClient,
    context: PublicFilterConsumerContext,
    meter: Meter,
  ) {
    const recheckTarget = async () => {
      meter.inputKeys += SUBJECT_VALIDATION_TRAILING_INPUTS;
      return native(job.consumer, context, validationSearch(context, meter));
    };
    let longest = 0;
    for (let slice = 0; slice < SUBJECT_VALIDATION_SLICES && job.home < 4096; slice++) {
      const inputs = PUBLIC_FILTER_PREPARATION_INPUT_LIMIT - meter.inputKeys - SUBJECT_VALIDATION_TRAILING_INPUTS;
      const bytes =
        VALIDATION_BYTE_LIMIT -
        meter[validationBytes] -
        SUBJECT_VALIDATION_CHECKPOINT_BYTES -
        SUBJECT_VALIDATION_SQL_BYTES;
      const count = Math.min(
        SUBJECT_VALIDATION_HOMES,
        4096 - job.home,
        inputs,
        Math.floor(bytes / SUBJECT_VALIDATION_ROW_BYTES),
      );
      if (count <= 0) {
        if (slice === 0) throw new Pending('dependency_unavailable');
        break;
      }
      const started = Date.now();
      if (started + 10 + 2 * longest >= context.deadline) {
        if (slice === 0) throw new Pending('deadline');
        break;
      }
      const home = job.home;
      await compareHomes(job, client, context, meter, count, recheckTarget);
      if (job.home < home + count) break;
      longest = Math.max(longest, Date.now() - started);
    }
    await recheckTarget();
    await save(client, job, meter);
  }

  function sparseCut(job: Job, client: PoolClient, context: PublicFilterConsumerContext, meter: Meter) {
    // One lookahead over raw keys and their owners, five four-lane clocks,
    // the receiver root and fixed job, membership and admission points.
    const inputs = 2 * (SPARSE_SUBJECT_KEYS + 1) + 32;
    if (meter.inputKeys + inputs > PUBLIC_FILTER_PREPARATION_INPUT_LIMIT) throw new Pending('dependency_unavailable');
    meter.inputKeys += inputs;
    meter.dependencyPoints += inputs;
    // The bounded SQL statement, fixed-width native rows and digest operands.
    meter[validationBytes] += SUBJECT_VALIDATION_SQL_BYTES + (SPARSE_SUBJECT_KEYS + 1) * SUBJECT_VALIDATION_ROW_BYTES;
    return readSparseSubjectCut(client, validationSearch(context, meter), fence(job));
  }

  async function reconcileSparseSubject(
    job: Job,
    client: PoolClient,
    context: PublicFilterConsumerContext,
    meter: Meter,
    opened?: SparseSubjectCut,
  ) {
    const before = opened ?? (await sparseCut(job, client, context, meter));
    if (before === 'dense') return null;
    if (!before) throw new Pending('source_pending');
    const transport = validationSearch(context, meter);
    const refresh = await transport.request('POST', `/${job.physical_target}/_refresh`);
    validateRefreshResponse(refresh.status, refresh.body);
    const visible = new Set<string>();
    let matched = true;
    for (const [partition, rows] of Map.groupBy(before.keys, (row) => row.home)) {
      const page = await sourceKeys.read({ partition, after: null, inputLimit: rows.length + 1 }, context);
      add(meter, page.cost);
      const { epoch, position } = rows[0]!;
      if (
        page.status !== 'eligible' ||
        !page.complete ||
        page.partition !== partition ||
        page.epoch !== epoch ||
        page.position !== BigInt(position)
      )
        throw new Pending('source_pending');
      if (!page.ids.length) continue;
      meter.inputKeys += 3 * page.ids.length;
      const actions = await readSearchWriterGenerationActions(writerGuard, partition, page.ids, page.position, () =>
        validationWork(context, meter),
      );
      if (!actions) throw new Pending('source_pending');
      for (const action of actions) if (action.op === 'index') visible.add(action.id);
      meter.engineSearches++;
      try {
        meter.inputKeys += await assertNativeGenerationActionsVisible(transport, job.physical_target, actions);
      } catch (error) {
        if (!(error instanceof GenerationReconciliationMismatch)) throw error;
        matched = false;
        break;
      }
    }
    if (matched)
      matched = await matchSparseSubjectKeys(transport, job.physical_target, visible, (count) => {
        meter.engineSearches++;
        meter.engineIteratorSteps++;
        meter.inputKeys += count;
      });
    const current = await sparseCut(job, client, context, meter);
    if (current === 'dense') return null;
    if (!current || !before.digest.equals(current.digest)) throw new Pending('source_pending');
    return matched ? current.digest : null;
  }

  async function advance(
    job: Job,
    client: PoolClient,
    context: PublicFilterConsumerContext,
    meter: Meter,
    batchValidation = false,
    enrollment?: SubjectEnrollmentFrontier,
  ) {
    if (job.phase === 'active') return;
    if (job.fenced_pass) await held(job, context, meter);
    if (job.phase === 'reconciled' || job.phase === 'fencing' || job.phase === 'intent') return;
    if (
      job.family === 'subjects' &&
      job.phase === 'subject' &&
      job.pass === '1' &&
      job.home === 0 &&
      job.after_id === null &&
      (await aliasTarget(job, context, meter)) === null &&
      (await readSubjectActivationTime(
        enrollment ? validationSearch(context, meter) : search,
        job.prefix,
        Number(job.generation),
      )) === null
    )
      await publicationRefresh(job, context, meter, true);
    if (job.phase === 'subject' || job.phase === 'account') {
      // A retained PIT marks an engine page interrupted by a changed Subject home.
      const resumesSubjectEngine = job.family === 'subjects' && job.pit !== null;
      const replaysValidationHome =
        job.family === 'subjects' && job.pit === null && job.previous_uuid === SUBJECT_VALIDATION_REPLAY;
      let emptySeeks = 0;
      const end = enrollment?.end ?? 4096;
      for (;;) {
        const inputLimit = enrollment ? earlySubjectPageLimit(meter) : PAGE;
        if (enrollment && (job.home >= end || inputLimit <= 0)) break;
        if (job.home === 4096) {
          job.phase = 'engine';
          job.home = 0;
          await save(client, job, meter);
          return;
        }
        const before = await head(job.home, context);
        if ((await remember(job, before, client, meter)) === 'rewound') return;
        const after = cursor(job);
        let ids: readonly string[],
          next: SearchPublicFilterSourceKeyCursor | null,
          complete: boolean,
          keys: DiscoveryKey[] | undefined;
        if (job.phase === 'subject') {
          const page = await sourceKeys.read({ partition: job.home, after, inputLimit }, context);
          add(meter, page.cost);
          if (page.status !== 'eligible') {
            job.after_route = null;
            job.after_id = null;
            if (!enrollment) {
              await client.query('DELETE FROM search.generation_publication_home WHERE partition_no=$1 AND job=$2', [
                job.home,
                job.job,
              ]);
              await save(client, job, meter);
            }
            throw new Pending(
              page.status === 'unavailable' && page.reason === 'deadline' ? 'deadline' : 'source_pending',
            );
          }
          if (page.partition !== job.home || page.epoch !== before.epoch || page.position !== BigInt(before.position)) {
            // A same-owner advance only invalidates this page. Read it again
            // from its first key under the held fence before witnessing it.
            if (
              page.partition === before.partition &&
              advancedUnderSubjectFence(job, before, page.epoch, page.position)
            )
              return rewindSubjectHome(job, before.partition, client, meter);
            throw new Pending('source_pending');
          }
          ids = page.ids;
          next = page.after;
          complete = page.complete;

          keys = job.family === 'discovery' ? await keysFor(job.home, ids) : undefined;
          if (job.family === 'discovery') ids = keys!.map(({ id }) => id);
          // Native complete empty pages advance. Identity-pending/moved homes stay pending.
          // Seek occupied visible homes so one turn can reach a real key frontier.
          if (
            !registry &&
            job.family === 'subjects' &&
            !resumesSubjectEngine &&
            !replaysValidationHome &&
            complete &&
            ids.length === 0 &&
            after === null
          ) {
            const nextHome = await nextSubjectHome(job, client, context, meter, end);
            job.after_route = null;
            job.after_id = null;
            job.home = nextHome;
            if (++emptySeeks >= PAGE) {
              if (enrollment) break;
              await save(client, job, meter);
              return;
            }
            continue;
          }
        } else {
          const entry = registry!.get('account');
          if (entry.owner !== 'accounts') throw new Pending('registration_missing');
          const page = validateAccountPage(await entry.source.page(job.home, after, PAGE), job.home, after, PAGE);
          if (page.position !== BigInt(before.position)) throw new Pending('source_pending');
          ids = page.accounts.map(({ id }) => id);
          next = page.next;
          complete = next === null;
          meter.inputKeys += ids.length;

          keys = ids.map((id) => ({ owner: 'accounts', kind: 'account', id, route: routeOf(id)! }));
        }
        await reconcile(job, job.home, ids, keys, BigInt(before.position), context, meter, enrollment !== undefined);
        const observed = await head(job.home, context);
        if (!same(before, observed)) {
          if (advancedUnderSubjectFence(job, before, observed.epoch, BigInt(observed.position)))
            return rewindSubjectHome(job, before.partition, client, meter);
          throw new Pending('source_pending');
        }
        job.after_route = next?.route ?? null;
        job.after_id = next?.id ?? null;
        if (complete) {
          job.after_route = null;
          job.after_id = null;
          if (job.phase === 'subject' && job.family === 'discovery') job.phase = 'account';
          else if (resumesSubjectEngine || replaysValidationHome) {
            // A validation replay needs a fresh engine scan, followed by validation from home zero.
            if (replaysValidationHome) job.previous_uuid = null;
            job.phase = 'engine';
            job.home = 0;
          } else if (job.family === 'subjects' && !registry && ids.length > 0) {
            // The current home is complete and its head still matches. Start the next
            // turn at the next occupied home without reopening Source on an empty neighbor.
            job.home = await nextSubjectHome(job, client, context, meter, end);
            if (!enrollment && job.home === 4096) {
              job.phase = 'engine';
              job.home = 0;
            }
          } else {
            job.phase = 'subject';
            job.home++;
          }
        }
        break;
      }
    } else if (job.phase === 'engine') {
      if (!job.pit) {
        const refreshed = await engine(context, meter, 'POST', `/${job.physical_target}/_refresh`);
        validateRefreshResponse(refreshed.status, refreshed.body);
        const opened = await engine<{
          pit_id?: string;
          _shards?: { total: number; successful: number; failed: number };
        }>(
          context,
          meter,
          'POST',
          `/${job.physical_target}/_search/point_in_time?keep_alive=5m&allow_partial_pit_creation=false`,
        );
        if (
          typeof opened.body.pit_id !== 'string' ||
          !opened.body.pit_id ||
          !opened.body._shards ||
          opened.body._shards.failed !== 0 ||
          opened.body._shards.total !== opened.body._shards.successful
        )
          throw new Pending('source_pending');
        job.pit = opened.body.pit_id;
        await save(client, job, meter);
        return;
      }
      const sources = (job.family === 'discovery' ? ['id', 'owner', 'kind'] : ['id']).map((field) => ({
        [field]: { terms: { field, missing_bucket: true } },
      }));
      const readPage = async (size: number, withHits: boolean) => {
        let response: { status: number; body: unknown };
        try {
          response = await engine<unknown>(context, meter, 'POST', '/_search', {
            // OpenSearch 3.9 flags size-zero count-free searches as terminated early.
            // Keep one metadata-only hit and use only the composite buckets for reconciliation.
            size: 1,
            _source: false,
            track_total_hits: false,
            pit: { id: job.pit, keep_alive: '5m' },
            aggs: {
              keys: {
                composite: { size, sources, ...(job.engine_after ? { after: job.engine_after } : {}) },
                ...(withHits && { aggs: { row: { top_hits: { size: 1, version: true } } } }),
              },
            },
          });
        } catch (error) {
          if (error instanceof OpenSearchError && error.status === 404) {
            // An expired enumeration PIT restarts this finite pass, never skips to its old frontier.
            job.pit = null;
            job.engine_after = null;
            await save(client, job, meter);
            throw new Pending('observation_lost');
          }
          throw error;
        }
        assertCompleteSearch(response.body);
        if (object(response.body) && response.body.pit_id !== undefined) {
          if (typeof response.body.pit_id !== 'string' || !response.body.pit_id) throw new Pending('source_pending');
          job.pit = response.body.pit_id;
        }
        if (!object(response.body) || !object(response.body.aggregations) || !object(response.body.aggregations.keys))
          throw new Pending('source_pending');
        const page = response.body.aggregations.keys;
        if (!Array.isArray(page.buckets) || page.buckets.length > size) throw new Pending('source_pending');
        // Composite after_key is native enumeration state. No returned hit length or total certifies exhaustion.
        const next = page.after_key;
        if (next !== undefined && (!object(next) || same(next, job.engine_after))) throw new Pending('source_pending');
        meter.inputKeys += page.buckets.length;
        meter.engineIteratorSteps++;
        return { buckets: page.buckets, after: next };
      };
      const page = await readPage(PAGE, true);
      const grouped = new Map<string, { partition: number; ids: string[]; keys: DiscoveryUnionKey[]; first: number }>();
      for (const [index, bucket] of page.buckets.entries()) {
        if (
          !object(bucket) ||
          bucket.doc_count !== 1 ||
          !object(bucket.key) ||
          !object(bucket.row) ||
          !object(bucket.row.hits) ||
          !Array.isArray(bucket.row.hits.hits) ||
          bucket.row.hits.hits.length !== 1
        )
          throw new Pending('source_pending');
        const hit: unknown = bucket.row.hits.hits[0];
        if (!object(hit) || hit._index !== job.physical_target || typeof hit._id !== 'string' || !object(hit._source))
          throw new Pending('source_pending');
        let id: string, partition: number, key: DiscoveryUnionKey | undefined;
        if (job.family === 'discovery') {
          key = parseDiscoveryHitIdentity(registry!, hit);
          validateDiscoveryDocument(registry!, hit._source);
          if (
            !same(bucket.key, { id: key.id, owner: key.owner, kind: key.kind }) ||
            discoveryDocumentId(registry!, key) !== hit._id
          )
            throw new Pending('source_pending');
          id = key.id;
          partition = partitionOf(key.route);
        } else {
          id = hit._id;
          const route = routeOf(id);
          if (route === null || hit._source.id !== id || !same(bucket.key, { id })) throw new Pending('source_pending');
          partition = partitionOf(route);
          if (hit._source.partition !== partition) throw new Pending('source_pending');
        }
        const groupKey = `${partition}:${key?.owner ?? 'semantic'}`;
        const group = grouped.get(groupKey) ?? { partition, ids: [], keys: [], first: index };
        group.ids.push(id);
        if (key) group.keys.push(key);
        grouped.set(groupKey, group);
      }
      for (const group of grouped.values()) {
        const coverage = classifyGenerationCoverage(
          job.family === 'discovery' ? group.keys.map((key) => key.id) : group.ids,
          group.ids,
        );
        if (job.fenced_pass && (coverage.missing.length || coverage.extra.length)) throw new Pending('source_pending');
        const before = await head(group.partition, context);
        const verifyChanged = async () => {
          const witness = await verifyChangedEngineHome(job, before, group.ids, context, meter);
          if (
            !witness &&
            job.subscription_protocol === 1 &&
            job.pass === '1' &&
            group.first > 0 &&
            meter.inputKeys + group.first <= PUBLIC_FILTER_PREPARATION_INPUT_LIMIT
          ) {
            // Earlier groups passed their complete writer comparisons on this PIT.
            // Ask the engine for the cursor of their contiguous prefix before rewinding.
            const prefix = await readPage(group.first, false);
            if (
              prefix.after &&
              prefix.buckets.length === group.first &&
              prefix.buckets.every(
                (bucket, i) => object(bucket) && bucket.doc_count === 1 && same(bucket.key, page.buckets[i].key),
              )
            ) {
              job.engine_after = prefix.after;
            }
          }
          return witness;
        };
        const remembered = await remember(
          job,
          before,
          client,
          meter,
          job.family === 'subjects' ? verifyChanged : undefined,
        );
        if (remembered === 'rewound') return;
        if (remembered === 'verified') continue;
        const discoveryKeys =
          job.family === 'discovery'
            ? group.keys.filter((key): key is DiscoveryKey => key.owner === 'semantic' || key.owner === 'accounts')
            : undefined;
        if (discoveryKeys && discoveryKeys.length !== group.keys.length) throw new Pending('source_pending');
        await reconcile(job, group.partition, group.ids, discoveryKeys, BigInt(before.position), context, meter);
        const observed = await head(group.partition, context);
        if (!same(before, observed)) {
          if (advancedUnderSubjectFence(job, before, observed.epoch, BigInt(observed.position)))
            return rewindSubjectHome(job, before.partition, client, meter);
          throw new Pending('source_pending');
        }
      }
      job.engine_after = page.after ?? null;
      if (page.after === undefined) {
        await discardPit(job, context, meter);
        job.phase = 'validate';
        job.home = 0;
      }
    } else {
      let validationHomes = PAGE;
      if (job.family === 'subjects') {
        validationHomes = SUBJECT_VALIDATION_HOMES;
        if (job.fenced_pass) {
          // Leave room to prove at least the first changed home, even when it heads the next turn.
          validationHomes =
            PUBLIC_FILTER_PREPARATION_INPUT_LIMIT -
            meter.inputKeys -
            SUBJECT_VALIDATION_RECHECK_INPUTS -
            SUBJECT_VALIDATION_TRAILING_INPUTS;
          if (validationHomes <= 0) throw new Pending('dependency_unavailable');
        }
      }
      if (batchValidation) {
        await validateSealedSubject(job, client, context, meter);
        return;
      }
      if (!(await compareHomes(job, client, context, meter, validationHomes))) return;
    }
    if (enrollment) return checkpointEnrolledSubjects(job, client, context, meter, enrollment);
    await native(job.consumer, context);
    await save(client, job, meter);
  }
  function alias(job: Job) {
    return (job.family === 'subjects' ? subjectAlias : discoveryAlias)(job.prefix);
  }
  function publicationRefresh(job: Job, context: PublicFilterConsumerContext, meter: Meter, preparing: boolean) {
    const transport: OpenSearch = {
      ...search,
      request: (method, path, body) => engine(context, meter, method, path, body),
    };
    return setSubjectPublicationRefresh(transport, job.physical_target, job.native_incarnation, preparing);
  }
  async function aliasTarget(job: Job, context: PublicFilterConsumerContext, meter: Meter): Promise<string | null> {
    let response: { status: number; body: unknown };
    try {
      response = await engine(context, meter, 'GET', `/_alias/${alias(job)}`);
    } catch (error) {
      if (error instanceof OpenSearchError && error.status === 404) return null;
      throw error;
    }
    if (response.status !== 200 || !object(response.body) || Object.keys(response.body).length !== 1)
      throw new Pending('source_pending');
    const name = Object.keys(response.body)[0]!,
      entry = response.body[name];
    if (!object(entry) || !object(entry.aliases)) throw new Pending('source_pending');
    const options = entry.aliases[alias(job)];
    if (!object(options) || Object.keys(options).length !== 0) throw new Pending('source_pending');
    const identity = locator({ ...job.consumer, physicalTarget: name });
    if (identity.prefix !== job.prefix || identity.family !== job.family) throw new Pending('source_pending');
    return name;
  }
  function newerSubjectAlias(job: Job, current: string | null) {
    return (
      job.family === 'subjects' &&
      current !== null &&
      locator({ ...job.consumer, physicalTarget: current }).generation > Number(job.generation)
    );
  }
  async function installFence(job: Job, client: PoolClient, context: PublicFilterConsumerContext, meter: Meter) {
    guardAvailable();
    // Persist invocation intent before the native gate can be installed. A lost fence response is
    // recovered by that same producer/job, even when Source changes before the next adoption.
    job.phase = 'fencing';
    await save(client, job, meter);
    const result = await writerGuard.fencePublication(reference(job), context);
    add(meter, result.cost);
    if (result.status !== 'fenced') throw new Pending(result.reason);
    if (result.fence.job !== job.job || !same(result.fence.consumer, job.consumer) || !result.fence.fence)
      throw new Pending('incarnation_changed');
    job.fence = result.fence.fence;
    await save(client, job, meter);
    bookPreparationTiming?.mark('writerFence');
  }
  async function prepareIntent(
    job: Job,
    client: PoolClient,
    context: PublicFilterConsumerContext,
    meter: Meter,
    queried: GenerationPublicationPin['queried'],
  ) {
    if (!job.observation) job.observation = queried.snapshot.observation;
    const previous = await aliasTarget(job, context, meter);
    if (newerSubjectAlias(job, previous)) throw new Pending('source_pending');
    if (job.family === 'subjects') await publicationRefresh(job, context, meter, false);
    job.previous_target = previous;
    job.previous_uuid = job.previous_target ? await discoveryIndexUuid(search, job.previous_target) : null;
    job.activated_at = config.clock().toISOString();
    job.phase = 'intent';
    await save(client, job, meter);
  }
  async function release(job: Job, context: PublicFilterConsumerContext, meter: Meter) {
    if (!job.fence) return;
    const result = await writerGuard.releasePublication(fence(job), context);
    add(meter, result.cost);
    if (result.status !== 'released') throw new Pending(result.reason);
    // The pass remains evidence of how the active job completed. Restart invalidates it separately.
    job.fence = null;
  }
  async function restart(job: Job, client: PoolClient, context: PublicFilterConsumerContext, meter: Meter) {
    // Roll back only our exact alias intent, under the still-held native admission/copy fence.
    if (job.phase === 'intent') {
      // Source may have changed after the alias request. Recover admission custody independently
      // before restoring this exact intent; a publication-completion verdict cannot authorize abort.
      const retained = await writerGuard.fencePublication(reference(job), context);
      add(meter, retained.cost);
      if (retained.status !== 'fenced' || !same(retained.fence, fence(job))) throw new Pending('source_pending');
      const current = await aliasTarget(job, context, meter);
      if (current === job.physical_target) {
        const previous = job.previous_target;
        if (previous && (await discoveryIndexUuid(search, previous)) !== job.previous_uuid)
          throw new Pending('incarnation_changed');
        await observedWrite(
          () =>
            search.request('POST', '/_aliases', {
              actions: [
                { remove: { index: job.physical_target, alias: alias(job) } },
                ...(previous ? [{ add: { index: previous, alias: alias(job) } }] : []),
              ],
            }),
          async () => (await aliasTarget(job, context, meter)) === previous,
          'Publication rollback could not be established',
        );
      } else if (current !== job.previous_target) throw new Pending('source_pending');
    }
    await discardPit(job, context, meter);
    // The alias rollback above is established before retiring its retained intent and releasing admission.
    if (job.phase === 'intent') {
      job.phase = 'fencing';
      await save(client, job, meter);
    }
    await release(job, context, meter);
    job.phase = 'subject';
    job.home = 0;
    job.after_id = null;
    job.after_route = null;
    // Keep the original Source tuple across reconciliation/fence retries.
    job.previous_target = null;
    job.previous_uuid = null;
    // Indexed bounded invalidation: old home rows are replaced lazily as their native home is revisited.
    job.fenced_pass = false;
    job.subject_fenced_cut = null;
    job.pass = (BigInt(job.pass) + 1n).toString();
    await save(client, job, meter);
  }
  const api: SearchGenerationPublication = {
    prepare(consumer, context) {
      const input = structuredClone(consumer);
      locator(input);
      return run(context, async (meter) => {
        const target = await native(input, context);
        const custody = await readGenerationPublicationCustody(pool, input, undefined, context);
        add(meter, custody.cost);
        if ('status' in custody) throw new Pending(custody.reason === 'deadline' ? 'deadline' : 'registration_missing');
        const resolved = await binding.resolve(
          { source, meaning: structuredClone(meaning), capture: publicationCapture(custody.definition.capture) },
          context,
        );
        add(meter, resolved.cost);
        if (resolved.status !== 'resolved')
          throw new Pending(resolved.reason === 'deadline' ? 'deadline' : 'source_pending');
        const capture = populationDefinition(resolved.definition);
        if (
          resolved.definition.meaning.digest !== input.meaningDigest ||
          resolved.definition.readDefinition !== input.readDefinition ||
          resolved.definition.source.partition !== custody.definition.source.partition ||
          !same(
            bindingKey(resolved.definition),
            bindingKey({
              ...resolved.definition,
              source: custody.definition.source,
              readDefinition: custody.definition.readDefinition,
            }),
          )
        )
          throw new Pending('registration_missing');
        const ackProtocol =
          (config.subjectAckProtocol === 1 || config.subjectSubscriptionProtocol === 1) &&
          nativeMeaning &&
          !registry &&
          target.family === 'subjects' &&
          target.activeSubjectGeneration === null &&
          resolved.definition.source.partition === 0 &&
          'catalogueCoverage' in capture &&
          capture.catalogueCoverage === true
            ? 1
            : 0;
        const shared = config.subjectSubscriptionProtocol === 1 && ackProtocol === 1;
        const id = randomUUID();
        const job = await withBoundedReadConnection(
          pool,
          context.deadline,
          async (client) => {
            if (shared) await client.query('BEGIN');
            try {
              const result = await client.query<Job>(
                `INSERT INTO search.generation_publication
          (job,physical_target,consumer,prefix,generation,family,native_incarnation,kinds,source_home,binding,activated_at,ack_protocol,subscription_protocol)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
            CASE WHEN $12::smallint=1
              AND to_regprocedure('semantic.public_filter_ack_origin(text,uuid)') IS NOT NULL THEN 1 ELSE 0 END,$13)
          ON CONFLICT(partition_no,physical_target,consumer) DO NOTHING RETURNING *`,
                [
                  id,
                  input.physicalTarget,
                  input,
                  target.prefix,
                  target.generation,
                  target.family,
                  target.incarnation,
                  kinds.map(({ kind, owner }) => `${owner}:${kind}`),
                  resolved.definition.source.partition,
                  bindingKey(resolved.definition),
                  config.clock().toISOString(),
                  ackProtocol,
                  shared ? 1 : 0,
                ],
              );
              if (shared) {
                if (result.rowCount) {
                  const birth = await reserveHeldSubjectPreparation(client, { job: id, bootstrap: randomUUID() });
                  const membership = await client.query<{ key_count: number }>(
                    'SELECT key_count FROM core.subject_subscription_v1 WHERE birth=$1',
                    [birth],
                  );
                  meter.inputKeys += 96;
                  meter.dependencyPoints += 96;
                  meter.frontierWrites += 5 + membership.rows[0]!.key_count;
                }
                await client.query('COMMIT');
              }
              return (
                result.rows[0] ??
                (
                  await client.query<Job>(
                    'SELECT * FROM search.generation_publication WHERE partition_no=0 AND physical_target=$1 AND consumer=$2',
                    [input.physicalTarget, input],
                  )
                ).rows[0]
              );
            } catch (error) {
              if (shared) await client.query('ROLLBACK');
              throw error;
            }
          },
          publicationLifetime,
        );
        if (!job || !same(job.consumer, input)) throw new Pending('incarnation_changed');
        await adopt(job, context, meter);
        return { status: 'preparing' as const, job: reference(job), cost: meter };
      });
    },
    step(input, context, options) {
      const phase = options?.enrollSource === true ? 'step-enroll' : 'step';
      const offers = options?.heldOffers ?? 16;
      requireValue(Number.isSafeInteger(offers) && offers >= 1 && offers <= 16);
      if (options?.heldLane !== undefined)
        requireValue(
          (options.heldLane === 'capture' || options.heldLane === 'source') &&
            phase === 'step-enroll' &&
            options.batchSource === true &&
            offers >= 5,
        );
      return run(context, (meter) =>
        locked(
          input,
          context,
          meter,
          phase,
          async (job, client, _current, capture, enrolled, additionalEnrollmentCosts) => {
            if (enrolled === true)
              return {
                status: 'progress' as const,
                job: reference(job),
                sourceAdvanced: true,
                cost: meter,
                ...(additionalEnrollmentCosts?.length ? { additionalEnrollmentCosts } : {}),
              };
            const mayEnroll = phase === 'step-enroll' && canEnrollSubject(job);
            const batchValidation = enrolled === 'sealed' && job.phase === 'validate' && job.pass === '1';
            let waiting: Pending | undefined;
            let sourceAdvanced = false;
            try {
              try {
                await advance(job, client, context, meter, batchValidation);
              } catch (error) {
                if (!mayEnroll || !(error instanceof Pending) || error.reason !== 'source_pending') throw error;
                waiting = error;
              }
              // A writer or replay can stall reconciliation while original Source
              // enrollment can still commit. Only that progress bypasses backoff.
              if (
                mayEnroll &&
                !batchValidation &&
                meter.inputKeys < PUBLIC_FILTER_PREPARATION_INPUT_LIMIT - PUBLIC_FILTER_PREPARATION_INPUT_RESERVE
              ) {
                sourceAdvanced =
                  ((await continueSubjectEnrollment(job, client, context, meter)) ??
                    (await completeSource(job, client, context, meter, capture, true)).sourceAdvanced) === true;
              }
              if (waiting && !sourceAdvanced) throw waiting;
              if (waiting) await save(client, job, meter);
            } catch (error) {
              if (
                error instanceof Pending &&
                error.reason === 'source_pending' &&
                job.fence &&
                job.phase !== 'intent' &&
                job.phase !== 'active'
              )
                await restart(job, client, context, meter);
              else if (!batchValidation && error instanceof Pending && error.reason === 'source_pending')
                await save(client, job, meter);
              throw error;
            }
            // Fencing and intent do no step work; the existing scheduler must resume activate.
            return {
              status:
                !waiting &&
                (job.phase === 'reconciled' ||
                  job.phase === 'fencing' ||
                  job.phase === 'intent' ||
                  job.phase === 'active')
                  ? ('reconciled' as const)
                  : ('progress' as const),
              job: reference(job),
              cost: meter,
              ...(sourceAdvanced ? { sourceAdvanced } : {}),
            };
          },
          options?.batchSource && offers >= 3,
          offers,
          options?.heldLane,
        ),
      );
    },
    activate(input, context, options) {
      return run(context, (meter) =>
        locked(input, context, meter, 'activate', async (job, client, current, capture, enrollmentAdvanced) => {
          const preparing = (next: 'activate' | 'step', advanced = false, sourceAdvanced = false) => ({
            status: 'preparing' as const,
            job: reference(job),
            next,
            advanced,
            ...(sourceAdvanced ? { sourceAdvanced } : {}),
            cost: meter,
          });
          if (typeof enrollmentAdvanced === 'boolean')
            return preparing('activate', enrollmentAdvanced, enrollmentAdvanced);
          const superseded = newerSubjectAlias(job, current);
          if (job.phase === 'active') {
            if (current !== job.physical_target && !superseded) throw new Pending('source_pending');
            if (job.fence) {
              await release(job, context, meter);
              await save(client, job, meter);
            }
            return {
              status: superseded ? ('superseded' as const) : ('activated' as const),
              consumer: job.consumer,
              cost: meter,
            };
          }
          if (job.phase !== 'reconciled' && job.phase !== 'fencing' && job.phase !== 'intent')
            return preparing('step', true);
          guardAvailable();
          if (!job.fence) {
            const started = Date.now();
            const sourceCompletion = await completeSource(job, client, context, meter, capture);
            if (!sourceCompletion.complete) {
              if (
                options?.batchSource &&
                nativeMeaning &&
                job.family === 'subjects' &&
                job.phase === 'reconciled' &&
                current === null &&
                jobPin(job) &&
                sourceCompletion.sourceAdvanced
              ) {
                // A successful Source turn has committed its own exact repair or ACK frontier.
                // Resume under the same alias lock, with the same deadline and a fresh meter.
                const additionalSourceCosts: SearchPublicFilterCost[] = [];
                let longest = Date.now() - started;
                let drainReceiver = job.subscription_protocol === 1;
                while (additionalSourceCosts.length + 1 < SUBJECT_SETTLEMENT_TURNS) {
                  const nextStarted = Date.now();
                  if (nextStarted + 2 * longest >= context.deadline) break;
                  const nextMeter = cost();
                  additionalSourceCosts.push(nextMeter);
                  if (drainReceiver) {
                    drainReceiver = await prepareHeldReceiverAck(job, client, nextMeter);
                    longest = Math.max(longest, Date.now() - nextStarted);
                    continue;
                  }
                  const next = await completeSource(job, client, context, nextMeter, capture);
                  if (next.complete && job.subscription_protocol === 1) {
                    // This invocation holds the alias lock and just verified the original Source.
                    // Retain the writer fence before yielding that completed settlement turn.
                    await installFence(job, client, context, nextMeter);
                    break;
                  }
                  if (!next.sourceAdvanced || next.complete) break;
                  longest = Math.max(longest, Date.now() - nextStarted);
                }
                return { ...preparing('activate', true, true), additionalSourceCosts };
              }
              return preparing('activate', sourceCompletion.advanced, sourceCompletion.sourceAdvanced);
            }
            await installFence(job, client, context, meter);
          }
          try {
            if (!job.fenced_pass) {
              const result = await writerGuard.drainPublication(fence(job), context);
              add(meter, result.cost);
              if ('reason' in result) throw new Pending(result.reason);
              if (!same(result.fence, fence(job))) throw new Pending('incarnation_changed');
              if (result.status === 'draining') return preparing('activate', result.advanced);
              const source = nativeSourceForHeldPublication(result);
              if (source) {
                const retained = jobPin(job);
                if (!retained || !sameGenerationPublicationPin(retained, source)) throw new Pending('source_pending');
              } else await held(job, context, meter);
              // Fencing starts at the completed first-pass frontier. Home zero in fencing
              // retains one inconclusive sparse comparison for a fresh activation turn.
              const retryingSparse = job.home === 0;
              if (!retryingSparse) bookPreparationTiming?.mark('writerDrain');
              let proofCost = meter;
              let cut: Buffer | null = null;
              if (
                source &&
                !registry &&
                job.subscription_protocol === 1 &&
                current === null &&
                (options?.batchSource ||
                  meter.inputKeys + 12 * SPARSE_SUBJECT_KEYS + 80 < PUBLIC_FILTER_PREPARATION_INPUT_LIMIT)
              ) {
                proofCost = options?.batchSource ? cost() : meter;
                try {
                  cut = await reconcileSparseSubject(job, client, context, proofCost);
                } catch (error) {
                  if (
                    !(error instanceof SearchUnavailableError) &&
                    !(error instanceof Pending && error.reason === 'source_pending')
                  )
                    throw error;
                  if (!retryingSparse) {
                    job.home = 0;
                    await save(client, job, meter);
                    return {
                      ...preparing('activate', true),
                      ...(proofCost === meter ? {} : { additionalSourceCosts: [proofCost] }),
                    };
                  }
                }
              }
              job.fenced_pass = true;
              job.pass = (BigInt(job.pass) + 1n).toString();
              job.after_id = null;
              job.after_route = null;
              job.subject_fenced_cut = cut;
              if (source && cut) {
                job.home = 4096;
                await prepareIntent(job, client, context, proofCost, source.queried);
              } else {
                job.phase = 'subject';
                job.home = 0;
                await save(client, job, meter);
              }
              return {
                ...preparing(cut ? 'activate' : 'step', true),
                ...(proofCost === meter ? {} : { additionalSourceCosts: [proofCost] }),
              };
            }
            if (job.phase !== 'intent') {
              const queried = await adoptHeld(job, client, context, meter);
              await prepareIntent(job, client, context, meter, queried);
              return preparing('activate', true);
            }
            if (newerSubjectAlias(job, job.previous_target)) throw new Pending('source_pending');
            const before = await aliasTarget(job, context, meter);
            if (newerSubjectAlias(job, before)) throw new Pending('source_pending');
            if (before !== job.physical_target && before !== job.previous_target) throw new Pending('source_pending');
            const proofCosts: Meter[] = [];
            if (before !== job.physical_target || job.family === 'subjects') {
              const ready = await confirmHeldIntent(
                job,
                client,
                context,
                meter,
                before,
                options?.batchSource ? proofCosts : undefined,
              );
              if (!ready)
                return {
                  ...preparing('step', true),
                  ...(proofCosts.length ? { additionalSourceCosts: proofCosts } : {}),
                };
            }
            if (job.family === 'subjects') {
              await publicationRefresh(job, context, meter, false);
              const activationSearch: OpenSearch = {
                ...search,
                request: (method, path, body) => engine(context, meter, method, path, body),
              };
              await markSubjectCalendarReady(
                activationSearch,
                job.prefix,
                Number(job.generation),
                job.native_incarnation,
              );
              await publishSubjectActivationMetadata(activationSearch, job.physical_target, job.activated_at);
            }
            if (before !== job.physical_target) {
              await observedWrite(
                () =>
                  search.request('POST', '/_aliases', {
                    actions: [
                      ...(job.previous_target ? [{ remove: { index: job.previous_target, alias: alias(job) } }] : []),
                      { add: { index: job.physical_target, alias: alias(job) } },
                    ],
                  }),
                async () => (await aliasTarget(job, context, meter)) === job.physical_target,
                'Generation publication alias could not be established',
              );
              // The retained intent and fence own confirmation on the next metered turn.
              bookPreparationTiming?.mark('aliasWrite');
              if (job.family === 'subjects')
                return {
                  ...preparing('activate', true),
                  ...(proofCosts.length ? { additionalSourceCosts: proofCosts } : {}),
                };
            }
            if (job.family === 'discovery') await adoptHeld(job, client, context, meter);
            if ((await aliasTarget(job, context, meter)) !== job.physical_target) throw new Pending('source_pending');
            bookPreparationTiming?.mark('aliasConfirmed');
            // Native readback precedes metadata. Lost replies replay the retained intent under the same fence.
            if (job.family === 'discovery') {
              await client.query('BEGIN');
              try {
                if (job.previous_target)
                  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [job.previous_target]);
                await client.query(
                  `UPDATE search.discovery_generation SET state='retiring' WHERE partition_no=0 AND prefix=$1 AND state='active' AND generation<>$2`,
                  [job.prefix, job.generation],
                );
                const updated = await client.query(
                  `UPDATE search.discovery_generation SET state='active',activated_at=COALESCE(activated_at,clock_timestamp())
                WHERE partition_no=0 AND prefix=$1 AND generation=$2 AND index_uuid=$3 AND incarnation=$4
                AND state NOT IN ('retired','retiring','quarantined','allocated') RETURNING generation`,
                  [job.prefix, job.generation, job.consumer.incarnation, job.native_incarnation],
                );
                if (updated.rowCount !== 1) throw new Pending('incarnation_changed');
                job.phase = 'active';
                await save(client, job, meter);
                await client.query('COMMIT');
              } catch (error) {
                await client.query('ROLLBACK');
                throw error;
              }
            } else {
              job.phase = 'active';
              await save(client, job, meter);
            }
            await release(job, context, meter);
            await save(client, job, meter);
            return { status: 'activated' as const, consumer: job.consumer, cost: meter };
          } catch (error) {
            if (
              error instanceof Pending &&
              ['source_pending', 'routing_incomplete', 'incarnation_changed'].includes(error.reason) &&
              job.phase !== 'active'
            )
              await restart(job, client, context, meter);
            throw error;
          }
        }),
      );
    },
    async close() {
      closed = true;
      await Promise.allSettled([...pending]);
    },
  };
  return api;
}
