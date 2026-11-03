import { publicFilterCatalogue } from './discovery-catalogue.ts';
import { verifyPublicFilterRepairSourcePage, PublicFilterRepairSourceError } from './public-filter-custody-source.ts';
import {
  joinNativePublicFilterRepair,
  readNativePublicFilterRepairStart,
} from '../semantic/public-filter-source-binding.ts';
import repairSave from './public-filter-custody-repair-save.sql';
import repairCurrent from './public-filter-custody-repair-current.sql';
import repairEffectSave from './public-filter-custody-repair-effect-save.sql';
import repairEffectSql from './public-filter-custody-repair-effect.sql';
import repairPageSave from './public-filter-custody-repair-page-save.sql';
import repairPageSql from './public-filter-custody-repair-page.sql';
import { isDeepStrictEqual } from 'node:util';
import { installPublicFilterCoveragePage, withPublicFilterCoverageStart } from './public-filter-coverage-page.ts';
import { releaseDigest } from '@rezics/definitions';
import { admitFilter, parseFilter, walkFilter } from '@rezics/filter';
import { routeOf } from '../route/route.ts';
import type {
  PublicFilterConsumer,
  PublicFilterDependencyKey,
  PublicFilterProjectionMeaning,
} from '../semantic/public-filter-source-contract.ts';
import type { PublicFilterConsumerCaptureInput } from './public-filter-consumer-contract.ts';
import { compileFilter } from './filter.ts';
import { compileText, TEXT_LIMITS, type TextNode } from './text.ts';
import { assertCompleteSearch } from './complete-search.ts';
import { subjectIndexName, discoveryIndexName } from './indices.ts';
import { SearchUnavailableError, type OpenSearch } from './opensearch.ts';
import { admitSearchPayload, requireSearchOverflow } from './query-payload.ts';
import { SCOPE_HIT_TEMPLATE, type SearchPlan, type SearchResult } from './query.ts';
import { admitHitPayload } from './query-payload.ts';
import { validateScopeOrderedHit } from './scope-ordered.ts';
import { bulkLines, type IndexAction, type SearchDocument } from './document.ts';
import { prepareBoundedSortKeys } from './bounded-sort-keys.ts';
import { subjectPartition } from './source.ts';
import { writeIndexActions } from './write-actions.ts';
import type { PublicFilterConsumerContext, PublicFilterQueriedObservation } from './public-filter-consumer-contract.ts';

/** Internal compilation only. Native Source resolution, custody and disclosure remain mandatory. */
export type CompiledPublicFilterConsumerCapture = Readonly<{
  capture: PublicFilterConsumerCaptureInput;
  meaning: PublicFilterProjectionMeaning;
  filterLeaves: ReturnType<typeof compileFilter>['leaves'];
  textLeaves: ReturnType<typeof compileText>['leaves'];
  dependencyKeys: readonly PublicFilterDependencyKey[];
}>;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Check the parsed node shape; syntax/meaning continue to belong to the existing text compiler. */
function validateText(text: TextNode): void {
  const pending: unknown[] = [text];
  const seen = new Set<object>();
  let leaves = 0;
  let bytes = 0;
  while (pending.length) {
    const node = pending.pop();
    if (!record(node) || seen.has(node)) throw new TypeError('Capture text must be a parsed tree');
    seen.add(node);
    // A parsed query has at most one NOT and a bounded number of Boolean nodes per leaf.
    if (seen.size > 4 * TEXT_LIMITS.leaves) throw new RangeError('Capture text exceeds parsed query limits');
    if (node.kind === 'term' || node.kind === 'phrase') {
      if (typeof node.value !== 'string' || !node.value || !node.value.isWellFormed())
        throw new TypeError('Capture text must contain parsed text leaves');
      bytes += Buffer.byteLength(node.value);
      if (++leaves > TEXT_LIMITS.leaves || bytes > TEXT_LIMITS.bytes)
        throw new RangeError('Capture text exceeds parsed query limits');
    } else if (node.kind === 'not') {
      pending.push(node.child);
    } else if (node.kind === 'and' || node.kind === 'or') {
      if (!Array.isArray(node.children) || !node.children.length || node.children.length > TEXT_LIMITS.leaves)
        throw new TypeError('Capture text must contain parsed Boolean children');
      pending.push(...node.children);
    } else throw new TypeError('Capture text must be parsed text');
  }
}

function validateOrder(capture: PublicFilterConsumerCaptureInput): void {
  if (!['id', 'name', 'relevance', 'collections', 'rating'].includes(capture.sort))
    throw new TypeError('Unknown capture order');
  if (!Number.isInteger(capture.size) || capture.size < 1 || capture.size > 100)
    throw new RangeError('Capture size must be an integer from 1 to 100');
  if (
    capture.pageSize !== undefined &&
    (!Number.isInteger(capture.pageSize) || capture.pageSize < 1 || capture.pageSize > 100)
  )
    throw new RangeError('Capture pageSize must be an integer from 1 to 100');
  if (capture.generation !== undefined && (!Number.isSafeInteger(capture.generation) || capture.generation < 1))
    throw new TypeError('Invalid capture generation');
  if (capture.sort !== 'rating' && (capture.rating !== undefined || capture.ratingPhase !== undefined))
    throw new TypeError('Rating metadata requires rating order');
  if (capture.ratingPhase !== undefined && capture.ratingPhase !== 'scored' && capture.ratingPhase !== 'unscored')
    throw new TypeError('Invalid capture rating phase');
  if (capture.sort === 'rating' && capture.rating === undefined)
    throw new TypeError('Rating capture requires native rating metadata');
  if (capture.after === undefined) return;
  const scored = capture.ratingPhase === 'scored';
  const length =
    capture.sort === 'id' ? 1 : capture.sort === 'collections' || (capture.sort === 'rating' && scored) ? 3 : 2;
  if (
    !Array.isArray(capture.after) ||
    capture.after.length !== length ||
    (capture.sort === 'rating' && capture.ratingPhase === undefined) ||
    !capture.after.every(
      (value) => value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)),
    )
  )
    throw new TypeError('Invalid capture keyset');
  const tuple = capture.after;
  const id = tuple[tuple.length - 1];
  if (typeof id !== 'string' || id.length !== 36 || routeOf(id) === null)
    throw new TypeError('Invalid capture keyset id');
  const name = tuple[capture.sort === 'collections' || (capture.sort === 'rating' && scored) ? 1 : 0];
  if (
    (capture.sort === 'name' || capture.sort === 'collections' || capture.sort === 'rating') &&
    name !== null &&
    (typeof name !== 'string' || name.length > 512 || !name.isWellFormed())
  )
    throw new TypeError('Invalid capture keyset name');
  const score = tuple[0];
  if (
    (capture.sort === 'relevance' || capture.sort === 'collections' || (capture.sort === 'rating' && scored)) &&
    (typeof score !== 'number' ||
      !Number.isFinite(score) ||
      (capture.sort === 'collections' && (!Number.isSafeInteger(score) || score < 0)) ||
      (capture.sort === 'rating' && (score < 0 || score > 10)))
  )
    throw new TypeError('Invalid capture keyset score');
}

/**
 * Run before ANY engine, registration or Source I/O. Capture accepts the already expanded shared
 * tree, then readmits it under the exact accepted release with saved expansion disabled.
 * Optional DSL is equality evidence and is never used as the retained semantic input.
 */
export function compilePublicFilterConsumerCapture(
  input: PublicFilterConsumerCaptureInput,
  acceptedMeaning: PublicFilterProjectionMeaning,
): CompiledPublicFilterConsumerCapture {
  if (!record(input) || !Object.hasOwn(input, 'filterDocument') || !Object.hasOwn(input, 'text'))
    throw new TypeError('Capture requires explicit filterDocument and parsed text');
  const copied = structuredClone(input);
  const meaning = structuredClone(acceptedMeaning);
  if (meaning.digest !== releaseDigest(meaning.release) || !Object.hasOwn(meaning.release.types, meaning.type))
    throw new TypeError('Capture requires an exact accepted release and type');
  validateOrder(copied);

  let filterDocument;
  if (copied.filterDocument !== undefined) {
    const parsed = parseFilter(copied.filterDocument);
    for (const node of walkFilter(parsed)) {
      if ('owner' in node) throw new TypeError('Public capture cannot contain owner predicates');
      if ('saved' in node) throw new TypeError('Public capture requires expanded saved filters');
    }
    filterDocument = admitFilter(parsed, meaning.release, { saved: false });
  }
  if (copied.text !== undefined) validateText(copied.text);
  const filter =
    filterDocument === undefined ? undefined : compileFilter(filterDocument, { prefix: 'f', relationOverflow: true });
  const text = copied.text === undefined ? undefined : compileText(copied.text, { field: 'search_text', prefix: 't' });
  const properties = [
    ...new Set(filter?.leaves.flatMap((leaf) => (leaf.facet === 'statement' ? [leaf.property] : []))),
  ];
  const dependencyProperties = [
    ...new Set(
      filter?.leaves.flatMap((leaf) =>
        leaf.facet === 'statement'
          ? [leaf.property, ...(leaf.qualifiers?.map((qualifier) => qualifier.property) ?? [])]
          : [],
      ),
    ),
  ];
  const derived = {
    query: text?.query,
    filter: filter?.query,
    boost: text?.leaves
      .filter((leaf) => !leaf.negated)
      .map((leaf) => leaf.value)
      .join(' '),
    overflowProperties: properties.length ? properties : undefined,
  };
  for (const key of ['query', 'filter', 'boost'] as const) {
    if (copied[key] !== undefined && !isDeepStrictEqual(copied[key], derived[key]))
      throw new TypeError(`Capture ${key} does not match shared semantic input`);
  }
  const overflowProperties =
    copied.overflowProperties !== undefined ? copied.overflowProperties : derived.overflowProperties;
  if (copied.overflowProperties !== undefined) {
    if (
      !Array.isArray(copied.overflowProperties) ||
      copied.overflowProperties.some((property) => typeof property !== 'string') ||
      (derived.overflowProperties ?? []).some((property) => !copied.overflowProperties!.includes(property))
    )
      throw new TypeError('Capture overflowProperties does not match shared semantic input');
  }
  const capture: PublicFilterConsumerCaptureInput = {
    filterDocument,
    text: copied.text,
    sort: copied.sort,
    size: copied.size,
    ...(copied.pageSize === undefined ? {} : { pageSize: copied.pageSize }),
    ...(derived.query === undefined ? {} : { query: derived.query }),
    ...(derived.filter === undefined ? {} : { filter: derived.filter }),
    ...(derived.boost === undefined ? {} : { boost: derived.boost }),
    ...(overflowProperties === undefined ? {} : { overflowProperties }),
    ...(copied.after === undefined ? {} : { after: copied.after }),
    ...(copied.generation === undefined ? {} : { generation: copied.generation }),
    ...(copied.rating === undefined ? {} : { rating: copied.rating }),
    ...(copied.ratingPhase === undefined ? {} : { ratingPhase: copied.ratingPhase }),
  };

  // Containing source properties preserve every qualifier/range/unit association in compiler leaves.
  // Functional keys name the existing sort declarations, including all text fields and tie breakers.
  const orders = new Set<PublicFilterConsumerCaptureInput['sort']>(['id', capture.sort]);
  if (text !== undefined) {
    orders.add('relevance');
    orders.add('name');
  }
  if (capture.sort === 'collections' || capture.sort === 'rating') orders.add('name');
  const coverageProperties = [...new Set([...dependencyProperties, ...(overflowProperties ?? [])])];
  const dependencyKeys: PublicFilterDependencyKey[] = [
    { kind: 'type' },
    ...coverageProperties.map((property): PublicFilterDependencyKey => ({ kind: 'property', property })),
    ...[...orders].map((order): PublicFilterDependencyKey => ({ kind: 'order', order })),
  ];
  return freeze({
    capture,
    meaning,
    filterLeaves: filter?.leaves ?? [],
    textLeaves: text?.leaves ?? [],
    dependencyKeys,
  });
}

function targetParts(physicalTarget: string): { prefix: string; generation: number } {
  const match = /^([a-z0-9][a-z0-9-]{0,47})subjects-g([1-9][0-9]*)$/.exec(physicalTarget);
  if (!match || match[0] !== physicalTarget) throw new TypeError('Consumer requires one physical subject index');
  const prefix = match[1]!;
  const generation = Number(match[2]);
  if (subjectIndexName(prefix, generation) !== physicalTarget) throw new TypeError('Invalid physical subject index');
  return { prefix, generation };
}

function remaining(context: PublicFilterConsumerContext): number {
  const milliseconds = context.deadline - Date.now();
  if (!Number.isFinite(milliseconds) || milliseconds <= 0)
    throw new SearchUnavailableError('Consumer deadline elapsed');
  return milliseconds;
}

/** Native metadata only; registering this UUID and validating population belong to custody/Source. */
export async function readPublicFilterConsumerIncarnation(
  search: OpenSearch,
  physicalTarget: string,
  context: PublicFilterConsumerContext,
): Promise<string> {
  const mixed = /^([a-z0-9][a-z0-9-]{0,47})discovery-g([1-9][0-9]*)$/.exec(physicalTarget);
  if (mixed) {
    if (discoveryIndexName(mixed[1]!, Number(mixed[2])) !== physicalTarget)
      throw new TypeError('Invalid physical discovery index');
  } else targetParts(physicalTarget);
  const { status, body } = await search.request<unknown>('GET', `/${physicalTarget}/_settings`, undefined, {
    timeoutMs: remaining(context),
  });
  const malformed = () => new SearchUnavailableError('Native consumer index settings are missing or malformed');
  if (status !== 200 || !record(body) || Object.keys(body).length !== 1 || !Object.hasOwn(body, physicalTarget))
    throw malformed();
  const target = body[physicalTarget];
  if (!record(target) || !record(target.settings) || !record(target.settings.index)) throw malformed();
  const uuid = target.settings.index.uuid;
  if (typeof uuid !== 'string' || !uuid.length || uuid === '_na_') throw malformed();
  return uuid;
}

