import { advanceNativeGenerationSource } from './public-filter-consumer.ts';
import { readNativePublicFilterPublicationCompletion } from '../semantic/public-filter-source-binding.ts';
import { bindSearchWriterPublicationSource, readSearchWriterGenerationActions } from './writer-guard.ts';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { releaseDigest } from '@rezics/definitions';
import type { Pool, PoolClient } from 'pg';
import type { KernelClock } from '../clock.ts';
import { routeOf, partitionOf } from '../route/route.ts';
import { readAccountDiscoveryWitness } from '../access/account-discovery-source.ts';
import { subjectListingSource } from '../library/listing-counts.ts';
import type {
  PublicFilterConsumer,
  PublicFilterCost,
  PublicFilterProjectionMeaning,
  PublicFilterSource,
} from '../semantic/public-filter-source-contract.ts';
import type {
  PublicFilterSourceBinding,
  PublicFilterSourceDefinition,
} from '../semantic/public-filter-source-binding.ts';
import type { SubjectSourceKeyPages, SubjectSourceKeyCursor } from '../semantic/subject-source-key-pages.ts';
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
import { readGenerationPublicationCustody } from './public-filter-custody.ts';
import { discoveryAlias } from './indices.ts';
import {
  discoveryIndexName,
  discoveryIndexUuid,
  subjectAlias,
  subjectIndexName,
  subjectGenerations,
  readSubjectSortFormat,
  SUBJECT_SORT_FORMAT,
} from './indices.ts';
import { discoveryGenerations } from './generations.ts';
import { OpenSearchError, type OpenSearch } from './opensearch.ts';
import { assertCompleteSearch } from './complete-search.ts';
import { validateObservation } from './indexer.ts';
import { validateRefreshResponse } from './write-actions.ts';

export type GenerationPublicationJob = Readonly<{ consumer: PublicFilterConsumer; job: string }>;
export type SearchGenerationPublication = Readonly<{
  prepare(
    consumer: PublicFilterConsumer,
    context: PublicFilterConsumerContext,
  ): Promise<
    { status: 'preparing'; job: GenerationPublicationJob; cost: PublicFilterCost } | PublicFilterConsumerUnavailable
  >;
  step(
    job: GenerationPublicationJob,
    context: PublicFilterConsumerContext,
  ): Promise<
    | { status: 'progress' | 'reconciled'; job: GenerationPublicationJob; cost: PublicFilterCost }
    | PublicFilterConsumerUnavailable
  >;
  activate(
    job: GenerationPublicationJob,
    context: PublicFilterConsumerContext,
  ): Promise<
    | { status: 'activated'; consumer: PublicFilterConsumer; cost: PublicFilterCost }
    | { status: 'preparing'; job: GenerationPublicationJob; cost: PublicFilterCost }
    | PublicFilterConsumerUnavailable
  >;
  close(): Promise<void>;
}>;
export type SearchGenerationPublicationConfig = Readonly<{
  pool: Pool;
  search: OpenSearch;
  source: PublicFilterSource;
  sourceKeys: SubjectSourceKeyPages;
  binding: PublicFilterSourceBinding;
  clock: KernelClock;
  meaning: PublicFilterProjectionMeaning;
  writerGuard: SearchWriterPublicationGuard;
  registry?: DiscoveryRegistry;
}>;

type Meter = { -readonly [K in keyof PublicFilterCost]: number };
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
});
const PAGE = 50;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const same = isDeepStrictEqual;
class Pending extends Error {
  constructor(readonly reason: PublicFilterConsumerUnavailable['reason']) {
    super(reason);
  }
}
function requireValue(value: unknown): asserts value {
  if (!value) throw new TypeError('Invalid generation publication input');
}
function check(context: PublicFilterConsumerContext) {
  requireValue(Number.isFinite(context.deadline));
  if (context.deadline <= Date.now()) throw new Pending('deadline');
}
function add(meter: Meter, value: PublicFilterCost) {
  for (const key of Object.keys(meter) as (keyof Meter)[]) {
    requireValue(Number.isSafeInteger(value[key]) && value[key] >= 0);
    meter[key] += value[key];
  }
  if (meter.inputKeys > 1000 || meter.resultWrites > 1000) throw new Pending('dependency_unavailable');
}
function locator(consumer: PublicFilterConsumer) {
  requireValue(
    object(consumer) && Object.keys(consumer).length === 6 && Buffer.byteLength(JSON.stringify(consumer)) <= 2048,
  );
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
  return { prefix, family, generation };
}
function bindingKey(definition: PublicFilterSourceDefinition) {
  return {
    source: definition.source,
    meaning: { digest: definition.meaning.digest, type: definition.meaning.type },
    readDefinition: definition.readDefinition,
  };
}
type Job = {
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
  revision: string;
};
type Home = { partition: number; epoch: number; position: string; account_revision: string; claim_revision: string };

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
  const metadata = { ...(await mapping()), name_sort_format: SUBJECT_SORT_FORMAT, activated_at: activatedAt };
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
      typeof config.clock === 'function' &&
      config.writerGuard &&
      typeof config.writerGuard.write === 'function',
  );
  requireValue(config.meaning.digest === releaseDigest(config.meaning.release));
  const { pool, search, source, sourceKeys, binding, writerGuard, registry } = config;
  bindSearchWriterPublicationSource(writerGuard, binding);
  const meaning = structuredClone(config.meaning);
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
    const operation = (async () => {
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
        };
      }
    })();
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
  async function native(consumer: PublicFilterConsumer, context: PublicFilterConsumerContext) {
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
    if ((await discoveryIndexUuid(search, consumer.physicalTarget)) !== consumer.incarnation)
      throw new Pending('incarnation_changed');
    let incarnation = consumer.incarnation;
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
      const response = await search.request<Record<string, { mappings?: { _meta?: { incarnation?: string } } }>>(
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
      const generations = await subjectGenerations(search, target.prefix);
      if (
        !generations.generations.includes(target.generation) ||
        (await readSubjectSortFormat(search, target.prefix, target.generation)) !== SUBJECT_SORT_FORMAT
      )
        throw new Pending('registration_missing');
    }
    check(context);
    return { ...target, incarnation };
  }
  function publicationCapture(
    capture: PublicCanonicalCaptureInput,
  ): PublicFilterConsumerCaptureInput | DiscoveryConsumerCaptureInput {
    // Suggestion custody has its own canonical prefix semantics and cannot certify all-key population.
    if (!('sort' in capture)) throw new Pending('registration_missing');
    return capture;
  }
  function populationDefinition(definition: PublicFilterSourceDefinition) {
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
    if (definition.meaning.digest !== meaning.digest || definition.meaning.type !== meaning.type)
      throw new Pending('registration_missing');
  }
  async function adopt(job: Job, context: PublicFilterConsumerContext, meter: Meter, needObservation = false) {
    const current = await native(job.consumer, context);
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
    const resolved = await binding.resolve(
      { source, meaning: structuredClone(meaning), capture: publicationCapture(custody.definition.capture) },
      context,
    );
    add(meter, resolved.cost);
    if (resolved.status !== 'resolved')
      throw new Pending(resolved.reason === 'deadline' ? 'deadline' : 'source_pending');
    populationDefinition(resolved.definition);
    if (
      !same(bindingKey(resolved.definition), job.binding) ||
      resolved.definition.readDefinition !== job.consumer.readDefinition ||
      !same(resolved.definition.capture, custody.definition.capture) ||
      !same(resolved.definition.dependencyKeys, custody.definition.dependencyKeys)
    )
      throw new Pending('source_pending');
    if (!needObservation) return;
    const completion = await readNativePublicFilterPublicationCompletion(binding, { job: job.job }, context);
    add(meter, completion.cost);
    if (completion.status !== 'complete') throw new Pending('source_pending');
    return completion.publication.queried;
  }
  async function completeSource(job: Job, client: PoolClient, context: PublicFilterConsumerContext, meter: Meter) {
    const custody = await readGenerationPublicationCustody(
      pool,
      job.consumer,
      job.source_home,
      context,
      job.observation ?? undefined,
    );
    add(meter, custody.cost);
    if (!('definition' in custody)) throw new Pending('source_pending');
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
        ...(registry ? { registry } : {}),
      },
      {
        job: job.job,
        consumer: job.consumer,
        capture: publicationCapture(custody.definition.capture) as PublicFilterConsumerCaptureInput,
        ...(job.observation ? { observation: job.observation } : {}),
      },
      context,
    );
    add(meter, completion.cost);
    if ('publication' in completion && !job.observation) {
      job.observation = completion.publication.queried.snapshot.observation;
      await save(client, job, meter);
    }
    return completion.status === 'complete';
  }

  const reference = (job: Job): GenerationPublicationJob => ({ consumer: structuredClone(job.consumer), job: job.job });
  const fence = (job: Job): SearchWriterPublicationFence => ({
    consumer: job.consumer,
    job: job.job,
    fence: job.fence!,
  });
  function guardAvailable() {
    if (
      typeof writerGuard.fencePublication !== 'function' ||
      typeof writerGuard.drainPublication !== 'function' ||
      typeof writerGuard.adoptPublication !== 'function' ||
      typeof writerGuard.releasePublication !== 'function'
    )
      throw new Pending('source_pending');
  }
  async function held(job: Job, context: PublicFilterConsumerContext, meter: Meter) {
    guardAvailable();
    if (!job.fence) throw new Pending('source_pending');
    const result = await writerGuard.adoptPublication(fence(job), context);
    add(meter, result.cost);
    if (result.status !== 'held') throw new Pending(result.reason);
    if (!same(result.fence, fence(job))) throw new Pending('incarnation_changed');
  }
  async function save(client: PoolClient, job: Job, meter: Meter) {
    const result = await client.query(
      `UPDATE search.generation_publication SET phase=$3,home=$4,after_route=$5,after_id=$6,engine_after=$7,
       pit=$8,fence=$9,fenced_pass=$10,observation=$11,previous_target=$12,previous_uuid=$13,pass=$14,activated_at=$15,revision=revision+1
       WHERE partition_no=0 AND job=$1 AND revision=$2 RETURNING revision::text`,
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
    work: (job: Job, client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const ref = structuredClone(input);
    locator(ref.consumer);
    requireValue(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(ref.job));
    // This is a maintenance session lock, not a command transaction. Native owners acquire their own
    // bounded snapshot connections; do not wrap them in withConnection's single-command checkout scope.
    const client = await pool.connect();
    let broken: Error | undefined;
    try {
      const lock = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock(hashtextextended($1,2)) AS locked',
        [ref.job],
      );
      if (!lock.rows[0]?.locked) throw new Pending('source_pending');
      try {
        const {
          rows: [job],
        } = await client.query<Job>('SELECT * FROM search.generation_publication WHERE partition_no=0 AND job=$1', [
          ref.job,
        ]);
        if (!job || !same(job.consumer, ref.consumer)) throw new Pending('registration_missing');
        if (job.phase === 'active') {
          // Settled publication may still need idempotent fence release after a lost response.
          // A later Source change must not strand the ordinary repair writer behind that old fence.
          await native(job.consumer, context);
        } else {
          try {
            await adopt(job, context, meter);
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
        return await work(job, client);
      } finally {
        try {
          await client.query('SELECT pg_advisory_unlock(hashtextextended($1,2))', [ref.job]);
        } catch (error) {
          broken = error instanceof Error ? error : new Error(String(error));
          throw error;
        }
      }
    } finally {
      client.release(broken);
    }
  }
  async function head(partition: number): Promise<Home> {
    const {
      rows: [row],
    } = await pool.query<{ epoch: number; position: string }>(
      'SELECT epoch,position::text FROM core.partition WHERE partition_no=$1',
      [partition],
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
  async function remember(job: Job, before: Home, client: PoolClient) {
    const {
      rows: [old],
    } = await client.query<Home>(
      `SELECT partition_no AS partition,epoch,position::text,account_revision::text,claim_revision::text
      FROM search.generation_publication_home WHERE partition_no=$1 AND job=$2 AND pass=$3`,
      [before.partition, job.job, job.pass],
    );
    if (old && !same(old, before)) {
      await client.query('DELETE FROM search.generation_publication_home WHERE partition_no=$1 AND job=$2', [
        before.partition,
        job.job,
      ]);
      job.phase = 'subject';
      job.home = before.partition;
      job.after_route = null;
      job.after_id = null;
      throw new Pending('source_pending');
    }
    if (!old)
      await client.query(
        `INSERT INTO search.generation_publication_home
      (partition_no,job,epoch,position,account_revision,claim_revision,pass) VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT(partition_no,job) DO UPDATE SET epoch=EXCLUDED.epoch,position=EXCLUDED.position,
        account_revision=EXCLUDED.account_revision,claim_revision=EXCLUDED.claim_revision,pass=EXCLUDED.pass`,
        [
          before.partition,
          job.job,
          before.epoch,
          before.position,
          before.account_revision,
          before.claim_revision,
          job.pass,
        ],
      );
  }
  function cursor(job: Job): SubjectSourceKeyCursor | null {
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
  async function reconcile(
    job: Job,
    partition: number,
    ids: readonly string[],
    keys: readonly DiscoveryKey[] | undefined,
    position: bigint,
    context: PublicFilterConsumerContext,
    meter: Meter,
  ) {
    if (!ids.length) return;
    check(context);
    meter.inputKeys += ids.length;
    if (job.family === 'subjects') {
      const actions = await readSearchWriterGenerationActions(writerGuard, partition, ids, position);
      meter.inputKeys += ids.length * 2; // current Source inputs and retained native copies
      if (actions) {
        meter.engineSearches++;
        try {
          meter.inputKeys += await assertNativeGenerationActionsVisible(search, job.physical_target, actions);
          return;
        } catch (error) {
          if (!(error instanceof GenerationReconciliationMismatch)) throw error;
        }
      }
      if (job.fenced_pass) throw new Pending('source_pending');
      // Repairs use the sole native writer. Its enrollment/settlement changes the native head;
      // replay the affected home before adopting any new frontier or reconciliation witness.
      await writerGuard.write(partition, ids, position);
      meter.resultWrites += ids.length;
      throw new Pending('source_pending');
    }
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
  async function advance(job: Job, client: PoolClient, context: PublicFilterConsumerContext, meter: Meter) {
    if (job.fenced_pass) await held(job, context, meter);
    if (job.phase === 'reconciled' || job.phase === 'fencing' || job.phase === 'intent' || job.phase === 'active')
      return;
    if (job.phase === 'subject' || job.phase === 'account') {
      if (job.home === 4096) {
        job.phase = 'engine';
        job.home = 0;
        await save(client, job, meter);
        return;
      }
      const before = await head(job.home);
      await remember(job, before, client);
      const after = cursor(job);
      let ids: readonly string[],
        next: SubjectSourceKeyCursor | null,
        complete: boolean,
        keys: DiscoveryKey[] | undefined;
      if (job.phase === 'subject') {
        const page = await sourceKeys.read({ partition: job.home, after, inputLimit: PAGE }, context);
        add(meter, page.cost);
        if (page.status !== 'eligible') {
          job.after_route = null;
          job.after_id = null;
          await client.query('DELETE FROM search.generation_publication_home WHERE partition_no=$1 AND job=$2', [
            job.home,
            job.job,
          ]);
          await save(client, job, meter);
          throw new Pending(
            page.status === 'unavailable' && page.reason === 'deadline' ? 'deadline' : 'source_pending',
          );
        }
        if (page.partition !== job.home || page.epoch !== before.epoch || page.position !== BigInt(before.position))
          throw new Pending('source_pending');
        ids = page.ids;
        next = page.after;
        complete = page.complete;

        keys = job.family === 'discovery' ? await keysFor(job.home, ids) : undefined;
        if (job.family === 'discovery') ids = keys!.map(({ id }) => id);
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
      await reconcile(job, job.home, ids, keys, BigInt(before.position), context, meter);
      if (!same(before, await head(job.home))) throw new Pending('source_pending');
      job.after_route = next?.route ?? null;
      job.after_id = next?.id ?? null;
      if (complete) {
        job.after_route = null;
        job.after_id = null;
        if (job.phase === 'subject' && job.family === 'discovery') job.phase = 'account';
        else {
          job.phase = 'subject';
          job.home++;
        }
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
      let response: { status: number; body: unknown };
      try {
        response = await engine<unknown>(context, meter, 'POST', '/_search', {
          size: 0,
          track_total_hits: false,
          pit: { id: job.pit, keep_alive: '5m' },
          aggs: {
            keys: {
              composite: { size: PAGE, sources, ...(job.engine_after ? { after: job.engine_after } : {}) },
              aggs: { row: { top_hits: { size: 1, version: true } } },
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
      if (!Array.isArray(page.buckets) || page.buckets.length > PAGE) throw new Pending('source_pending');
      // Composite after_key is native enumeration state. No returned hit length or total certifies exhaustion.
      const next = page.after_key;
      if (next !== undefined && (!object(next) || same(next, job.engine_after))) throw new Pending('source_pending');
      const grouped = new Map<string, { partition: number; ids: string[]; keys: DiscoveryUnionKey[] }>();
      for (const bucket of page.buckets) {
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
        const group = grouped.get(groupKey) ?? { partition, ids: [], keys: [] };
        group.ids.push(id);
        if (key) group.keys.push(key);
        grouped.set(groupKey, group);
      }
      meter.inputKeys += page.buckets.length;
      meter.engineIteratorSteps++;
      for (const group of grouped.values()) {
        const before = await head(group.partition);
        await remember(job, before, client);
        const discoveryKeys =
          job.family === 'discovery'
            ? group.keys.filter((key): key is DiscoveryKey => key.owner === 'semantic' || key.owner === 'accounts')
            : undefined;
        if (discoveryKeys && discoveryKeys.length !== group.keys.length) throw new Pending('source_pending');
        await reconcile(job, group.partition, group.ids, discoveryKeys, BigInt(before.position), context, meter);
        if (!same(before, await head(group.partition))) throw new Pending('source_pending');
      }
      job.engine_after = (next as Record<string, unknown> | undefined) ?? null;
      if (next === undefined) {
        await discardPit(job, context, meter);
        job.phase = 'validate';
        job.home = 0;
      }
    } else {
      const rows = await client.query<Home>(
        `SELECT partition_no AS partition,epoch,position::text,account_revision::text,claim_revision::text
        FROM search.generation_publication_home WHERE partition_no >= $1 AND partition_no < $2 AND job=$3 AND pass=$4 ORDER BY partition_no`,
        [job.home, Math.min(4096, job.home + PAGE), job.job, job.pass],
      );
      if (rows.rows.length !== Math.min(PAGE, 4096 - job.home)) throw new Pending('routing_incomplete');
      for (const row of rows.rows) {
        meter.inputKeys++;
        if (!same(row, await head(row.partition))) {
          await client.query('DELETE FROM search.generation_publication_home WHERE partition_no=$1 AND job=$2', [
            row.partition,
            job.job,
          ]);
          job.phase = 'subject';
          job.home = row.partition;
          job.after_id = null;
          job.after_route = null;
          await save(client, job, meter);
          throw new Pending('source_pending');
        }
      }
      job.home += rows.rows.length;
      if (job.home === 4096) job.phase = 'reconciled';
    }
    await native(job.consumer, context);
    await save(client, job, meter);
  }
  function alias(job: Job) {
    return (job.family === 'subjects' ? subjectAlias : discoveryAlias)(job.prefix);
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
  }
  async function release(job: Job, context: PublicFilterConsumerContext, meter: Meter) {
    if (!job.fence) return;
    const result = await writerGuard.releasePublication(fence(job), context);
    add(meter, result.cost);
    if (result.status !== 'released') throw new Pending(result.reason);
    job.fence = null;
    job.fenced_pass = false;
  }
  async function restart(job: Job, client: PoolClient, context: PublicFilterConsumerContext, meter: Meter) {
    // Roll back only our exact alias intent, under the still-held native admission/copy fence.
    if (job.phase === 'intent') {
      // Source may have changed after the alias request. Recover admission custody independently
      // before restoring this exact intent; a publication-completion verdict cannot authorize abort.
      const retained = await writerGuard.fencePublication(reference(job), context);
      add(meter, retained.cost);
      if (retained.status !== 'fenced' || !same(retained.fence, fence(job)))
        throw new Pending('source_pending');
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
        populationDefinition(resolved.definition);
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
        const id = randomUUID();
        const result = await pool.query<Job>(
          `INSERT INTO search.generation_publication
          (job,physical_target,consumer,prefix,generation,family,native_incarnation,kinds,source_home,binding,activated_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
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
          ],
        );
        const job =
          result.rows[0] ??
          (
            await pool.query<Job>(
              'SELECT * FROM search.generation_publication WHERE partition_no=0 AND physical_target=$1 AND consumer=$2',
              [input.physicalTarget, input],
            )
          ).rows[0];
        if (!job || !same(job.consumer, input)) throw new Pending('incarnation_changed');
        await adopt(job, context, meter);
        return { status: 'preparing' as const, job: reference(job), cost: meter };
      });
    },
    step(input, context) {
      return run(context, (meter) =>
        locked(input, context, meter, async (job, client) => {
          try {
            await advance(job, client, context, meter);
          } catch (error) {
            if (
              error instanceof Pending &&
              error.reason === 'source_pending' &&
              job.fence &&
              job.phase !== 'intent' &&
              job.phase !== 'active'
            )
              await restart(job, client, context, meter);
            else if (error instanceof Pending && error.reason === 'source_pending') await save(client, job, meter);
            throw error;
          }
          return {
            status:
              job.phase === 'reconciled' || job.phase === 'active' ? ('reconciled' as const) : ('progress' as const),
            job: reference(job),
            cost: meter,
          };
        }),
      );
    },
    activate(input, context) {
      return run(context, (meter) =>
        locked(input, context, meter, async (job, client) => {
          const preparing = () => ({ status: 'preparing' as const, job: reference(job), cost: meter });
          if (job.phase === 'active') {
            if ((await aliasTarget(job, context, meter)) !== job.physical_target) throw new Pending('source_pending');
            await release(job, context, meter);
            await save(client, job, meter);
            return { status: 'activated' as const, consumer: job.consumer, cost: meter };
          }
          if (job.phase !== 'reconciled' && job.phase !== 'fencing' && job.phase !== 'intent') return preparing();
          guardAvailable();
          if (!job.fence) {
            if (!(await completeSource(job, client, context, meter))) return preparing();
            await installFence(job, client, context, meter);
          }
          try {
            if (!job.fenced_pass) {
              const result = await writerGuard.drainPublication(fence(job), context);
              add(meter, result.cost);
              if ('reason' in result) throw new Pending(result.reason);
              if (!same(result.fence, fence(job))) throw new Pending('incarnation_changed');
              if (result.status === 'draining') return preparing();
              await held(job, context, meter);
              // Revisit the real finite key population under the continuously held writer/copy barrier.
              job.fenced_pass = true;
              job.pass = (BigInt(job.pass) + 1n).toString();
              job.phase = 'subject';
              job.home = 0;
              job.after_id = null;
              job.after_route = null;
              await save(client, job, meter);
              return preparing();
            }
            await held(job, context, meter);
            const queried = await adopt(job, context, meter, true);
            if (!queried) throw new Pending('source_pending');
            if (!job.observation) {
              job.observation = queried.snapshot.observation;
              await save(client, job, meter);
            }
            if (job.phase !== 'intent') {
              job.previous_target = await aliasTarget(job, context, meter);
              job.previous_uuid = job.previous_target ? await discoveryIndexUuid(search, job.previous_target) : null;
              job.activated_at = config.clock().toISOString();
              job.phase = 'intent';
              await save(client, job, meter);
            }
            if (job.family === 'subjects')
              await publishSubjectActivationMetadata(search, job.physical_target, job.activated_at);
            const before = await aliasTarget(job, context, meter);
            if (before !== job.physical_target && before !== job.previous_target) throw new Pending('source_pending');
            if (before !== job.physical_target) {
              await held(job, context, meter);
              await adopt(job, context, meter, true);
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
            }
            await held(job, context, meter);
            await adopt(job, context, meter, true);
            if ((await aliasTarget(job, context, meter)) !== job.physical_target) throw new Pending('source_pending');
            // Native readback precedes metadata. Lost replies replay the retained intent under the same fence.
            if (job.family === 'discovery') {
              await client.query('BEGIN');
              try {
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