function iteratorSteps(body: unknown): number {
  const malformed = () => new SearchUnavailableError('Native consumer query profile is missing or malformed');
  if (!record(body) || !record(body.profile) || !Array.isArray(body.profile.shards)) throw malformed();
  // Completion is checked before profiling. Every executed shard must still have cost evidence;
  // skipped shards may have no query profile, but duplicates cannot stand in for another shard.
  if (
    !record(body._shards) ||
    typeof body._shards.total !== 'number' ||
    typeof body._shards.skipped !== 'number' ||
    body.profile.shards.length < body._shards.total - body._shards.skipped
  )
    throw malformed();
  const shardIds = new Set<string>();
  let count = 0;
  for (const shard of body.profile.shards) {
    if (
      !record(shard) ||
      typeof shard.id !== 'string' ||
      !shard.id.length ||
      shardIds.has(shard.id) ||
      !Array.isArray(shard.searches) ||
      !shard.searches.length
    )
      throw malformed();
    shardIds.add(shard.id);
    for (const search of shard.searches) {
      if (!record(search) || !Array.isArray(search.query) || !search.query.length) throw malformed();
      const pending: unknown[] = [...search.query];
      while (pending.length) {
        const node = pending.pop();
        if (!record(node) || !record(node.breakdown)) throw malformed();
        for (const field of ['next_doc_count', 'advance_count']) {
          const value = node.breakdown[field];
          if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw malformed();
          count += value;
          if (!Number.isSafeInteger(count)) throw malformed();
        }
        if (node.children !== undefined) {
          if (!Array.isArray(node.children)) throw malformed();
          pending.push(...node.children);
        }
      }
    }
  }
  return count;
}

/** Shared native profiler for ordered preparation's count-free PIT keepalive. */
export const measurePublicFilterIteratorSteps = iteratorSteps;

type OrdinaryPlan = SearchPlan & { sort: 'relevance' | 'name' | 'id' | 'collections' };
type NativePitPayload = {
  pit_id: string;
  hits: {
    total: { value: number; relation: 'eq' | 'gte' };
    hits: {
      _id: string;
      _index: string;
      _source: { partition: number; security_revision: number };
      matched_queries?: string[];
      sort: (string | number | null)[];
    }[];
  };
};

function admitPitPayload(body: unknown, plan: OrdinaryPlan, physicalTarget: string): asserts body is NativePitPayload {
  const { prefix, generation } = targetParts(physicalTarget);
  assertCompleteSearch(body);
  admitSearchPayload(body, { ...plan, generation }, prefix);
  if (typeof body.pit_id !== 'string' || !body.pit_id.length)
    throw new SearchUnavailableError('Native consumer PIT response has no locator');
  // The shared validator checks generation-shaped names; PIT membership requires exact physical identity.
  const hits = record(body.hits) ? body.hits.hits : undefined;
  if (!Array.isArray(hits) || hits.some((hit) => !record(hit) || hit._index !== physicalTarget))
    throw new SearchUnavailableError('Native consumer PIT returned another physical index');
}

/**
 * Internal ordinary-sort engine execution, after custody has resolved the exact retained tuple.
 * This returns unapproved native candidates and a PROPOSED successor locator. The caller must
 * persist the exact execution/own rows, validate any renewal through custody and revalidate Source.
 * Prepared and phased rating execution require their retained native custody before composition.
 */
export async function queryPublicFilterConsumerPit(
  search: OpenSearch,
  retainedQueried: PublicFilterQueriedObservation,
  retainedPlan: OrdinaryPlan,
  context: PublicFilterConsumerContext,
  retainPit?: (pit: string) => Promise<void>,
): Promise<Readonly<{ result: SearchResult; successorPit: string; engineIteratorSteps: number }>> {
  const queried = structuredClone(retainedQueried);
  const plan = structuredClone(retainedPlan);
  if (queried.snapshot.kind !== 'pit') throw new TypeError('PIT execution requires a retained PIT');
  const { generation } = targetParts(queried.consumer.physicalTarget);
  if (plan.generation !== undefined && plan.generation !== generation)
    throw new TypeError('Retained plan generation does not match its physical target');
  const sort =
    plan.sort === 'relevance'
      ? [{ _score: 'desc' }, { id: 'asc' }]
      : plan.sort === 'name'
        ? [{ name_sort: 'asc' }, { id: 'asc' }]
        : plan.sort === 'collections'
          ? [{ public_collection_count: { order: 'desc', missing: 0 } }, { name_sort: 'asc' }, { id: 'asc' }]
          : [{ id: 'asc' }];
  const hasOverflow = (plan.overflowProperties?.length ?? 0) > 0;
  const { status, body } = await search.request<unknown>(
    'POST',
    '/_search',
    {
      // Keep the existing subjects-search-v2 semantics without changing its immutable template.
      query: {
        bool: {
          must: plan.query ?? { match_all: {} },
          ...(plan.filter === undefined ? {} : { filter: plan.filter }),
          ...(plan.boost === undefined
            ? {}
            : {
                should: [
                  { term: { 'names.exact': { value: plan.boost, boost: 10 } } },
                  { match_phrase: { names: { query: plan.boost, boost: 3 } } },
                ],
              }),
        },
      },
      pit: { id: queried.snapshot.pit },
      size: plan.size,
      sort,
      ...(plan.after === undefined ? {} : { search_after: plan.after }),
      track_total_hits: 10_000,
      profile: true,
      _source: ['partition', 'security_revision'],
      ...(hasOverflow
        ? { aggs: { overflow: { filter: { terms: { relation_facet_overflow: plan.overflowProperties } } } } }
        : {}),
    },
    { timeoutMs: remaining(context), query: { allow_partial_search_results: false } },
  );
  if (record(body) && typeof body.pit_id === 'string' && retainPit) await retainPit(body.pit_id);
  if (status !== 200) throw new SearchUnavailableError('Native consumer PIT query did not complete');
  admitPitPayload(body, plan, queried.consumer.physicalTarget);
  const result: SearchResult = {
    ...(plan.generation === undefined ? {} : { generation: plan.generation }),
    hits: body.hits.hits.map((hit) => ({
      id: hit._id,
      index: hit._index,
      partition: hit._source.partition,
      securityRevision: hit._source.security_revision,
      matched: hit.matched_queries ?? [],
      sort: hit.sort,
    })),
    total: {
      value: body.hits.total.value,
      relation: body.hits.total.relation === 'eq' ? 'exact' : 'lower_bound',
    },
    ...(hasOverflow ? { overflow: requireSearchOverflow(body) } : {}),
  };
  return { result, successorPit: body.pit_id, engineIteratorSteps: iteratorSteps(body) };
}

/** Count-free, keyed native preparation on the same retained PIT and stored template.
 * The keys restrict work only; the enclosing Source definition still covers the WHOLE predicate/order.
 */
export async function queryScopeOrderedKeys(
  search: OpenSearch,
  queried: PublicFilterQueriedObservation,
  plan: SearchPlan & { sort: 'name' | 'collections' },
  keys: readonly string[],
  context: PublicFilterConsumerContext,
  retainPit: (pit: string) => Promise<void>,
): Promise<{ hits: SearchResult['hits']; engineIteratorSteps: number }> {
  if (queried.snapshot.kind !== 'pit' || keys.length < 1 || keys.length > 100 || new Set(keys).size !== keys.length)
    throw new RangeError('Ordered preparation needs a bounded native input window');
  for (const key of keys) subjectPartition(key);
  const { prefix, generation } = targetParts(queried.consumer.physicalTarget);
  if (plan.generation !== generation) throw new TypeError('Ordered preparation generation changed');
  const sort =
    plan.sort === 'name'
      ? [{ name_sort: { order: 'asc', missing: '_last' } }, { id: 'asc' }]
      : [
          { public_collection_count: { order: 'desc', missing: 0 } },
          { name_sort: { order: 'asc', missing: '_last' } },
          { id: 'asc' },
        ];
  const { status, body } = await search.request<unknown>(
    'POST',
    '/_search/template',
    {
      id: `${prefix}${SCOPE_HIT_TEMPLATE}`,
      params: {
        pit: { id: queried.snapshot.pit, keep_alive: '5m' },
        query: plan.query,
        has_query: plan.query !== undefined,
        filter: { bool: { filter: [{ ids: { values: keys } }, ...(plan.filter ? [plan.filter] : [])] } },
        has_filter: true,
        has_boost: false,
        sort,
        size: keys.length,
        has_after: false,
        has_overflow: !!plan.overflowProperties?.length,
        overflow_properties: plan.overflowProperties,
      },
    },
    { timeoutMs: remaining(context), query: { allow_partial_search_results: false } },
  );
  if (record(body) && typeof body.pit_id === 'string') await retainPit(body.pit_id);
  if (status !== 200) throw new SearchUnavailableError('Ordered Scope native query did not complete');
  assertCompleteSearch(body);
  const { after: _after, ...keyedPlan } = plan;
  admitHitPayload(body, { ...keyedPlan, size: keys.length }, prefix);
  if (!record(body.hits) || !Array.isArray(body.hits.hits) || typeof body.pit_id !== 'string' || !body.pit_id)
    throw new SearchUnavailableError('Ordered Scope native reply has no PIT');
  if (plan.overflowProperties?.length && requireSearchOverflow(body))
    throw new SearchUnavailableError('Ordered Scope native predicate needs complete overflow preparation');
  const hits = body.hits.hits.map((value: unknown) => {
    if (!record(value) || value._index !== queried.consumer.physicalTarget || !keys.includes(value._id as string))
      throw new SearchUnavailableError('Ordered Scope returned another native input or index');
    const source = value._source as { partition: number; security_revision: number };
    return {
      id: value._id as string,
      index: value._index as string,
      partition: source.partition,
      securityRevision: source.security_revision,
      matched: (value.matched_queries ?? []) as string[],
      sort: value.sort as (string | number | null)[],
    };
  });
  for (const hit of hits) validateScopeOrderedHit(plan.sort, hit, queried.consumer.physicalTarget);
  return { hits, engineIteratorSteps: iteratorSteps(body) };
}

/**
 * Internal sink stage only. The enclosing retained repair job supplies actual Source projections
 * and owns their dependency/frontier state; this function neither reads nor advances an ACK.
 * On ambiguity/conflict the job must recover from native/source evidence, never infer a winner.
 */
export async function applyPublicFilterConsumerActions(
  search: OpenSearch,
  retainedConsumer: PublicFilterConsumer,
  retainedActions: readonly IndexAction<SearchDocument>[],
  requestContext: PublicFilterConsumerContext,
): Promise<void> {
  // Copy before the first await, including document bodies and external versions.
  const consumer = structuredClone(retainedConsumer);
  const actions = structuredClone(retainedActions);
  const context = { deadline: requestContext.deadline };
  targetParts(consumer.physicalTarget);
  if (!consumer.incarnation) throw new TypeError('Repair requires its retained physical incarnation');
  if (!Array.isArray(actions) || actions.length < 1 || actions.length > 1000)
    throw new RangeError('Repair writes require from 1 to 1000 actions');
  const ids = new Set<string>();
  for (const action of actions) {
    if (
      !record(action) ||
      (action.op !== 'index' && action.op !== 'delete') ||
      typeof action.id !== 'string' ||
      ids.has(action.id) ||
      typeof action.version !== 'bigint' ||
      action.version < 1n ||
      action.version > BigInt(Number.MAX_SAFE_INTEGER)
    )
      throw new TypeError('Repair requires unique routable actions with positive native versions');
    const partition = subjectPartition(action.id);
    if (
      action.op === 'index' &&
      (!record(action.document) || action.document.id !== action.id || action.document.partition !== partition)
    )
      throw new TypeError('Repair document does not match its native key');
    ids.add(action.id);
  }
  // Enforce the sink step's byte ceiling before any metadata, normalization or write I/O.
  const admitBytes = (batch: readonly IndexAction<SearchDocument>[]) => {
    const bytes = bulkLines(consumer.physicalTarget, batch).reduce<number>((total, line) => {
      const serialized = JSON.stringify(line);
      if (serialized === undefined) throw new TypeError('Repair bulk must contain native JSON');
      return total + Buffer.byteLength(serialized) + 1;
    }, 0);
    if (bytes > 4 * 1024 * 1024) throw new RangeError('Repair bulk exceeds 4 MiB');
  };
  admitBytes(actions);

  const target = consumer.physicalTarget;
  if ((await readPublicFilterConsumerIncarnation(search, target, context)) !== consumer.incarnation)
    throw new SearchUnavailableError('Repair physical incarnation changed');
  // Existing name-key preparation and writer are shared with the indexer, not reimplemented.
  // Recompute the actual remaining deadline for each normalization and native bulk request.
  const bounded: OpenSearch = {
    request(method, path, body, options) {
      return search.request(method, path, body, { ...options, timeoutMs: remaining(context) });
    },
    bulk(lines, options) {
      return search.bulk(lines, { ...options, timeoutMs: remaining(context) });
    },
  };
  const prepared = await prepareBoundedSortKeys(bounded, target, actions);
  admitBytes(prepared);
  await writeIndexActions(bounded, target, prepared, { versionConflict: 'reject' });
  // A delete/create race must fail this attempt even if the name and every bulk item look valid.
  if ((await readPublicFilterConsumerIncarnation(search, target, context)) !== consumer.incarnation)
    throw new SearchUnavailableError('Repair physical incarnation changed');
}

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type {
  PublicFilterCost,
  PrivacyReductionStart,
  PublicFilterProjectionRecord,
} from '../semantic/public-filter-source-contract.ts';
import { advanceNativePublicFilterPreparation } from '../semantic/public-filter-source-binding.ts';
import type {
  PublicFilterSourceBinding,
  PublicFilterSourceBootstrapBinding,
  PublicSourceBootstrap,
  PublicSourceRepair,
} from '../semantic/public-filter-source-binding.ts';
import type {
  PublicCanonicalCaptureInput,
  PublicFilterConsumerOperationsFactory,
  PublicDiscoveryConsumerOperations,
  PublicFilterConsumerQuery,
  PublicFilterConsumerCapture,
  PublicFilterConsumerRefill,
  PublicFilterConsumerUnavailable,
  PublicFilterConsumerJob,
  PublicFilterConsumerStatus,
} from './public-filter-consumer-contract.ts';
import type {
  CustodyRegistration,
  CustodyUse,
  CustodyCost,
  CustodyExecution,
} from './public-filter-custody-contract.ts';
import {
  createPublicFilterCustody,
  encodePublicFilterNativeState as encodeNative,
  decodePublicFilterNativeState as decodeNative,
  readPublicFilterRepairSettlement,
  withPublicFilterRepairAllowance,
} from './public-filter-custody.ts';
import type {
  RetainedRepairSettlement,
  RetainedRepairPage,
  RetainedSourceRepair,
} from './public-filter-custody-contract.ts';
import { publicFilterSourceOrigin } from '../semantic/public-filter-source.ts';
import { createRatedSubjectSource } from './rated-source.ts';
import { subjectListingSource } from '../library/listing-counts.ts';
import {
  createSearchWriterGuard,
  createDiscoveryRepairWriter,
  repairWriterPosition,
  type PublicFilterRepairWriterReceipt,
} from './writer-guard.ts';
import { createDiscoveryProjection, nativeDiscoveryRegistry } from './account-discovery.ts';
import { discoveryConsumer } from './generations.ts';
import { subjectConsumer } from './runner.ts';
import { validatePublicSuggestionInput } from './public-suggestion-input.ts';
import { compilePublicSuggestion } from './public-suggestion-input.ts';
import { type SubjectDocument } from './document.ts';
import type { DiscoveryConsumerQuery, DiscoveryEngineHit } from './discovery.ts';
import { compileDiscoveryConsumerCapture } from './discovery.ts';
import { compileDiscoveryCapture } from './discovery-filter.ts';
import { readDiscoveryEngineResult } from './discovery-query.ts';

const emptyConsumerCost = (): CustodyCost => ({
  inputKeys: 0,
  candidates: 0,
  accessPoints: 0,
  dependencyPoints: 0,
  engineSearches: 0,
  engineIteratorSteps: 0,
  outputSlots: 0,
  resultWrites: 0,
  frontierWrites: 0,
  statements: 0,
  rows: 0,
  bytes: 0,
  engineRequests: 0,
});
type ConsumerMeter = { -readonly [K in keyof CustodyCost]: number };
class ConsumerFailure extends Error {
  constructor(readonly reason: PublicFilterConsumerUnavailable['reason']) {
    super(reason);
  }
}
function bootstrapBinding(binding: PublicFilterSourceBinding): binding is PublicFilterSourceBootstrapBinding {
  return ['begin', 'adopt', 'abort', 'recover', 'repairPage', 'settle'].every(
    (key) => key in binding && typeof Reflect.get(binding, key) === 'function',
  );
}
// Preserve bigint/undefined and arbitrary owner strings without interpreting user JSON as an encoding tag.
function stateTree(value: unknown): unknown {
  if (value === undefined) return ['undefined'];
  if (typeof value === 'bigint') return ['bigint', String(value)];
  if (Array.isArray(value)) return ['array', value.map(stateTree)];
  if (record(value))
    return [
      'object',
      Object.keys(value)
        .sort()
        .map((key) => [key, stateTree(value[key])]),
    ];
  return ['value', value];
}
function stateValue(value: any): any {
  if (value[0] === 'undefined') return undefined;
  if (value[0] === 'bigint') return BigInt(value[1]);
  if (value[0] === 'array') return value[1].map(stateValue);
  if (value[0] === 'object')
    return Object.fromEntries(value[1].map(([key, child]: [string, unknown]) => [key, stateValue(child)]));
  if (value[0] !== 'value') throw new ConsumerFailure('observation_lost');
  return value[1];
}
const encodeState = (value: unknown) => JSON.stringify(stateTree(value));
const decodeState = <T>(value: string): T => stateValue(JSON.parse(value));
type RetainedWindow = Readonly<{
  parent: string | null;
  consumed: number;
  before: readonly (string | number | null)[] | undefined;
  raw: readonly (SearchResult['hits'][number] | DiscoveryEngineHit)[];
  exhausted: boolean;
  rounds: number;
  charged: number;
}>;
type ConsumerWork = {
  registration: CustodyRegistration;
  bootstrap: Omit<PublicSourceBootstrap, 'definition'>;
  queried: PublicFilterQueriedObservation | null;
  materializing: PublicFilterQueriedObservation | null;
  prepared: SearchResult['hits'];
  preparedRows: { original: string; terminal: string }[];
  projectionSource: PublicSourceRepair['source'] | null;
  after: readonly (string | number | null)[] | undefined;
  execution: string | null;
  frontier: string | null;
  repair: RetainedSourceRepair | null;
  repairPage: {
    repairs: readonly RetainedSourceRepair[];
    account?: RetainedRepairPage['account'];
    accountDone?: boolean;
    next: number;
    frontier: string | null;
    complete: boolean;
  } | null;
  records: PublicFilterProjectionRecord[];
  dispatch: Readonly<{ id: string; version: bigint; document: SubjectDocument; state: 'uncertain' | 'visible' }> | null;
  rounds: number;
  charged: number;
  adopted: boolean;
};
function retainedBootstrap(bootstrap: PublicSourceBootstrap): Omit<PublicSourceBootstrap, 'definition'> {
  return { id: bootstrap.id, consumer: bootstrap.consumer, snapshot: bootstrap.snapshot, covered: bootstrap.covered };
}
function locatorHome(locator: string): number {
  const matched = /^(0|[1-9][0-9]{0,3}):/.exec(locator);
  if (!matched || Number(matched[1]) > 4095) throw new ConsumerFailure('observation_lost');
  return Number(matched[1]);
}

/** Native Source and Search custody are injected; construction performs no Source or engine I/O. */
export const createPublicFilterConsumerOperations: PublicFilterConsumerOperationsFactory = async (config) => {
  if (!config.pool || !config.source || !config.binding || typeof config.clock !== 'function' || !config.search)
    throw new TypeError('Consumer requires its injected native owners');
  const meaning = freeze(structuredClone(config.meaning));
  if (meaning.digest !== releaseDigest(meaning.release) || !meaning.release.types[meaning.type])
    throw new TypeError('Consumer requires an exact accepted meaning');
  const target = config.physicalTarget;
  if (!/^[a-z0-9][a-z0-9-]{0,95}$/.test(target)) throw new TypeError('Consumer requires a physical target');
  const binding = config.binding;
  const custody = createPublicFilterCustody(config.pool, binding);
  const pending = new Set<Promise<unknown>>();
  const owned = new Map<string, PublicFilterQueriedObservation>();
  let closed = false;
  let closing: Promise<void> | undefined;
  const track = <T>(run: () => Promise<T>): Promise<T> => {
    if (closed) return Promise.reject(new ConsumerFailure('observation_lost'));
    const operation = run();
    pending.add(operation);
    void operation.finally(() => pending.delete(operation)).catch(() => {});
    return operation;
  };
  function meter(context: PublicFilterConsumerContext) {
    const cost: ConsumerMeter = emptyConsumerCost();
    const add = (next: PublicFilterCost) => {
      for (const key of Object.keys(cost) as (keyof ConsumerMeter)[]) {
        const value = Reflect.get(next, key) ?? 0;
        if (!Number.isSafeInteger(value) || value < 0) throw new ConsumerFailure('dependency_unavailable');
        cost[key] += value;
      }
    };
    const check = () => {
      if (!Number.isSafeInteger(context.deadline) || context.deadline <= Date.now())
        throw new ConsumerFailure('deadline');
      if (
        cost.inputKeys > 1000 ||
        cost.accessPoints + cost.dependencyPoints > 16 + 8 * Math.max(cost.candidates, 1) ||
        cost.bytes > 4 * 1024 * 1024 ||
        cost.rows > 64 + 16 * Math.max(cost.candidates, 1)
      )
        throw new ConsumerFailure('source_pending');
    };
    const sql = async <T extends import('pg').QueryResultRow>(
      query: string,
      values: unknown[] | (() => unknown[]) = [],
      countedRows = false,
    ) => {
      check();
      cost.statements++;
      const baseBytes = cost.bytes + Buffer.byteLength(query);
      let parameters = typeof values === 'function' ? values() : values;
      // Native page work retains this very statement's reservation. Its encoded
      // byte counter is itself part of the request, so settle the finite decimal
      // length before dispatch instead of saving a snapshot from the prior call.
      for (let attempt = 0; ; attempt++) {
        const bytes = baseBytes + Buffer.byteLength(encodeState(parameters));
        if (typeof values !== 'function' || bytes === cost.bytes) {
          cost.bytes = bytes;
          break;
        }
        if (attempt === 8) throw new ConsumerFailure('dependency_unavailable');
        cost.bytes = bytes;
        parameters = values();
      }
      check();
      const request: import('pg').QueryConfig & { query_timeout: number } = {
        text: query,
        values: parameters,
        query_timeout: remaining(context),
      };
      const result = await config.pool.query<T>(request);
      if (!countedRows) cost.rows += result.rows.length;
      cost.bytes += Buffer.byteLength(encodeState(result.rows));
      check();
      return result;
    };
    const unavailable = (reason: PublicFilterConsumerUnavailable['reason']): PublicFilterConsumerUnavailable => ({
      status: 'unavailable',
      reason,
      cost,
    });
    const take = <T extends { cost: PublicFilterCost }>(result: T): T => {
      add(result.cost);
      check();
      return result;
    };
    const native: OpenSearch = {
      async request(method, path, body, options) {
        check();
        cost.engineRequests++;
        cost.bytes += Buffer.byteLength(encodeState(body));
        if (path.endsWith('/_search') || path.endsWith('/_search/template')) cost.engineSearches++;
        const result = await config.search.request(method, path, body, { ...options, timeoutMs: remaining(context) });
        cost.bytes += Buffer.byteLength(encodeState(result.body));
        // Physical keyed repair readbacks have no public query profile. Charge their actual shards;
        // the retained PIT path separately charges its native profile iterator work.
        if (path !== '/_search' && path.endsWith('/_search')) {
          const shards = (result.body as { _shards?: { total?: number } })._shards?.total;
          if (Number.isSafeInteger(shards) && shards! > 0) cost.engineIteratorSteps += shards!;
        }
        check();
        return result as any;
      },
      ...(config.search.bulkRaw
        ? {
            async bulkRaw<T>(body: string, options?: Parameters<NonNullable<OpenSearch['bulkRaw']>>[1]): Promise<T> {
              check();
              cost.engineRequests++;
              cost.bytes += Buffer.byteLength(body);
              const result = await config.search.bulkRaw!<T>(body, { ...options, timeoutMs: remaining(context) });
              cost.bytes += Buffer.byteLength(encodeState(result));
              check();
              return result;
            },
          }
        : {}),
      async bulk(lines, options) {
        check();
        cost.engineRequests++;
        cost.bytes += Buffer.byteLength(encodeState(lines));
        const result = await config.search.bulk(lines, { ...options, timeoutMs: remaining(context) });
        cost.bytes += Buffer.byteLength(encodeState(result));
        check();
        return result as any;
      },
    };
    const wrapQuery =
      (db: Pick<Pool, 'query'>) => async (query: string | import('pg').QueryConfig, values?: unknown[]) => {
        const text = typeof query === 'string' ? query : query.text;
        const cleanup = /^ROLLBACK\b/.test(text);
        if (!cleanup) check();
        const parameters = values ?? (typeof query === 'string' ? [] : (query.values ?? []));
        cost.statements++;
        cost.bytes += Buffer.byteLength(text) + Buffer.byteLength(encodeState(parameters));
        const request: import('pg').QueryConfig & { query_timeout: number } = {
          text,
          values: parameters,
          query_timeout: cleanup ? 1000 : remaining(context),
        };
        const result = await db.query(request);
        cost.rows += result.rows.length;
        cost.bytes += Buffer.byteLength(encodeState(result.rows));
        if (/\b(INSERT|UPDATE|DELETE)\b/.test(text)) cost.resultWrites += result.rowCount ?? 0;
        if (!cleanup) check();
        return result;
      };
    const pool = new Proxy(config.pool, {
      get(db, key) {
        if (key === 'query') return wrapQuery(db);
        if (key === 'connect')
          return async () => {
            const client = await db.connect();
            return new Proxy(client, {
              get(connection, property) {
                if (property === 'query') return wrapQuery(connection);
                const value = Reflect.get(connection, property);
                return typeof value === 'function' ? value.bind(connection) : value;
              },
            });
          };
        const value = Reflect.get(db, key);
        return typeof value === 'function' ? value.bind(db) : value;
      },
    });
    return { cost, add, check, sql, unavailable, take, native, pool };
  }
  type Meter = ReturnType<typeof meter>;
  type Page = {
    context: PublicFilterConsumerContext;
    m: Meter;
    id: string | null;
    queried: PublicFilterQueriedObservation | null;
    start: PrivacyReductionStart | null;
    tail: string | null;
    rounds: number;
    charged: number;
    failed: boolean;
    finished: boolean;
    disposed: boolean;
    busy: boolean;
    use: CustodyUse | null;
  };
  const captures = new WeakMap<Extract<PublicFilterConsumerCapture, { status: 'captured' }>, Page>();
  function newPage(context: PublicFilterConsumerContext): Page {
    return {
      context,
      m: meter(context),
      id: null,
      queried: null,
      start: null,
      tail: null,
      rounds: 0,
      charged: 0,
      failed: false,
      finished: false,
      disposed: false,
      busy: false,
      use: null,
    };
  }
  // Native page metadata/control work uses the original consumer meter. Reserve
  // misses, locks, FK checks and attempted writes before submitting each statement.
  async function pageSql<T extends import('pg').QueryResultRow>(
    page: Page,
    footprint: { points: number; keys: number; writes: number },
    text: string,
    values: () => unknown[],
  ) {
    page.m.cost.dependencyPoints += footprint.points;
    page.m.cost.inputKeys += footprint.keys;
    page.m.cost.rows += footprint.points;
    page.m.cost.frontierWrites += footprint.writes;
    page.m.check();
    // The returned row is the same keyed control already reserved above.
    // Keep this true even at the result-side budget check and on lost receipts.
    return page.m.sql<T>(text, values, true);
  }
  async function beginPage(
    page: Page,
    q: PublicFilterQueriedObservation,
    use: CustodyUse,
    prefix: PublicFilterConsumerRefill | undefined,
    previous: string | null,
    ceiling: number,
  ) {
    if (
      page.queried &&
      (page.queried.snapshot.observation !== q.snapshot.observation ||
        !isDeepStrictEqual(page.queried.consumer, q.consumer))
    )
      throw new ConsumerFailure('observation_lost');
    if (page.id !== null) {
      if (page.queried?.snapshot.observation !== q.snapshot.observation || page.tail !== prefix?.execution)
        throw new ConsumerFailure('observation_lost');
      return;
    }
    const id = randomUUID();
    const result = await pageSql(
      page,
      { points: 8, keys: 18, writes: 1 },
      `WITH input AS (SELECT $1::integer AS home,$2::text AS observation,$3::uuid AS id,
        $4::uuid AS token,$5::bigint AS now,$6::bigint AS deadline,$7::text AS parent,
        $8::integer AS consumed,$9::text AS previous,$10::integer AS ceiling,$11::text AS work),
      locked AS MATERIALIZED (
        SELECT o.partition_no,o.observation,o.registration,r.definition,r.consumer,
          i.id,i.deadline,i.parent,i.consumed,i.previous,i.ceiling,i.work
        FROM input i JOIN search.public_filter_observation o ON (o.partition_no,o.observation)=(i.home,i.observation)
        JOIN search.public_filter_registration r ON (r.partition_no,r.id)=(o.partition_no,o.registration)
        JOIN search.public_filter_reference f ON (f.partition_no,f.observation,f.token)=(o.partition_no,o.observation,i.token)
        LEFT JOIN search.public_filter_execution e ON (e.partition_no,e.observation,e.id)=(o.partition_no,o.observation,i.parent)
        WHERE o.state='open' AND o.expires_at>i.now AND f.expires_at>i.now AND r.state='active'
          AND (i.parent IS NULL OR (e.consumer_window=i.previous AND (e.page_id IS NULL OR e.page_status='complete')))
          AND NOT EXISTS (SELECT 1 FROM search.public_filter_coverage_page p
            WHERE (p.partition_no,p.observation)=(o.partition_no,o.observation)
              AND (p.state IN ('planned','open','sealed') OR p.pending IS NOT NULL))
        FOR UPDATE OF o FOR SHARE OF r,f)
      INSERT INTO search.public_filter_coverage_page
        (partition_no,id,observation,registration,definition,consumer,deadline,reference_token,boundary,boundary_consumed,boundary_window,ceiling,state,work)
      SELECT l.partition_no,l.id,l.observation,l.registration,l.definition,l.consumer,l.deadline,i.token,
        l.parent,l.consumed,l.previous,l.ceiling,'planned',l.work
      FROM locked l CROSS JOIN input i RETURNING id`,
      () => [
        locatorHome(q.snapshot.observation),
        q.snapshot.observation,
        id,
        use.token,
        Date.now(),
        page.context.deadline,
        prefix?.execution ?? null,
        prefix?.consumed ?? 0,
        previous,
        ceiling,
        encodeState(page.m.cost),
      ],
    );
    if (result.rowCount !== 1) throw new ConsumerFailure('observation_lost');
    page.id = id;
    page.queried = q;
    page.use = use;
    const observed = await withPublicFilterCoverageStart(page.context, id, () =>
      observe(q, null, undefined, page.m, page.context),
    );
    if (observed.blocking.length || observed.unacknowledged.length || observed.changed.length)
      throw new ConsumerFailure('source_pending');
    page.start = observed.start;
  }
  async function reservePage(
    page: Page,
    use: CustodyUse,
    execution: string,
    prefix: PublicFilterConsumerRefill | undefined,
    size: number,
  ) {
    const result = await pageSql<{ rounds: number; charged: number }>(
      page,
      { points: 8, keys: 20, writes: 2 },
      `WITH input AS (SELECT $1::integer AS home,$2::uuid AS page,$3::text AS observation,$4::uuid AS token,
        $5::bigint AS now,$6::text AS execution,$7::text AS parent,$8::integer AS consumed,$9::integer AS size,
        $10::text AS payload,$11::text AS work), locked AS MATERIALIZED (
        SELECT p.partition_no,p.id FROM input i JOIN search.public_filter_coverage_page p ON (p.partition_no,p.id)=(i.home,i.page)
        JOIN search.public_filter_observation o ON (o.partition_no,o.observation)=(p.partition_no,p.observation)
        JOIN search.public_filter_reference f ON (f.partition_no,f.observation,f.token)=(o.partition_no,o.observation,i.token)
        WHERE p.observation=i.observation AND p.state='open' AND p.pending IS NULL AND p.deadline>i.now
          AND o.state='open' AND f.expires_at>i.now AND p.rounds<3 AND p.charged+i.size<=p.ceiling
          AND coalesce(p.tail,p.boundary) IS NOT DISTINCT FROM i.parent
          AND ((p.tail IS NOT NULL AND p.tail_consumed=i.consumed) OR (p.tail IS NULL AND p.boundary_consumed=i.consumed))
        FOR UPDATE OF p FOR SHARE OF o,f), advanced AS (
        UPDATE search.public_filter_coverage_page p SET pending=i.execution,rounds=p.rounds+1,charged=p.charged+i.size,
          revision=p.revision+1,work=i.work FROM locked l,input i
        WHERE (p.partition_no,p.id)=(l.partition_no,l.id) RETURNING p.*), appended AS (
        INSERT INTO search.public_filter_execution
          (partition_no,observation,id,execution,page_id,page_ordinal,page_parent,page_consumed,page_size,page_status,page_engine_started)
        SELECT p.partition_no,p.observation,i.execution,i.payload,p.id,p.rounds,i.parent,i.consumed,i.size,'dispatched',false
        FROM advanced p,input i RETURNING id)
      SELECT p.rounds,p.charged FROM advanced p JOIN appended a ON a.id=p.pending`,
      () => [
        locatorHome(use.observation),
        page.id,
        use.observation,
        use.token,
        Date.now(),
        execution,
        prefix?.execution ?? null,
        prefix?.consumed ?? 0,
        size,
        encodeNative({ id: execution, start: page.start!, ownRows: [] }),
        encodeState(page.m.cost),
      ],
    );
    const reserved = result.rows[0];
    if (!reserved || result.rowCount !== 1) throw new ConsumerFailure('observation_lost');
    page.rounds = reserved.rounds;
    page.charged = reserved.charged;
  }
  async function dispatchPageEngine(page: Page, use: CustodyUse, execution: string) {
    // Commit the fence and its self-inclusive root reservation before engine I/O.
    // A lost receipt retains both, even if this process never sends the request.
    // Funding the root also acquires its lock. The native guard resolves the
    // root's immutable exact reference in this same statement.
    const started = await pageSql(
      page,
      { points: 5, keys: 12, writes: 2 },
      `WITH funded AS (
         UPDATE search.public_filter_coverage_page p SET work=$7,revision=p.revision+1
         WHERE (p.partition_no,p.id)=($1,$2::uuid) AND p.state='open' AND p.pending=$3
           AND p.observation=$6 AND p.reference_token=$4::uuid AND p.deadline>$5
         RETURNING p.partition_no,p.observation,p.id)
       UPDATE search.public_filter_execution e SET page_engine_started=true FROM funded p
       WHERE (e.partition_no,e.observation,e.id)=(p.partition_no,p.observation,$3)
         AND e.page_id=p.id AND e.page_status='dispatched' AND e.page_engine_started IS FALSE RETURNING e.id`,
      () => [
        locatorHome(use.observation),
        page.id,
        execution,
        use.token,
        Date.now(),
        use.observation,
        encodeState(page.m.cost),
      ],
    );
    if (started.rowCount !== 1) throw new ConsumerFailure('observation_lost');
  }
  async function completePage(
    page: Page,
    execution: string,
    rows: CustodyExecution['ownRows'],
    window: RetainedWindow,
    reserved: number,
  ) {
    const result = await pageSql(
      page,
      { points: 4, keys: 8, writes: 2 },
      `WITH input AS (SELECT $1::integer AS home,$2::uuid AS page,$3::text AS execution,$4::text AS payload,
        $5::text AS window,$6::integer AS unused,$7::text AS work,$8::integer AS raw), locked AS MATERIALIZED (
        SELECT p.partition_no,p.id,p.observation FROM input i JOIN search.public_filter_coverage_page p
          ON (p.partition_no,p.id)=(i.home,i.page)
        WHERE p.state='open' AND p.pending=i.execution FOR UPDATE OF p), completed AS (
        UPDATE search.public_filter_execution e SET execution=i.payload,consumer_window=i.window,page_status='complete',page_raw=i.raw
        FROM locked l,input i WHERE (e.partition_no,e.observation,e.id)=(l.partition_no,l.observation,i.execution)
          AND e.page_id=l.id AND e.page_status='dispatched' AND e.consumer_window IS NULL RETURNING e.id)
      UPDATE search.public_filter_coverage_page p SET tail=c.id,tail_consumed=NULL,pending=NULL,charged=p.charged-i.unused,
        revision=p.revision+1,work=i.work FROM locked l,completed c,input i
      WHERE (p.partition_no,p.id)=(l.partition_no,l.id) RETURNING p.id`,
      () => [
        locatorHome(page.queried!.snapshot.observation),
        page.id,
        execution,
        encodeNative({ id: execution, start: page.start!, ownRows: rows }),
        encodeState(window),
        reserved - window.raw.length,
        encodeState(page.m.cost),
        window.raw.length,
      ],
    );
    if (result.rowCount !== 1) throw new ConsumerFailure('observation_lost');
    page.tail = execution;
    page.charged -= reserved - window.raw.length;
  }
  async function mixedGeneration(m: Meter): Promise<void> {
    if (!config.registry) throw new ConsumerFailure('dependency_unavailable');
    const match = /^(.*)discovery-g([1-9][0-9]*)$/.exec(target);
    if (!match) throw new ConsumerFailure('dependency_unavailable');
    const row = (
      await m.sql<{ kinds: string[]; index_uuid: string | null; incarnation: string }>(
        `SELECT kinds,index_uuid,incarnation::text FROM search.discovery_generation
       WHERE partition_no=0 AND prefix=$1 AND generation=$2 AND state IN ('ready','active','retiring')`,
        [match[1], match[2]],
      )
    ).rows[0];
    if (
      !row?.index_uuid ||
      !isDeepStrictEqual([...row.kinds].sort(), config.registry.entries.map((entry) => entry.kind).sort())
    )
      throw new ConsumerFailure('dependency_unavailable');
    const mapping = await m.native.request<unknown>('GET', `/${target}/_mapping`);
    const settings = await m.native.request<unknown>('GET', `/${target}/_settings`);
    if (
      mapping.status !== 200 ||
      !record(mapping.body) ||
      Object.keys(mapping.body).length !== 1 ||
      !record(mapping.body[target]) ||
      !record(mapping.body[target].mappings) ||
      !record(mapping.body[target].mappings._meta) ||
      mapping.body[target].mappings._meta.discovery_document_format !== 2 ||
      mapping.body[target].mappings._meta.comparator !== 'mixed-public-v1' ||
      mapping.body[target].mappings._meta.incarnation !== row.incarnation ||
      settings.status !== 200 ||
      !record(settings.body) ||
      Object.keys(settings.body).length !== 1 ||
      !record(settings.body[target]) ||
      !record(settings.body[target].settings) ||
      !record(settings.body[target].settings.index) ||
      settings.body[target].settings.index.uuid !== row.index_uuid
    )
      throw new ConsumerFailure('incarnation_changed');
  }
  async function physical(q: PublicFilterQueriedObservation, m: Meter, context: PublicFilterConsumerContext) {
    if (q.consumer.physicalTarget !== target || q.consumer.meaningDigest !== meaning.digest)
      throw new ConsumerFailure('incarnation_changed');
    const response = await m.native.request<Record<string, { settings?: { index?: { uuid?: string } } }>>(
      'GET',
      `/${target}/_settings`,
    );
    if (
      response.status !== 200 ||
      Object.keys(response.body).length !== 1 ||
      response.body[target]?.settings?.index?.uuid !== q.consumer.incarnation
    )
      throw new ConsumerFailure('incarnation_changed');
    m.check();
  }
  async function load(
    job: PublicFilterConsumerJob,
    m: Meter,
  ): Promise<{ work: ConsumerWork; encoded: string; registration: boolean }> {
    if (job.consumer.physicalTarget !== target) throw new ConsumerFailure('registration_missing');
    const home = locatorHome(job.job);
    const bootstrapPrefix = `${home}:bootstrap:`;
    if (job.job.startsWith(bootstrapPrefix)) {
      const bootstrap = decodeURIComponent(job.job.slice(bootstrapPrefix.length));
      const row = (
        await m.sql<{ consumer_work: string; registration: boolean }>(
          `SELECT consumer_work,false AS registration
        FROM search.public_filter_observation WHERE partition_no=$1 AND consumer_bootstrap=$2 AND state='open'
        UNION ALL SELECT consumer_work,true AS registration FROM search.public_filter_registration
        WHERE partition_no=$1 AND consumer_bootstrap=$2 AND state='active' LIMIT 1`,
          [home, bootstrap],
        )
      ).rows[0];
      if (!row?.consumer_work) throw new ConsumerFailure('observation_lost');
      const work = decodeState<ConsumerWork>(row.consumer_work);
      if (work.bootstrap.id !== bootstrap || !isDeepStrictEqual(work.bootstrap.consumer, job.consumer))
        throw new ConsumerFailure('registration_missing');
      return { work, encoded: row.consumer_work, registration: row.registration };
    }
    const registration = false;
    const row = (
      await m.sql<{ consumer_work: string | null }>(
        "SELECT consumer_work FROM search.public_filter_observation WHERE (partition_no,observation)=($1,$2) AND state='open'",
        [home, job.job],
      )
    ).rows[0];
    if (!row?.consumer_work) throw new ConsumerFailure('observation_lost');
    const work = decodeState<ConsumerWork>(row.consumer_work);
    if (!isDeepStrictEqual(work.bootstrap.consumer, job.consumer)) throw new ConsumerFailure('registration_missing');
    return { work, encoded: row.consumer_work, registration };
  }
  async function save(work: ConsumerWork, old: string | null, registration: boolean, m: Meter) {
    const encoded = encodeState(work);
    if (Buffer.byteLength(encoded) > 1024 * 1024) throw new ConsumerFailure('dependency_unavailable');
    const q = work.queried ?? work.materializing;
    const result = await m.sql(
      registration
        ? 'UPDATE search.public_filter_registration SET consumer_work=$3,consumer_bootstrap=$5 WHERE (partition_no,id)=($1,$2) AND consumer_work IS NOT DISTINCT FROM $4 RETURNING id'
        : "UPDATE search.public_filter_observation SET consumer_work=$3,consumer_bootstrap=$5 WHERE (partition_no,observation)=($1,$2) AND consumer_work IS NOT DISTINCT FROM $4 AND state='open' RETURNING observation",
      [
        work.registration.partition,
        registration ? work.registration.id : q!.snapshot.observation,
        encoded,
        old,
        work.bootstrap.id,
      ],
    );
    if (result.rowCount !== 1) throw new ConsumerFailure('source_pending');
    m.cost.frontierWrites++;
    return encoded;
  }
  function failure(error: unknown, m: Meter): PublicFilterConsumerUnavailable {
    if (error instanceof ConsumerFailure) return m.unavailable(error.reason);
    if (error instanceof PublicFilterRepairSourceError)
      return m.unavailable(error.reason === 'deadline' ? 'deadline' : 'source_pending');
    if (error instanceof SearchUnavailableError) return m.unavailable('dependency_unavailable');
    throw error;
  }
  async function join(
    q: PublicFilterQueriedObservation,
    execution: string | undefined,
    m: Meter,
    context: PublicFilterConsumerContext,
  ) {
    const joined = m.take(
      await binding.join({ queried: q, ...(execution === undefined ? {} : { execution }) }, context),
    );
    if (joined.status !== 'joined')
      throw new ConsumerFailure(joined.reason === 'deadline' ? 'deadline' : 'source_pending');
    if (
      !isDeepStrictEqual(joined.queried, q) ||
      joined.definition.meaning.digest !== meaning.digest ||
      (execution !== undefined && joined.execution?.id !== execution)
    )
      throw new ConsumerFailure('observation_lost');
    return joined;
  }
  async function observe(
    q: PublicFilterQueriedObservation,
    start: PrivacyReductionStart | null,
    execution: string | undefined,
    m: Meter,
    context: PublicFilterConsumerContext,
  ) {
    const observed = m.take(
      await config.source.readPrivacyReductionHeads(
        start === null
          ? { kind: 'population', queried: q, start: null, context }
          : { kind: 'population', queried: q, start, execution: execution!, context },
      ),
    );
    if (observed.status !== 'observed') throw new ConsumerFailure('source_pending');
    if (observed.coverage !== 'all_native_homes' || !observed.routingComplete)
      throw new ConsumerFailure('routing_incomplete');
    return observed;
  }
  async function ownRows(
    hits: readonly SearchResult['hits'][number][],
    m: Meter,
    context: PublicFilterConsumerContext,
  ) {
    const rows: { original: string; terminal: string }[] = [];
    const accepted: number[] = [];
    const terminals = new Set<string>();
    for (const [position, hit] of hits.entries()) {
      m.check();
      const page = m.take(
        await config.source.readPublicFilterProjectionPage({
          subject: hit.id,
          meaning,
          inputLimit: Math.max(1, 1000 - m.cost.inputKeys),
          frontier: null,
          context,
        }),
      );
      if (page.status !== 'complete') throw new ConsumerFailure('source_pending');
      if (
        page.source.subject !== hit.id ||
        page.source.partition !== hit.partition ||
        page.source.securityRevision !== String(hit.securityRevision) ||
        page.source.currentRelease !== meaning.digest
      )
        throw new ConsumerFailure('source_pending');
      rows.push({ original: hit.id, terminal: page.source.terminal });
      if (!terminals.has(page.source.terminal)) {
        accepted.push(position);
        terminals.add(page.source.terminal);
      }
    }
    return { rows, accepted };
  }
  async function nativeBatch(
    q: PublicFilterQueriedObservation,
    plan: PublicCanonicalCaptureInput,
    size: number,
    after: readonly (string | number | null)[] | undefined,
    use: CustodyUse,
    m: Meter,
    context: PublicFilterConsumerContext,
  ) {
    if (q.snapshot.kind !== 'pit') throw new ConsumerFailure('observation_lost');
    let current = q;
    const retain = async (pit: string) => {
      const retained = m.take(await custody.retainPit({ use, queried: current, pit }, context));
      if (retained.status !== 'retained') throw new ConsumerFailure('observation_lost');
      current = retained.queried;
      owned.set(current.snapshot.observation, current);
    };
    if ('representation' in plan) {
      if (!config.registry) throw new ConsumerFailure('dependency_unavailable');
      await mixedGeneration(m);
      const compiled = compileDiscoveryConsumerCapture(plan, meaning, config.registry);
      const sort =
        plan.sort === 'relevance'
          ? [{ _score: 'desc' }, { id: 'asc' }, { kind: 'asc' }, { identity: 'asc' }]
          : plan.sort === 'name'
            ? [{ name_sort: { order: 'asc', missing: '_last' } }, { id: 'asc' }, { kind: 'asc' }, { identity: 'asc' }]
            : [{ id: 'asc' }, { kind: 'asc' }, { identity: 'asc' }];
      const response = await m.native.request<unknown>(
        'POST',
        '/_search',
        {
          query: compiled.query,
          pit: { id: q.snapshot.pit },
          size,
          sort,
          profile: true,
          track_total_hits: false,
          ...(after === undefined ? {} : { search_after: after }),
        },
        { query: { allow_partial_search_results: false, search_type: 'dfs_query_then_fetch' } },
      );
      const body = response.body;
      if (record(body) && typeof body.pit_id === 'string') await retain(body.pit_id);
      assertCompleteSearch(body);
      if (
        response.status !== 200 ||
        !record(body) ||
        !record(body.hits) ||
        !Array.isArray(body.hits.hits) ||
        body.hits.hits.length > size
      )
        throw new ConsumerFailure('dependency_unavailable');
      const raw = readDiscoveryEngineResult(body, config.registry, target, {
        sort: plan.sort === 'name' ? 'name' : plan.sort === 'relevance' ? 'relevance' : 'id',
        size,
        filter: {},
        ...(after === undefined ? {} : { after }),
      }).hits;
      m.cost.engineIteratorSteps += iteratorSteps(body);
      return { queried: current, raw, exhausted: raw.length < size, total: undefined };
    }
    if ('purpose' in plan) {
      validatePublicSuggestionInput(plan);
      const { prefix, generation } = targetParts(q.consumer.physicalTarget);
      const sort = [{ _score: 'desc' }, { id: 'asc' }];
      const response = await m.native.request<unknown>(
        'POST',
        '/_search',
        {
          query: compilePublicSuggestion(plan),
          pit: { id: q.snapshot.pit },
          size,
          sort,
          profile: true,
          track_total_hits: false,
          ...(after === undefined ? {} : { search_after: after }),
          _source: ['partition', 'security_revision'],
        },
        { query: { allow_partial_search_results: false, search_type: 'dfs_query_then_fetch' } },
      );
      const body = response.body;
      if (record(body) && typeof body.pit_id === 'string') await retain(body.pit_id);
      assertCompleteSearch(body);
      if (
        response.status !== 200 ||
        !record(body) ||
        !record(body.hits) ||
        !Array.isArray(body.hits.hits) ||
        body.hits.hits.length > size
      )
        throw new ConsumerFailure('dependency_unavailable');
      admitHitPayload(body, { sort: 'relevance', size, generation, ...(after === undefined ? {} : { after }) }, prefix);
      if (typeof body.pit_id !== 'string' || !body.pit_id.length) throw new ConsumerFailure('observation_lost');
      if (body.hits.hits.some((hit) => !record(hit) || hit._index !== q.consumer.physicalTarget))
        throw new ConsumerFailure('incarnation_changed');
      const raw = body.hits.hits.map((hit) => ({
        id: hit._id as string,
        index: hit._index as string,
        partition: (hit._source as { partition: number }).partition,
        securityRevision: (hit._source as { security_revision: number }).security_revision,
        matched: Array.isArray(hit.matched_queries) ? ([...hit.matched_queries] as string[]) : [],
        sort: [...(hit.sort as (string | number | null)[])],
      }));
      m.cost.engineIteratorSteps += iteratorSteps(body);
      return { queried: q, raw, exhausted: raw.length < size, total: undefined };
    }
    if (plan.sort === 'rating') throw new ConsumerFailure('dependency_unavailable');
    const executed = await queryPublicFilterConsumerPit(
      m.native,
      q,
      { ...plan, sort: plan.sort, size, ...(after === undefined ? {} : { after }) },
      context,
      retain,
    );
    m.cost.engineIteratorSteps += executed.engineIteratorSteps;
    return {
      queried: current,
      raw: executed.result.hits,
      exhausted: executed.result.hits.length < size,
      total: executed.result.total,
    };
  }
  async function advanceCapture(
    work: ConsumerWork,
    encoded: string,
    m: Meter,
    context: PublicFilterConsumerContext,
    page?: Page,
  ): Promise<PublicFilterConsumerCapture> {
    if (!bootstrapBinding(binding)) return m.unavailable('source_pending');
    let recovery = m.take(await binding.recover({ bootstrap: work.bootstrap.id }, context));
    const consumer = work.bootstrap.consumer;
    const job: PublicFilterConsumerJob = {
      consumer,
      job: `${work.registration.partition}:bootstrap:${encodeURIComponent(work.bootstrap.id)}`,
    };
    if (recovery.status === 'pending') {
      const native = await advanceNativePublicFilterPreparation(binding, { bootstrap: work.bootstrap.id }, context);
      if (native === null) return m.unavailable('source_pending');
      const advanced = m.take(native);
      if (advanced.status !== 'begun' && advanced.status !== 'preparing') return m.unavailable('source_pending');
      if (!isDeepStrictEqual(retainedBootstrap(advanced.bootstrap), work.bootstrap))
        return m.unavailable('observation_lost');
      if (advanced.status === 'preparing') return { status: 'preparing', repair: job, cost: m.cost };
      recovery = { ...advanced, queried: null };
    }
    if (recovery.status !== 'begun' && recovery.status !== 'adopted') return m.unavailable('source_pending');
    if (!isDeepStrictEqual(retainedBootstrap(recovery.bootstrap), work.bootstrap))
      return m.unavailable('observation_lost');
    // Recover the original committed physical adoption, never open a replacement PIT.
    if (recovery.status === 'adopted') {
      if (work.queried !== null && !isDeepStrictEqual(work.queried, recovery.queried))
        return m.unavailable('observation_lost');
      work.queried = recovery.queried;
      work.adopted = true;
      encoded = await save(work, encoded, true, m);
    }
    if (work.queried === null && work.materializing === null) {
      const retained = m.take(
        await custody.openPit(
          { registration: work.registration, covered: work.bootstrap.covered, keepAliveMs: 300_000 },
          config.search,
          context,
        ),
      );
      if (retained.status !== 'retained') return m.unavailable('observation_lost');
      if (work.bootstrap.snapshot === 'prepared') work.materializing = retained.queried;
      else work.queried = retained.queried;
      owned.set(retained.queried.snapshot.observation, retained.queried);
      encoded = await save(work, encoded, true, m);
    }
    if (work.materializing && !work.queried) {
      // Serving capture cannot enumerate a preparation child before its closed
      // page plan exists. The ordinary bounded preparation owner advances this
      // retained frontier; a later capture can adopt only its actual result.
      if (page) return { status: 'preparing', repair: job, cost: m.cost };
      const q = work.materializing;
      const acquired = m.take(await custody.acquire(q, context));
      if (acquired.status !== 'acquired') return m.unavailable('observation_lost');
      try {
        const result = await nativeBatch(
          q,
          recovery.bootstrap.definition.capture,
          100,
          work.after,
          acquired.use,
          m,
          context,
        );
        if (result.raw.some((hit) => 'key' in hit)) return m.unavailable('dependency_unavailable');
        const raw = result.raw as SearchResult['hits'];
        m.cost.candidates += raw.length;
        const checked = await ownRows(raw, m, context);
        work.prepared.push(...checked.accepted.map((position) => raw[position]!));
        work.preparedRows.push(...checked.rows);
        work.materializing = result.queried;
        work.after = raw.at(-1)?.sort ?? work.after;
        if (work.prepared.length > 1000) return m.unavailable('dependency_unavailable');
        if (!result.exhausted) {
          await save(work, encoded, true, m);
          return { status: 'preparing', repair: job, cost: m.cost };
        }
        const prepared = m.take(
          await custody.retainPrepared(
            {
              registration: work.registration,
              covered: work.bootstrap.covered,
              build: work.bootstrap.id,
              generation: 1n,
              rows: work.preparedRows,
              expiresAt: Date.now() + 300_000,
            },
            context,
          ),
        );
        if (prepared.status !== 'retained') return m.unavailable('observation_lost');
        work.queried = prepared.queried;
        encoded = await save(work, encoded, true, m);
        owned.set(prepared.queried.snapshot.observation, prepared.queried);
      } finally {
        m.add((await custody.release(acquired.use, context)).cost);
      }
    }
    const q = work.queried!;
    await physical(q, m, context);
    if (!work.adopted) {
      const recovered = m.take(await binding.recover({ bootstrap: work.bootstrap.id }, context));
      if (recovered.status === 'pending') return { status: 'preparing', repair: job, cost: m.cost };
      if (recovered.status !== 'begun' && recovered.status !== 'adopted') return m.unavailable('source_pending');
      if (!isDeepStrictEqual(retainedBootstrap(recovered.bootstrap), work.bootstrap))
        return m.unavailable('observation_lost');
      const adopted =
        recovered.status === 'adopted'
          ? recovered
          : m.take(await binding.adopt({ bootstrap: work.bootstrap.id, queried: q }, context));
      if (adopted.status !== 'adopted') return m.unavailable('source_pending');
      if (
        !isDeepStrictEqual(adopted.queried, q) ||
        !isDeepStrictEqual(retainedBootstrap(adopted.bootstrap), work.bootstrap)
      )
        return m.unavailable('observation_lost');
      work.adopted = true;
      encoded = await save(work, encoded, true, m);
    }
    // Transfer work to THIS immutable observation before clearing the registration's bootstrap intent.
    await save(work, null, false, m);
    await m.sql(
      'UPDATE search.public_filter_registration SET consumer_work=NULL,consumer_bootstrap=NULL WHERE (partition_no,id)=($1,$2) AND consumer_work=$3',
      [work.registration.partition, work.registration.id, encoded],
    );

    try {
      const joined = await join(q, undefined, m, context);
      if (!isDeepStrictEqual(joined.covered, work.bootstrap.covered)) return m.unavailable('observation_lost');
      // An enclosing page starts once, after its complete native plan and cursor
      // boundary are closed. Baseline preparation cannot manufacture that start.
      if (!page) {
        const observation = await observe(q, null, undefined, m, context);
        if (observation.blocking.length || observation.unacknowledged.length || observation.changed.length)
          return { status: 'preparing', repair: job, cost: m.cost };
      }
      return { status: 'captured', queried: q, repair: job, cost: m.cost };
    } catch (error) {
      if (error instanceof ConsumerFailure && ['source_pending', 'routing_incomplete'].includes(error.reason))
        return { status: 'preparing', repair: job, cost: m.cost };
      throw error;
    }
  }

  async function capturePlan(
    plan: PublicCanonicalCaptureInput,
    snapshot: 'pit' | 'prepared',
    context: PublicFilterConsumerContext,
    page?: Page,
  ): Promise<PublicFilterConsumerCapture> {
    const m = page?.m ?? meter(context);
    if (snapshot !== 'pit' && snapshot !== 'prepared') throw new TypeError('Unknown immutable snapshot kind');
    // All grammar, private-owner and optional DSL validation precedes the first native call.
    let canonical: PublicCanonicalCaptureInput;
    if ('representation' in plan) {
      if (plan.text !== undefined) validateText(plan.text);
      compileDiscoveryConsumerCapture(plan, meaning, config.registry);
      canonical = freeze(
        structuredClone(config.registry ? compileDiscoveryCapture(plan, config.registry, meaning.release) : plan),
      );
    } else if ('purpose' in plan) {
      validatePublicSuggestionInput(plan);
      canonical = freeze(structuredClone(plan));
    } else canonical = compilePublicFilterConsumerCapture(plan, meaning).capture;
    try {
      m.check();
      const resolved = m.take(await binding.resolve({ source: config.source, meaning, capture: canonical }, context));
      if (resolved.status !== 'resolved')
        return m.unavailable(resolved.reason === 'deadline' ? 'deadline' : 'source_pending');
      if (
        !isDeepStrictEqual(resolved.definition.capture, canonical) ||
        !isDeepStrictEqual(resolved.definition.meaning, meaning)
      )
        return m.unavailable('registration_missing');
      if ('representation' in canonical && !config.registry) return m.unavailable('dependency_unavailable');
      if ('representation' in canonical) await mixedGeneration(m);
      const registered = m.take(
        await custody.register(
          {
            definition: resolved.definition,
            physicalTarget: target,
            consumerGeneration: resolved.definition.source.configuration,
            projectionGeneration: resolved.definition.readDefinition,
            catalogue: null,
          },
          config.search,
          context,
        ),
      );
      if (registered.status !== 'registered') return m.unavailable('registration_missing');
      const registration = registered.registration;
      const old = (
        await m.sql<{ consumer_work: string | null }>(
          'SELECT consumer_work FROM search.public_filter_registration WHERE (partition_no,id)=($1,$2)',
          [registration.partition, registration.id],
        )
      ).rows[0];
      if (old?.consumer_work)
        return advanceCapture(decodeState<ConsumerWork>(old.consumer_work), old.consumer_work, m, context, page);
      if (!bootstrapBinding(binding)) return m.unavailable('source_pending');
      const preparation = {
        source: config.source,
        meaning,
        capture: canonical,
        consumer: registered.consumer,
        snapshot,
      };
      const native = await advanceNativePublicFilterPreparation(binding, preparation, context);
      const begun = m.take(native ?? (await binding.begin(preparation, context)));
      if (begun.status !== 'begun' && begun.status !== 'preparing') return m.unavailable('source_pending');
      if (
        !isDeepStrictEqual(begun.bootstrap.definition, resolved.definition) ||
        !isDeepStrictEqual(begun.bootstrap.consumer, registered.consumer) ||
        begun.bootstrap.snapshot !== snapshot
      )
        return m.unavailable('registration_missing');
      const work: ConsumerWork = {
        registration,
        bootstrap: retainedBootstrap(begun.bootstrap),
        queried: null,
        materializing: null,
        prepared: [],
        preparedRows: [],
        projectionSource: null,
        after: undefined,
        execution: null,
        frontier: null,
        repair: null,
        repairPage: null,
        records: [],
        dispatch: null,
        rounds: 0,
        charged: 0,
        adopted: false,
      };
      const encoded = await save(work, null, true, m);
      if (begun.status === 'preparing')
        return {
          status: 'preparing',
          repair: {
            consumer: work.bootstrap.consumer,
            job: `${registration.partition}:bootstrap:${encodeURIComponent(work.bootstrap.id)}`,
          },
          cost: m.cost,
        };
      return await advanceCapture(work, encoded, m, context, page);
    } catch (error) {
      return failure(error, m);
    }
  }
  async function queryPlan(
    input: PublicFilterQueriedObservation,
    context: PublicFilterConsumerContext,
    refill: PublicFilterConsumerRefill | undefined,
    mixed: boolean,
    page?: Page,
  ): Promise<PublicFilterConsumerQuery | DiscoveryConsumerQuery> {
    let q = structuredClone(input);
    const prefix = refill === undefined ? undefined : structuredClone(refill);
    const m = page?.m ?? meter(context);
    const preparing = () => ({ status: 'preparing' as const, queried: q, cost: m.cost });
    let use: CustodyUse | undefined;
    try {
      m.check();
      // This installed factory is the finite registry family. A retained
      // catalogue consumer needs its actual root-bound native resolver; it
      // cannot borrow this request's finite selected Type registrations.
      if (publicFilterCatalogue(q.consumer, mixed) !== null) throw new ConsumerFailure('registration_missing');
      if (page?.use) use = page.use;
      else {
        const acquired = m.take(await custody.acquire(q, context));
        if (acquired.status !== 'acquired') return m.unavailable('observation_lost');
        use = acquired.use;
      }
      const joined = await join(q, undefined, m, context);
      const plan = joined.definition.capture;
      if ('representation' in plan !== mixed || ('purpose' in plan && mixed))
        return m.unavailable('registration_missing');
      const loaded = await load({ consumer: q.consumer, job: q.snapshot.observation }, m);
      const { work } = loaded;
      if (!work.adopted || !isDeepStrictEqual(work.bootstrap.covered, joined.covered))
        return m.unavailable('observation_lost');
      let previous: RetainedWindow | undefined;
      let previousEncoded: string | null = null;
      const pageSize = 'purpose' in plan ? plan.size : (plan.pageSize ?? plan.size);
      const allowance = Math.min(600, 6 * pageSize + 3);
      const size = prefix?.size ?? plan.size;
      if (!Number.isInteger(size) || size < 1 || size > Math.min(200, 2 * pageSize + 1))
        throw new TypeError('Invalid retained refill size');
      let after = 'purpose' in plan ? undefined : plan.after;
      let reused: RetainedWindow['raw'] = [];
      if (prefix) {
        if (typeof prefix.execution !== 'string' || !Number.isInteger(prefix.consumed) || prefix.consumed < 0)
          throw new TypeError('Invalid retained consumed prefix');
        const row = (
          await m.sql<{ consumer_window: string | null }>(
            'SELECT consumer_window FROM search.public_filter_execution WHERE (partition_no,observation,id)=($1,$2,$3)',
            [locatorHome(q.snapshot.observation), q.snapshot.observation, prefix.execution],
          )
        ).rows[0];
        if (!row?.consumer_window) return m.unavailable('observation_lost');
        previousEncoded = row.consumer_window;
        previous = decodeState<RetainedWindow>(row.consumer_window);
        if (prefix.consumed > previous.raw.length) throw new TypeError('Consumed prefix exceeds retained execution');
        // Only the actual latest execution may branch; a consumed prefix never admits caller keysets.
        if (work.execution !== prefix.execution) return m.unavailable('observation_lost');
        reused = previous.raw.slice(prefix.consumed);
        after = prefix.consumed === 0 ? previous.before : previous.raw[prefix.consumed - 1]!.sort;
      }
      if ((page?.rounds ?? work.rounds) >= 3 || size > allowance - (page?.charged ?? work.charged)) return preparing();
      if (page) await beginPage(page, q, use, prefix, previousEncoded, allowance);
      const started = page ? { start: page.start! } : await observe(q, null, undefined, m, context);
      if ('blocking' in started && (started.blocking.length || started.unacknowledged.length || started.changed.length))
        return preparing();
      await physical(q, m, context);
      // Reserve this attempt before external dispatch. An uncertain engine result cannot regain allowance.
      const execution = randomUUID();
      if (page) {
        await reservePage(page, use, execution, prefix, size);
        work.rounds = page.rounds;
        work.charged = page.charged;
      } else {
        work.rounds++;
        work.charged += size;
      }
      let encoded = await save(work, loaded.encoded, false, m);
      let raw: RetainedWindow['raw'];
      let exhausted: boolean;
      let total: SearchResult['total'] | undefined;
      if (q.snapshot.kind === 'prepared') {
        if (mixed) return m.unavailable('dependency_unavailable');
        const offset = prefix ? previous!.consumed + prefix.consumed : 0;
        raw = work.prepared.slice(offset, offset + size);
        exhausted = offset + raw.length >= work.prepared.length;
        total = { value: work.prepared.length, relation: 'exact' };
      } else if (reused.length >= size || previous?.exhausted) {
        raw = reused.slice(0, size);
        exhausted = previous!.exhausted && reused.length <= size;
      } else {
        const tail = reused.at(-1)?.sort ?? after;
        if (page) await dispatchPageEngine(page, use, execution);
        const result = await nativeBatch(q, plan, size - reused.length, tail, use, m, context);
        q = result.queried;
        raw = [...reused, ...result.raw];
        exhausted = result.exhausted;
        total = result.total;
      }
      m.cost.candidates += raw.length;
      // Unused reservation is released ONLY after a complete native result; failed work retains its bound.
      work.charged -= size - raw.length;
      let rows: readonly { original: string; terminal: string }[];
      let positions: number[];
      if (mixed) {
        const seen = new Set<string>();
        positions = [];
        const own: { original: string; terminal: string }[] = [];
        for (const [position, item] of raw.entries()) {
          if (!('key' in item)) return m.unavailable('observation_lost');
          // Account records require their own native Source proof in join; Subject cannot certify them.
          if (item.key.owner === 'accounts') {
            const entry = config.registry?.get(item.key.kind);
            if (entry?.owner !== 'accounts') return m.unavailable('dependency_unavailable');
            const snapshot = await entry.source.read(subjectPartition(item.key.id), [item.key.id]);
            m.cost.inputKeys++;
            m.cost.accessPoints++;
            m.cost.dependencyPoints++;
            if (
              snapshot.partition !== subjectPartition(item.key.id) ||
              snapshot.position < BigInt(item.sourcePosition) ||
              snapshot.accounts.length !== 1 ||
              snapshot.accounts[0]!.id !== item.key.id ||
              snapshot.accounts[0]!.revision.toString() !== item.revision
            )
              return preparing();
            own.push({ original: item.key.id, terminal: item.key.id });
            const identity = `accounts:${item.key.id}`;
            if (!seen.has(identity)) {
              positions.push(position);
              seen.add(identity);
            }
            continue;
          }
          const revision = Number(item.revision);
          if (!Number.isSafeInteger(revision)) return m.unavailable('source_pending');
          const checked = await ownRows(
            [
              {
                id: item.key.id,
                index: item.index,
                partition: subjectPartition(item.key.id),
                securityRevision: revision,
                matched: [...item.matched],
                sort: [...item.sort],
              },
            ],
            m,
            context,
          );
          const row = checked.rows[0]!;
          own.push(row);
          const identity = `${item.key.owner}:${row.terminal}`;
          if (!seen.has(identity)) {
            positions.push(position);
            seen.add(identity);
          }
        }
        rows = own;
      } else {
        if (raw.some((hit) => 'key' in hit)) return m.unavailable('observation_lost');
        const checked = await ownRows(raw as SearchResult['hits'], m, context);
        rows = checked.rows;
        positions = checked.accepted;
      }
      const window: RetainedWindow = {
        parent: prefix?.execution ?? null,
        consumed: prefix ? previous!.consumed + prefix.consumed : 0,
        before: after,
        raw,
        exhausted,
        rounds: work.rounds,
        charged: work.charged,
      };
      if (page) {
        page.queried = q;
        await completePage(page, execution, rows, window, size);
      } else {
        const appended = m.take(
          await custody.appendExecution(
            { use, execution: { id: execution, start: started.start, ownRows: rows } },
            context,
          ),
        );
        if (appended.status !== 'appended') return m.unavailable('observation_lost');
        await m.sql(
          'UPDATE search.public_filter_execution SET consumer_window=$4 WHERE (partition_no,observation,id)=($1,$2,$3) AND consumer_window IS NULL',
          [locatorHome(q.snapshot.observation), q.snapshot.observation, execution, encodeState(window)],
        );
      }
      work.queried = q;
      work.execution = execution;
      work.frontier = null;
      encoded = await save(work, encoded, false, m);
      const finalJoined = await join(q, execution, m, context);
      if (
        !isDeepStrictEqual(finalJoined.execution, { id: execution, start: started.start, ownRows: rows }) ||
        !isDeepStrictEqual(finalJoined.covered, joined.covered)
      )
        return m.unavailable('observation_lost');
      if (!page) {
        const final = await observe(q, started.start, execution, m, context);
        if (final.blocking.length || final.unacknowledged.length || final.changed.length) return preparing();
        await physical(q, m, context);
      }
      m.cost.outputSlots += positions.length;
      m.check();
      const retainedWindow = { positions, examined: raw.length, exhausted };
      if (mixed)
        return {
          status: 'queried',
          queried: q,
          execution,
          start: started.start,
          result: {
            ...(plan.generation === undefined ? {} : { generation: plan.generation }),
            hits: positions.map((position) => raw[position] as DiscoveryEngineHit),
          },
          window: retainedWindow,
          cost: m.cost,
        };
      return {
        status: 'queried',
        queried: q,
        execution,
        start: started.start,
        result: {
          ...(plan.generation === undefined ? {} : { generation: plan.generation }),
          hits: positions.map((position) => raw[position] as SearchResult['hits'][number]),
          total: total ?? { value: 0, relation: 'lower_bound' },
        },
        window: retainedWindow,
        cost: m.cost,
      };
    } catch (error) {
      return failure(error, m);
    } finally {
      if (use && page?.use !== use) m.add((await custody.release(use, context)).cost);
    }
  }
  async function readStatus(
    request: Readonly<{ queried: PublicFilterQueriedObservation; execution?: string }>,
    context: PublicFilterConsumerContext,
  ): Promise<PublicFilterConsumerStatus> {
    const input = structuredClone(request);
    const m = meter(context);
    try {
      const joined = await join(input.queried, input.execution, m, context);
      await physical(input.queried, m, context);
      const observation = await observe(input.queried, joined.execution?.start ?? null, input.execution, m, context);
      return {
        status: 'observed',
        queried: joined.queried,
        covered: joined.covered,
        pending: observation.unacknowledged,
        changed: observation.changed,
        blocking: observation.blocking,
        cost: m.cost,
      };
    } catch (error) {
      return failure(error, m);
    }
  }
  async function saveRepair(
    work: ConsumerWork,
    old: string,
    state: RetainedRepairSettlement,
    previous: string | null,
    m: Meter,
  ): Promise<string> {
    const next = encodeState(work);
    if (Buffer.byteLength(next) > 1048576) throw new ConsumerFailure('source_pending');
    const q = work.queried!;
    const saved = await repairSave.run(m.pool, {
      partition_no: work.registration.partition,
      observation: q.snapshot.observation,
      old_work: old,
      next_work: next,
      execution: work.execution!,
      settlement: encodeNative(state),
      previous: previous ?? '',
    });
    if (saved.length !== 1) throw new ConsumerFailure('source_pending');
    m.cost.frontierWrites++;
    return next;
  }
  async function repairStep(input: PublicFilterConsumerJob, context: PublicFilterConsumerContext) {
    const job = structuredClone(input);
    const m = meter(context);
    let use: CustodyUse | undefined;
    try {
      if (!bootstrapBinding(binding)) return m.unavailable('source_pending');
      const loaded = await load(job, m);
      const { work } = loaded;
      let encoded = loaded.encoded;
      if (loaded.registration) {
        const result = await advanceCapture(work, encoded, m, context);
        return result.status === 'captured'
          ? { status: 'settled' as const, job: result.repair, cost: m.cost }
          : result.status === 'preparing'
            ? {
                status: 'progress' as const,
                job: result.repair,
                cost: m.cost,
              }
            : result;
      }
      if (!work.queried) return m.unavailable('observation_lost');
      let q = work.queried;
      const acquired = m.take(await custody.acquire(q, context));
      if (acquired.status !== 'acquired') return m.unavailable('observation_lost');
      use = acquired.use;
      await physical(q, m, context);
      const nativeJoin = await joinNativePublicFilterRepair(binding, { queried: q }, context);
      const joined = nativeJoin ? m.take(nativeJoin) : await join(q, undefined, m, context);
      if (joined.status !== 'joined') return m.unavailable('source_pending');
      if (!isDeepStrictEqual(joined.covered, work.bootstrap.covered)) return m.unavailable('observation_lost');
      if (!work.execution) {
        // Original native preparation must be repairable while its same-row
        // summary is behind. A served population start would require this ACK
        // before the very repair which establishes it. Other bindings preserve
        // their original start behavior; this private native port grants no query.
        const nativeStart = await readNativePublicFilterRepairStart(
          binding,
          {
            bootstrap: work.bootstrap.id,
            queried: q,
          },
          context,
        );
        const started = nativeStart ? m.take(nativeStart) : await observe(q, null, undefined, m, context);
        const execution = randomUUID();
        const appended = m.take(
          await custody.appendExecution(
            {
              use,
              execution: { id: execution, start: started.start, ownRows: [] },
            },
            context,
          ),
        );
        if (appended.status !== 'appended') return m.unavailable('observation_lost');
        work.execution = execution;
        encoded = await save(work, encoded, false, m);
      }
      const retained = m.take(await custody.read({ queried: q, execution: work.execution }, context));
      if (retained.status !== 'found' || !retained.execution) return m.unavailable('observation_lost');
      const current = await repairCurrent.run(m.pool, {
        partition_no: work.registration.partition,
        observation: q.snapshot.observation,
        execution: work.execution,
      });
      if (!current) return m.unavailable('observation_lost');
      let previous = current.repair_settlement;
      let state: RetainedRepairSettlement = previous
        ? decodeNative(previous)
        : {
            id: randomUUID(),
            bootstrap: work.bootstrap.id,
            covered: work.bootstrap.covered,
            execution: retained.execution.id,
            pages: 0,
            frontier: null,
            closed: false,
            fence: null,
          };
      if (
        state.execution !== retained.execution.id ||
        !isDeepStrictEqual(state.covered, retained.covered) ||
        state.bootstrap !== work.bootstrap.id
      )
        return m.unavailable('observation_lost');
      if (!previous) {
        encoded = await saveRepair(work, encoded, state, null, m);
        previous = encodeNative(state);
      }
      if (!state.closed) {
        const keys = {
          partition_no: work.registration.partition,
          observation: q.snapshot.observation,
          execution: work.execution,
          ordinal: state.pages,
        };
        let page = await repairPageSql.run(m.pool, keys);
        let verifiedIntent: RetainedRepairPage | undefined;
        const charge = (cost?: PublicFilterCost) => {
          if (cost) m.add(cost);
          m.check();
        };
        if (!page) {
          const sourcePage = m.take(
            await binding.repairPage(
              {
                bootstrap: work.bootstrap.id,
                queried: q,
                execution: work.execution,
                frontier: state.frontier,
                inputLimit: Math.min(256, Math.max(1, 1000 - m.cost.inputKeys)),
              },
              context,
            ),
          );
          if (sourcePage.status !== 'progress' && sourcePage.status !== 'complete')
            return m.unavailable('source_pending');
          // An actual owner successor resolves both nonempty items and the empty final step.
          // Source callbacks/brands/frontier equality do not certify its original retained window.
          const intent = await verifyPublicFilterRepairSourcePage(
            binding,
            {
              bootstrap: state.bootstrap,
              queried: q,
              execution: work.execution,
              predecessor: state.frontier,
            },
            {
              repairs: sourcePage.repairs,
              frontier: sourcePage.frontier,
              complete: sourcePage.status === 'complete',
            },
            context,
            charge,
          );
          const body = encodeNative(intent);
          await repairPageSave.run(m.pool, {
            ...keys,
            has_repairs: intent.repairs.length > 0 || intent.account !== undefined,
            intent: body,
          });
          page = await repairPageSql.run(m.pool, keys);
          if (!page || page.intent !== body) return m.unavailable('source_pending');
          verifiedIntent = intent;
        }
        const intent =
          verifiedIntent ??
          (await verifyPublicFilterRepairSourcePage(
            binding,
            {
              bootstrap: state.bootstrap,
              queried: q,
              execution: work.execution,
              predecessor: state.frontier,
            },
            decodeNative<RetainedRepairPage>(page.intent),
            context,
            charge,
          ));
        // Foreign owner calls have ended. Reopen and compare immutable local custody before dispatch.
        const finalCustody = m.take(await custody.read({ queried: q, execution: work.execution }, context));
        if (
          finalCustody.status !== 'found' ||
          !isDeepStrictEqual(finalCustody.definition, retained.definition) ||
          !isDeepStrictEqual(finalCustody.covered, retained.covered) ||
          !isDeepStrictEqual(finalCustody.execution, retained.execution)
        )
          return m.unavailable('observation_lost');
        await physical(q, m, context);
        if (intent.predecessor !== state.frontier || (intent.complete ? intent.frontier !== null : !intent.frontier))
          return m.unavailable('source_pending');
        if (!work.repairPage) {
          work.repairPage = {
            repairs: intent.repairs,
            ...(intent.account ? { account: intent.account, accountDone: false } : {}),
            next: 0,
            frontier: intent.frontier,
            complete: intent.complete,
          };
          encoded = await save(work, encoded, false, m);
        } else if (
          !isDeepStrictEqual(work.repairPage.repairs, intent.repairs) ||
          !isDeepStrictEqual(work.repairPage.account, intent.account)
        )
          return m.unavailable('source_pending');
        if (intent.account && !work.repairPage.accountDone) {
          if (intent.repairs.length || work.repair || work.projectionSource || work.records.length)
            return m.unavailable('source_pending');
          const guard = await mixedRepairWriter(q, m);
          const locator = encodeNative({
            observation: q.snapshot.observation,
            execution: work.execution,
            page: state.pages,
            item: 0,
          });
          m.cost.candidates++;
          m.cost.inputKeys++;
          const receipt = await guard.repairAccount(intent.account.id, locator, context);
          if (
            !receipt.account ||
            receipt.owner !== 'accounts' ||
            receipt.epoch !== intent.account.head.epoch ||
            !isDeepStrictEqual({ ...receipt.account, position: intent.account.position }, intent.account) ||
            receipt.sourcePosition < intent.account.position ||
            receipt.incarnation !== q.consumer.incarnation
          )
            return m.unavailable('source_pending');
          await physical(q, m, context);
          const effect = { ...keys, page: state.pages, item: 0 };
          const body = encodeNative(receipt);
          await repairEffectSave.run(m.pool, { ...effect, receipt: body });
          const saved = await repairEffectSql.run(m.pool, effect);
          if (!saved || saved.receipt !== body) return m.unavailable('source_pending');
          work.repairPage.accountDone = true;
          encoded = await save(work, encoded, false, m);
        }
        while (work.repairPage.next < work.repairPage.repairs.length) {
          const repair = work.repair ?? work.repairPage.repairs[work.repairPage.next]!;
          encoded = await applyRepair(repair, work, state.pages, encoded, m, context);
        }
        const complete = intent.complete;
        if (complete && (work.projectionSource || work.records.length || work.repair || work.dispatch))
          return m.unavailable('source_pending');
        work.frontier = intent.frontier;
        work.repairPage = null;
        state = {
          ...state,
          pages: state.pages + 1,
          frontier: intent.frontier,
          closed: complete,
        };
        encoded = await saveRepair(work, encoded, state, previous, m);
        if (!complete) return { status: 'progress' as const, job, cost: m.cost };
      }
      // The canonical reader is the native guard. FAA's separate settle joins its own Source verifier.
      const nativeSettlement = m.take(
        await withPublicFilterRepairAllowance(m.cost, () =>
          readPublicFilterRepairSettlement(config.pool, { queried: q, execution: work.execution! }, context),
        ),
      );
      if (nativeSettlement.status !== 'settled') return m.unavailable('source_pending');
      const settled = m.take(
        await withPublicFilterRepairAllowance(m.cost, () =>
          binding.settle({ bootstrap: work.bootstrap.id, queried: q, execution: work.execution! }, context),
        ),
      );
      if (settled.status !== 'joined') return m.unavailable('source_pending');
      if (!isDeepStrictEqual(settled.covered, work.bootstrap.covered) || settled.execution?.id !== work.execution)
        return m.unavailable('observation_lost');
      // settle verifies canonical Source receipts AND Search dispatch/copy/visibility, including FOREIGN work.
      const final = await observe(q, settled.execution.start, work.execution, m, context);
      if (final.blocking.length || final.unacknowledged.length) return m.unavailable('source_pending');
      // Changed-since-start remains a disclosure barrier for the old execution in query/readStatus.
      // It does not undo genuinely completed repair; settled is only a maintenance diagnostic.
      return { status: 'settled' as const, job, cost: m.cost };
    } catch (error) {
      return failure(error, m);
    } finally {
      if (use) m.add((await custody.release(use, context)).cost);
    }
  }
  async function mixedRepairWriter(q: PublicFilterQueriedObservation, m: Meter) {
    const origin = publicFilterSourceOrigin(config.source);
    const mixedTarget = /^(.*)discovery-g([1-9][0-9]*)$/.exec(target);
    if (!origin || !mixedTarget) throw new ConsumerFailure('source_pending');
    if (!config.registry) throw new ConsumerFailure('dependency_unavailable');
    await mixedGeneration(m);
    const generation = Number(mixedTarget[2]);
    const prefix = mixedTarget[1]!;
    const row = (
      await m.sql<{ uuid: string; incarnation: string }>(
        `SELECT index_uuid AS uuid,incarnation::text FROM search.discovery_generation
         WHERE partition_no=0 AND prefix=$1 AND generation=$2 AND state IN ('ready','active')`,
        [prefix, generation],
      )
    ).rows[0];
    if (!row?.uuid || row.uuid !== q.consumer.incarnation) throw new ConsumerFailure('incarnation_changed');
    const registry = await nativeDiscoveryRegistry(
      m.pool,
      origin.routeKey,
      createRatedSubjectSource(m.pool, origin.routeKey).source,
      { release: config.meaning.release },
    );
    return createDiscoveryRepairWriter({
      pool: m.pool,
      search: m.native,
      consumer: discoveryConsumer(prefix, generation),
      projection: createDiscoveryProjection({
        pool: m.pool,
        search: m.native,
        registry,
        listing: subjectListingSource(m.pool),
        target: { prefix, generation, uuid: row.uuid, incarnation: row.incarnation },
      }),
    });
  }
  async function applyRepair(
    repair: RetainedSourceRepair,
    work: ConsumerWork,
    page: number,
    encoded: string,
    m: Meter,
    context: PublicFilterConsumerContext,
  ): Promise<string> {
    const q = work.queried!;
    const projection = repair.projection;
    if (
      (projection.status !== 'complete' && projection.status !== 'progress') ||
      !isDeepStrictEqual(projection.source, repair.source) ||
      repair.source.subject !== repair.locator.subject ||
      repair.source.partition !== subjectPartition(repair.source.subject) ||
      (work.projectionSource && !isDeepStrictEqual(work.projectionSource, repair.source))
    )
      throw new ConsumerFailure('source_pending');
    const recovering = work.repair !== null;
    work.projectionSource = repair.source;
    work.repair = structuredClone(repair);
    if (!recovering) work.records.push(...projection.records);
    encoded = await save(work, encoded, false, m);
    if (projection.status === 'progress') {
      work.repair = null;
      work.repairPage!.next++;
      return save(work, encoded, false, m);
    }
    if (work.records.some((row) => row.indexed === null)) throw new ConsumerFailure('source_pending');
    const origin = publicFilterSourceOrigin(config.source);
    const subjectTarget = /^(.*)subjects-g([1-9][0-9]*)$/.exec(target);
    const mixedTarget = /^(.*)discovery-g([1-9][0-9]*)$/.exec(target);
    if (!origin || (!subjectTarget && !mixedTarget)) throw new ConsumerFailure('source_pending');
    let guard:
      | Pick<ReturnType<typeof createSearchWriterGuard>, 'repair'>
      | ReturnType<typeof createDiscoveryRepairWriter>;
    if (mixedTarget) {
      guard = await mixedRepairWriter(q, m);
    } else {
      if (!subjectTarget) throw new ConsumerFailure('source_pending');
      guard = createSearchWriterGuard({
        pool: m.pool,
        search: m.native,
        index: target,
        consumer: subjectConsumer(subjectTarget[1]!, Number(subjectTarget[2])),
        source: createRatedSubjectSource(m.pool, origin.routeKey).source,
        listing: subjectListingSource(m.pool),
      });
    }
    const locator = encodeNative({
      observation: q.snapshot.observation,
      execution: work.execution,
      page,
      item: work.repairPage!.next,
    });
    m.cost.inputKeys++;
    m.cost.candidates++;
    m.cost.accessPoints++;
    m.cost.dependencyPoints++;
    let receipt: PublicFilterRepairWriterReceipt;
    try {
      receipt = await guard.repair(repair.source.subject, repair.source.position, locator, context);
    } catch (error) {
      if (error instanceof TypeError || error instanceof RangeError) throw error;
      throw new ConsumerFailure('source_pending');
    }
    if (
      receipt.epoch !== repair.source.epoch ||
      receipt.incarnation !== q.consumer.incarnation ||
      repairWriterPosition(receipt) < repair.source.position
    )
      throw new ConsumerFailure('source_pending');
    await physical(q, m, context);
    const body = encodeNative(receipt);
    const keys = {
      partition_no: work.registration.partition,
      observation: q.snapshot.observation,
      execution: work.execution!,
      page,
      item: work.repairPage!.next,
    };
    await repairEffectSave.run(m.pool, { ...keys, receipt: body });
    const retained = await repairEffectSql.run(m.pool, keys);
    if (!retained || retained.receipt !== body) throw new ConsumerFailure('source_pending');
    work.repair = null;
    work.dispatch = null;
    work.records = [];
    work.projectionSource = null;
    work.repairPage!.next++;
    return save(work, encoded, false, m);
  }
  async function captureForPage(
    request: Readonly<{ plan: PublicCanonicalCaptureInput; snapshot: 'pit' | 'prepared' }>,
    incoming: PublicFilterConsumerContext,
  ): Promise<PublicFilterConsumerCapture> {
    const context = Object.freeze({ deadline: incoming.deadline });
    const page = newPage(context);
    const result = await capturePlan(request.plan, request.snapshot, context, page);
    // The public report must not alias the private meter that will fund query,
    // own rows, all refills and finalization. Recognition is one-shot and native.
    const reported = { ...result, cost: Object.freeze({ ...result.cost }) };
    if (reported.status === 'captured') {
      page.queried = structuredClone(reported.queried);
      captures.set(reported, page);
    }
    return reported;
  }
  const operations: PublicDiscoveryConsumerOperations = {
    capture(request, context) {
      const copied = structuredClone(request);
      return track(() => captureForPage(copied, context));
    },
    captureDiscovery(request, context) {
      const copied = structuredClone(request);
      return track(() => captureForPage(copied, context));
    },
    query(q, context, refill) {
      return standalone(q, context, refill, false) as Promise<PublicFilterConsumerQuery>;
    },
    queryDiscovery(q, context, refill) {
      return standalone(q, context, refill, true) as Promise<DiscoveryConsumerQuery>;
    },
    repairStep(job, context) {
      return track(() => repairStep(job, { deadline: context.deadline }));
    },
    readStatus(request, context) {
      return track(() => readStatus(request, { deadline: context.deadline }));
    },
    closeObservation(input, context) {
      const q = structuredClone(input);
      return track(async () => {
        const result = await custody.closeObservation(q, config.search, { deadline: context.deadline });
        if (result.status !== 'closed') throw new ConsumerFailure('observation_lost');
        owned.delete(q.snapshot.observation);
        if (bootstrapBinding(binding)) {
          const m = meter(context);
          const row = (
            await m.sql<{ consumer_work: string | null }>(
              'SELECT consumer_work FROM search.public_filter_observation WHERE (partition_no,observation)=($1,$2)',
              [locatorHome(q.snapshot.observation), q.snapshot.observation],
            )
          ).rows[0];
          if (row?.consumer_work)
            await binding.abort({ bootstrap: decodeState<ConsumerWork>(row.consumer_work).bootstrap.id }, context);
        }
      });
    },
    close() {
      if (closing) return closing;
      closed = true;
      return (closing = (async () => {
        await Promise.allSettled([...pending]);
        const context = { deadline: Date.now() + 300_000 };
        const results = await Promise.allSettled(
          [...owned.values()].map((q) => custody.closeObservation(q, config.search, context)),
        );
        await custody.close();
        for (const result of results) {
          if (result.status === 'rejected') throw result.reason;
          if (result.value.status !== 'closed') throw new ConsumerFailure('observation_lost');
        }
        owned.clear();
      })());
    },
  };
  function openPage(
    incoming: PublicFilterConsumerContext,
    capture?: Extract<PublicFilterConsumerCapture, { status: 'captured' }>,
  ) {
    const retained = capture === undefined ? undefined : captures.get(capture);
    if (capture !== undefined) {
      if (!retained || retained.context.deadline !== incoming.deadline) throw new ConsumerFailure('observation_lost');
      captures.delete(capture);
    }
    const page = retained ?? newPage(Object.freeze({ deadline: incoming.deadline }));
    const context = page.context;
    async function run<T>(body: () => Promise<T>): Promise<T> {
      if (page.busy || page.failed || page.finished || page.disposed) throw new ConsumerFailure('observation_lost');
      page.busy = true;
      try {
        return await track(body);
      } catch (error) {
        page.failed = true;
        throw error;
      } finally {
        page.busy = false;
      }
    }
    async function query(
      q: PublicFilterQueriedObservation,
      refill: PublicFilterConsumerRefill | undefined,
      mixed: boolean,
    ) {
      return run(async () => {
        const result = await queryPlan(q, context, refill, mixed, page);
        if (result.status !== 'queried') page.failed = true;
        return result;
      });
    }
    return {
      failure: (error: unknown) => failure(error, page.m),
      capture: (plan: PublicCanonicalCaptureInput, snapshot: 'pit' | 'prepared') =>
        run(async () => {
          if (page.id !== null || page.queried !== null) throw new ConsumerFailure('observation_lost');
          const result = await capturePlan(plan, snapshot, context, page);
          if (result.status === 'captured') page.queried = result.queried;
          else page.failed = true;
          return result;
        }),
      query: (q: PublicFilterQueriedObservation, refill?: PublicFilterConsumerRefill) =>
        query(q, refill, false) as Promise<PublicFilterConsumerQuery>,
      queryDiscovery: (q: PublicFilterQueriedObservation, refill?: PublicFilterConsumerRefill) =>
        query(q, refill, true) as Promise<DiscoveryConsumerQuery>,
      consume: (execution: string, consumed: number) =>
        run(async () => {
          if (
            !page.id ||
            !page.queried ||
            page.tail !== execution ||
            !Number.isSafeInteger(consumed) ||
            consumed < 0 ||
            consumed > 200
          )
            throw new ConsumerFailure('observation_lost');
          const result = await pageSql(
            page,
            { points: 3, keys: 6, writes: 1 },
            `WITH locked AS MATERIALIZED (
            SELECT p.partition_no,p.id FROM search.public_filter_coverage_page p
            JOIN search.public_filter_execution e ON (e.partition_no,e.observation,e.id)=(p.partition_no,p.observation,p.tail)
            WHERE (p.partition_no,p.id)=($1,$2) AND p.state='open' AND p.pending IS NULL
              AND p.tail=$3 AND p.tail_consumed IS NULL AND e.page_id=p.id AND e.page_status='complete'
              AND $4::integer<=e.page_raw
            FOR UPDATE OF p)
          UPDATE search.public_filter_coverage_page p SET tail_consumed=$4,revision=p.revision+1,work=$5
          FROM locked l WHERE (p.partition_no,p.id)=(l.partition_no,l.id) RETURNING p.id`,
            () => [
              locatorHome(page.queried!.snapshot.observation),
              page.id,
              execution,
              consumed,
              encodeState(page.m.cost),
            ],
          );
          if (result.rowCount !== 1) throw new ConsumerFailure('observation_lost');
        }),
      finish: () =>
        run(async () => {
          if (!page.queried || !page.id || !page.start || !page.tail || page.rounds < 1)
            throw new ConsumerFailure('observation_lost');
          // Last physical/copy check belongs before the CURRENT Source role. No
          // dependent native/owner work is allowed after that role succeeds.
          await physical(page.queried, page.m, context);
          const sealed = await pageSql(
            page,
            { points: 1, keys: 2, writes: 1 },
            `UPDATE search.public_filter_coverage_page SET state='sealed',revision=revision+1,work=$5
           WHERE (partition_no,id)=($1,$2) AND state='open' AND pending IS NULL AND tail=$3 AND tail_consumed IS NOT NULL
             AND deadline=$4 RETURNING id`,
            () => [
              locatorHome(page.queried!.snapshot.observation),
              page.id,
              page.tail,
              context.deadline,
              encodeState(page.m.cost),
            ],
          );
          if (sealed.rowCount !== 1) throw new ConsumerFailure('observation_lost');
          const final = await observe(page.queried, page.start, page.tail, page.m, context);
          if (final.blocking.length || final.unacknowledged.length || final.changed.length)
            throw new ConsumerFailure('source_pending');
          page.m.check();
          page.finished = true;
        }),
      async dispose() {
        if (page.busy) throw new ConsumerFailure('observation_lost');
        if (page.disposed) return;
        page.disposed = true;
        try {
          if (!page.finished && page.id) {
            // A lost result retains pending and every attempted child. Cleanup
            // never clears an uncertain dispatch, extends time or grants coverage.
            await pageSql(
              page,
              { points: 1, keys: 2, writes: 1 },
              `UPDATE search.public_filter_coverage_page SET state='failed',revision=revision+1,work=$3
             WHERE (partition_no,id)=($1,$2) AND state IN ('planned','open','sealed') RETURNING id`,
              () => [locatorHome(page.queried!.snapshot.observation), page.id, encodeState(page.m.cost)],
            );
          }
        } finally {
          if (page.use) {
            const use = page.use;
            page.use = null;
            page.m.add((await custody.release(use, context)).cost);
            page.m.check();
          }
        }
      },
    };
  }
  async function standalone(
    q: PublicFilterQueriedObservation,
    context: PublicFilterConsumerContext,
    refill: PublicFilterConsumerRefill | undefined,
    mixed: boolean,
  ) {
    const page = openPage(Object.freeze({ deadline: context.deadline }));
    try {
      const result = mixed ? await page.queryDiscovery(q, refill) : await page.query(q, refill);
      if (result.status === 'queried') {
        await page.consume(result.execution, result.window.examined);
        await page.finish();
      }
      return result;
    } catch (error) {
      return page.failure(error);
    } finally {
      await page.dispose();
    }
  }
  installPublicFilterCoveragePage(operations, openPage);
  return operations;
};
