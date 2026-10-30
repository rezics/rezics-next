import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { publicFilterSourceOrigin } from './public-filter-source.ts';
import { readRelease, freeze } from './definitions.ts';
import { withRequestDeadline } from '../request/deadline.ts';
import { classifyUnavailability } from '../access/unavailable.ts';
import registerSource from './public-filter-source-binding-register.sql';
import defineSource from './public-filter-source-binding-define.sql';
import readDefinition from './public-filter-source-binding-definition.sql';
import type { Pool, PoolClient } from 'pg';
import { releaseDigest } from '@rezics/definitions';
import { admitFilter, walkFilter } from '@rezics/filter';
import type { Access } from '../request/access.ts';
import type { CustodyDefinition } from '../search/public-filter-custody-contract.ts';
import { compileFilter } from '../search/filter.ts';
import { compileText } from '../search/text.ts';
import { validateSearchAfter } from '../search/query-payload.ts';
import { compileDiscoveryConsumerCapture, type DiscoveryConsumerCaptureInput } from '../search/discovery.ts';
import { validatePublicSuggestionInput } from '../search/public-suggestion-input.ts';
import { readPublicFilterConsumerCustody } from '../search/public-filter-custody.ts';
import type { PublicFilterConsumerCaptureInput, PublicFilterConsumerContext, PublicCanonicalCaptureInput,
  PublicFilterConsumerUnavailable, PublicFilterQueriedObservation, PublicSuggestionCaptureInput,
} from '../search/public-filter-consumer-contract.ts';
import type { PublicFilterCost, PublicFilterDependencyKey, PublicFilterProjectionMeaning, PublicFilterSource,
  PublicFilterConsumer, PublicFilterProjectionObservation, PublicFilterProjectionPage, PublicFilterRepairLocator,
  PrivacyReductionStart, PrivacyReductionObservation, PrivacyReductionObservationRequest,
} from './public-filter-source-contract.ts';
/** Agreed additive native binding handoff. The Source producer owns all implementation. */
export type JoinedPopulationRequest =
  | Readonly<{ kind: 'queried'; phase: 'start' | 'status'; queried: PublicFilterQueriedObservation }>
  | Readonly<{
      kind: 'queried';
      phase: 'final';
      queried: PublicFilterQueriedObservation;
      execution: string;
    }>;

export interface PublicFilterNativeSource extends PublicFilterSource {
  resolvePublicFilterDefinition(
    request: Readonly<{ meaning: PublicFilterProjectionMeaning; capture: PublicCanonicalCaptureInput }>,
    context: PublicFilterConsumerContext,
  ): Promise<
    | Readonly<{ status: 'bound'; definition: CustodyDefinition<PublicCanonicalCaptureInput>; cost: PublicFilterCost }>
    | PublicFilterConsumerUnavailable
  >;
  readPrivacyReductionHeads(request: PrivacyReductionObservationRequest): Promise<PrivacyReductionObservation>;
  readPrivacyReductionHeads(
    request: JoinedPopulationRequest,
    context: PublicFilterConsumerContext,
  ): Promise<PrivacyReductionObservation>;
}

export type { PublicFilterQueriedObservation } from '../search/public-filter-consumer-contract.ts';
export type NativePublicSource = Readonly<{
  id: string;
  partition: number;
  epoch: number;
  configuration: string;
}>;
/** Immutable root input. Refill size/frontier belongs to Search's retained execution lineage. */
export type PublicFilterSourceCaptureInput =
  | PublicFilterConsumerCaptureInput
  | DiscoveryConsumerCaptureInput
  | PublicSuggestionCaptureInput;
export type PublicSourceCaptureInput = PublicFilterSourceCaptureInput;
export type PublicFilterSourceDefinition = Readonly<{
  source: NativePublicSource;
  readDefinition: string;
  meaning: PublicFilterProjectionMeaning;
  capture: PublicFilterSourceCaptureInput;
  dependencyKeys: readonly PublicFilterDependencyKey[];
}>;
export type PublicFilterBindingFailure = Readonly<{
  status: 'unready' | 'unavailable';
  reason:
    | 'source_missing'
    | 'configuration_changed'
    | 'definition_missing'
    | 'observation_lost'
    | 'execution_missing'
    | 'binding_mismatch'
    | 'owner_unavailable'
    | 'identity_pending'
    | 'deadline';
  cost: PublicFilterCost;
}>;
export type PublicFilterSourceBinding = Readonly<{
  resolve(
    request: Readonly<{
      source: PublicFilterSource;
      meaning: PublicFilterProjectionMeaning;
      capture: PublicFilterSourceCaptureInput;
    }>,
    context: PublicFilterConsumerContext,
  ): Promise<
    | Readonly<{ status: 'resolved'; definition: PublicFilterSourceDefinition; cost: PublicFilterCost }>
    | PublicFilterBindingFailure
  >;
  join(
    request: Readonly<{
      queried: PublicFilterQueriedObservation;
      execution?: string;
    }>,
    context: PublicFilterConsumerContext,
  ): Promise<
    | Readonly<{
        status: 'joined';
        definition: PublicFilterSourceDefinition;
        queried: PublicFilterQueriedObservation;
        covered: PrivacyReductionStart;
        execution: Readonly<{
          id: string;
          start: PrivacyReductionStart;
          ownRows: readonly Readonly<{ original: string; terminal: string }>[];
        }> | null;
        cost: PublicFilterCost;
      }>
    | PublicFilterBindingFailure
  >;
}>;

/** Source-owned bootstrap state; the consumer and retained observation remain Search-owned. */
export type PublicSourceBootstrap = Readonly<{
  id: string;
  definition: PublicFilterSourceDefinition;
  consumer: PublicFilterConsumer;
  snapshot: 'pit' | 'prepared';
  covered: PrivacyReductionStart;
}>;
export type PublicSourceBootstrapResult =
  | Readonly<{ status: 'begun'; bootstrap: PublicSourceBootstrap; cost: PublicFilterCost }>
  | PublicFilterBindingFailure;
export type PublicSourceBootstrapRecovery =
  | Readonly<{ status: 'begun'; bootstrap: PublicSourceBootstrap; queried: null; cost: PublicFilterCost }>
  | Readonly<{
      status: 'adopted';
      bootstrap: PublicSourceBootstrap;
      queried: PublicFilterQueriedObservation;
      cost: PublicFilterCost;
    }>
  | Readonly<{ status: 'pending'; cost: PublicFilterCost }>
  | PublicFilterBindingFailure;
declare const nativeSourceRepairReceipt: unique symbol;
export type NativeSourceRepairReceipt = Readonly<{ [nativeSourceRepairReceipt]: true }>;
export type PublicSourceRepair = Readonly<{
  kind: 'local' | 'foreign';
  locator: PublicFilterRepairLocator;
  source: PublicFilterProjectionObservation;
  projection: PublicFilterProjectionPage;
  receipt: NativeSourceRepairReceipt;
}>;
export type PublicSourceRepairPage =
  | Readonly<{ status: 'progress'; repairs: readonly PublicSourceRepair[]; frontier: string; cost: PublicFilterCost }>
  | Readonly<{ status: 'complete'; repairs: readonly PublicSourceRepair[]; frontier: null; cost: PublicFilterCost }>
  | PublicFilterBindingFailure;
export type PublicFilterSourceBootstrapBinding = PublicFilterSourceBinding &
  Readonly<{
    begin(
      request: Readonly<{
        source: PublicFilterSource;
        meaning: PublicFilterProjectionMeaning;
        capture: PublicFilterSourceCaptureInput;
        consumer: PublicFilterConsumer;
        snapshot: 'pit' | 'prepared';
      }>,
      context: PublicFilterConsumerContext,
    ): Promise<PublicSourceBootstrapResult>;
    adopt(
      request: Readonly<{ bootstrap: string; queried: PublicFilterQueriedObservation }>,
      context: PublicFilterConsumerContext,
    ): Promise<
      | Readonly<{ status: 'adopted'; bootstrap: PublicSourceBootstrap; queried: PublicFilterQueriedObservation; cost: PublicFilterCost }>
      | PublicFilterBindingFailure
    >;
    abort(
      request: Readonly<{ bootstrap: string }>,
      context: PublicFilterConsumerContext,
    ): Promise<Readonly<{ status: 'aborted' | 'pending'; cost: PublicFilterCost }> | PublicFilterBindingFailure>;
    recover(request: Readonly<{ bootstrap: string }>, context: PublicFilterConsumerContext): Promise<PublicSourceBootstrapRecovery>;
    repairPage(
      request: Readonly<{
        bootstrap: string;
        queried: PublicFilterQueriedObservation;
        execution: string;
        frontier: string | null;
        inputLimit: number;
      }>,
      context: PublicFilterConsumerContext,
    ): Promise<PublicSourceRepairPage>;
    settle(
      request: Readonly<{ bootstrap: string; queried: PublicFilterQueriedObservation; execution: string }>,
      context: PublicFilterConsumerContext,
    ): ReturnType<PublicFilterSourceBinding['join']>;
  }>;

type BindingCost = { -readonly [K in keyof PublicFilterCost]: number } & {
  statements: number; rows: number; bytes: number;
};
function publicFilterBindingCost(): BindingCost {
  return { statements: 0, rows: 0, bytes: 0, inputKeys: 0, candidates: 0, accessPoints: 0,
    dependencyPoints: 0, engineSearches: 0, engineIteratorSteps: 0, outputSlots: 0,
    resultWrites: 0, frontierWrites: 0 };
}
function addCost(target: BindingCost, value: PublicFilterCost): void {
  for (const key of Object.keys(target) as (keyof BindingCost)[]) {
    const amount = (value as Partial<BindingCost>)[key];
    if (amount !== undefined) target[key] += amount;
  }
}
// Tagged, sorted encoding preserves explicit undefined and bigint without reserving caller JSON keys.
function encode(value: unknown): string {
  function pack(entry: unknown): unknown {
    if (entry === undefined) return ['undefined'];
    if (typeof entry === 'bigint') return ['bigint', String(entry)];
    if (Array.isArray(entry)) return ['array', entry.map(pack)];
    if (entry !== null && typeof entry === 'object')
      return ['object', Object.keys(entry).sort().map(key => [key, pack((entry as Record<string, unknown>)[key])])];
    if (typeof entry === 'number' && !Number.isFinite(entry)) throw new TypeError('Finite input required');
    if (typeof entry === 'function' || typeof entry === 'symbol') throw new TypeError('Data input required');
    return ['value', entry];
  }
  return JSON.stringify(pack(value));
}
function decode<T>(value: string): T {
  function unpack(entry: any): unknown {
    if (entry[0] === 'undefined') return undefined;
    if (entry[0] === 'bigint') return BigInt(entry[1]);
    if (entry[0] === 'array') return entry[1].map(unpack);
    if (entry[0] === 'object') return Object.fromEntries(entry[1].map(([key, child]: [string, unknown]) => [key, unpack(child)]));
    if (entry[0] === 'value') return entry[1];
    throw new TypeError('Invalid stored Source data');
  }
  return unpack(JSON.parse(value)) as T;
}
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
class BindingError extends Error {
  constructor(readonly reason: PublicFilterBindingFailure['reason']) { super(reason); }
}
function checkDeadline(context: PublicFilterConsumerContext): void {
  if (!Number.isFinite(context.deadline) || context.deadline <= Date.now()) throw new BindingError('deadline');
}
/** Charge native release lookups as well as Source SQL, including failed submissions. */
function measuredPool(pool: Pool, cost: BindingCost): Pool {
  return new Proxy(pool, { get(target, key) {
    if (key === 'query') return async (text: string, values?: unknown[]) => {
      cost.statements++; cost.inputKeys += values?.length ?? 0;
      cost.bytes += Buffer.byteLength(text) + Buffer.byteLength(encode(values));
      const result = await target.query(text, values);
      cost.rows += result.rowCount ?? 0; cost.dependencyPoints += result.rowCount ?? 0;
      cost.bytes += Buffer.byteLength(encode(result.rows));
      if (/\b(INSERT|UPDATE|DELETE)\b/.test(text)) cost.resultWrites += result.rowCount ?? 0;
      return result;
    };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}
/** Shared constructor validation; routing is the existing native routeKey, never a callback. */
function validatePublicFilterBindingConfiguration(pool: Pool, routing: Uint8Array, access: Access): void {
  if (!pool || typeof pool.connect !== 'function' || typeof pool.query !== 'function')
    throw new TypeError('A native pool is required');
  if (!(routing instanceof Uint8Array) || routing.byteLength < 32)
    throw new TypeError('Route key must contain at least 32 bytes');
  if (!access || typeof access.authorize !== 'function' || typeof access.authenticate !== 'function')
    throw new TypeError('A native Access instance is required');
}

/** Only the admitted shared tree and existing compilers determine dependency closure. */
function captureKeys(meaning: PublicFilterProjectionMeaning, input: PublicFilterConsumerCaptureInput) {
  if (meaning.digest !== releaseDigest(meaning.release) || !meaning.release.types[meaning.type])
    throw new TypeError('Unknown projection meaning');
  if (
    !Object.hasOwn(input, 'filterDocument') ||
    !Object.hasOwn(input, 'text') ||
    !Number.isInteger(input.size) ||
    input.size < 1 ||
    input.size > 200 ||
    !['id', 'name', 'relevance', 'collections', 'rating'].includes(input.sort)
  )
    throw new TypeError('Complete capture input is required');
  // Rating's phased tuple is admitted by its existing native planner, not ordinary search_after.
  // Native rating/generation metadata cannot be verified until the producer registration is available.
  if (input.sort !== 'rating') validateSearchAfter(input);
  if (input.filterDocument !== undefined) {
    for (const node of walkFilter(input.filterDocument))
      if ('owner' in node || 'saved' in node) throw new TypeError('Only expanded public filters may bind');
    const admitted = admitFilter(input.filterDocument, meaning.release);
    if (!isDeepStrictEqual(admitted, input.filterDocument)) throw new TypeError('Capture must already be admitted');
  }
  const filter =
    input.filterDocument === undefined
      ? undefined
      : compileFilter(input.filterDocument, { prefix: 'f', relationOverflow: true });
  const text = input.text === undefined ? undefined : compileText(input.text, { field: 'search_text', prefix: 't' });
  const overflowProperties = filter
    ? [...new Set(filter.leaves.flatMap((leaf) => (leaf.facet === 'statement' ? [leaf.property] : [])))]
    : undefined;
  for (const [key, value] of Object.entries({
    filter: filter?.query,
    query: text?.query,
    boost: text?.leaves
      .filter((leaf) => !leaf.negated)
      .map((leaf) => leaf.value)
      .join(' '),
    overflowProperties,
  })) {
    if (Object.hasOwn(input, key) && !isDeepStrictEqual(input[key as keyof typeof input], value))
      throw new TypeError('Compiled capture differs from its retained input');
  }
  const keys: PublicFilterDependencyKey[] = [
    { kind: 'order', order: input.sort },
    { kind: 'type' },
    { kind: 'field', field: 'id' },
  ];
  for (const leaf of filter?.leaves ?? []) {
    if (leaf.facet === 'type') keys.push({ kind: 'type' });
    else {
      keys.push({ kind: 'property', property: leaf.property });
      for (const qualifier of leaf.qualifiers ?? []) keys.push({ kind: 'property', property: qualifier.property });
    }
  }
  if (text)
    keys.push(...(['labels', 'aliases', 'descriptions'] as const).map((field) => ({ kind: 'field' as const, field })));
  if (['name', 'collections', 'rating'].includes(input.sort)) keys.push({ kind: 'field', field: 'name_sort' });
  if (input.sort === 'collections') keys.push({ kind: 'function', input: 'public_collection_count' });
  if (input.sort === 'rating') keys.push({ kind: 'function', input: 'public_rating' });
  return keys.filter((key, index) => keys.findIndex((other) => isDeepStrictEqual(key, other)) === index);
}

function allCaptureKeys(meaning: PublicFilterProjectionMeaning, input: PublicSourceCaptureInput): PublicFilterDependencyKey[] {
  if (meaning.digest !== releaseDigest(meaning.release) || !meaning.release.types[meaning.type])
    throw new TypeError('Unknown native meaning');
  let keys: readonly PublicFilterDependencyKey[];
  if ('purpose' in input) {
    validatePublicSuggestionInput(input);
    keys = [{kind: 'type'}, {kind: 'field', field: 'id'}, {kind: 'field', field: 'labels'},
      {kind: 'field', field: 'aliases'}, {kind: 'field', field: 'name_sort'},
      {kind: 'order', order: 'name'}, {kind: 'order', order: 'id'}];
  } else if ('representation' in input) {
    keys = [...compileDiscoveryConsumerCapture(input, meaning, undefined).dependencyKeys,
      {kind: 'field', field: 'id'},
      ...(input.sort === 'name' ? [{kind: 'field' as const, field: 'name_sort' as const},
        {kind: 'field' as const, field: 'labels' as const}, {kind: 'field' as const, field: 'aliases' as const}] : [])];
  } else keys = captureKeys(meaning, input);
  return keys.filter((key, i) => keys.findIndex(other => isDeepStrictEqual(key, other)) === i);
}

/** Native Source-owned registration; the origin association only locates the constructor configuration. */
export function createPublicFilterSourceBinding(
  pool: Pool, routing: Uint8Array, access: Access,
): PublicFilterSourceBootstrapBinding {
  validatePublicFilterBindingConfiguration(pool, routing, access);
  const routeDigest = hash(new Uint8Array(routing));
  const fail = (reason: PublicFilterBindingFailure['reason'], cost: PublicFilterCost = publicFilterBindingCost()): PublicFilterBindingFailure =>
    ({ status: ['source_missing', 'definition_missing', 'identity_pending'].includes(reason) ? 'unready' : 'unavailable', reason, cost });
  async function run<T>(context: PublicFilterConsumerContext, work: (cost: BindingCost, db: Pool) => Promise<T>): Promise<T | PublicFilterBindingFailure> {
    const cost = publicFilterBindingCost();
    const deadline = context.deadline;
    try {
      checkDeadline({deadline});
      const result = await withRequestDeadline(deadline, () => work(cost, measuredPool(pool, cost)));
      checkDeadline({deadline});
      return result;
    } catch (error) {
      if (error instanceof BindingError) return fail(error.reason, cost);
      if (error instanceof TypeError || error instanceof RangeError) return fail('binding_mismatch', cost);
      const reason = classifyUnavailability(error);
      if (reason !== undefined || (error && typeof error === 'object' && 'code' in error))
        return fail(Date.now() >= deadline ? 'deadline' : 'owner_unavailable', cost);
      throw error;
    }
  }
  async function loadDefinition(id: string, db: Pool): Promise<PublicFilterSourceDefinition> {
    if (!uuid.test(id)) throw new BindingError('definition_missing');
    const row = await readDefinition.run(db, {read_definition: id});
    if (!row) throw new BindingError('definition_missing');
    if (row.route_digest !== routeDigest) throw new BindingError('configuration_changed');
    const release = await readRelease(db, row.release_digest);
    if (!release || !release.types[row.subject_type]) throw new BindingError('definition_missing');
    const capture = decode<PublicSourceCaptureInput>(row.capture);
    const meaning = {digest: row.release_digest, release, type: row.subject_type};
    const keys = allCaptureKeys(meaning, capture);
    if (!isDeepStrictEqual(keys, row.dependency_keys)) throw new BindingError('binding_mismatch');
    return {source: {id: row.source_id, partition: 0, epoch: row.owner_epoch, configuration: row.configuration},
      readDefinition: id, meaning, capture, dependencyKeys: keys};
  }
  const binding: PublicFilterSourceBinding = {
    async resolve(request, context) {
      // Capture all caller data and constructor identity before the first suspension.
      let meaning: PublicFilterProjectionMeaning, capture: PublicSourceCaptureInput;
      const origin = publicFilterSourceOrigin(request.source);
      if (!origin || origin.pool !== pool || origin.access !== access || hash(origin.routeKey) !== routeDigest)
        return fail('source_missing');
      try { meaning = structuredClone(request.meaning); capture = structuredClone(request.capture); }
      catch { return fail('binding_mismatch'); }
      return run(context, async (cost, db) => {
        const keys = allCaptureKeys(meaning, capture);
        const encoded = encode(capture);
        if (Buffer.byteLength(encoded) > 1048576) throw new BindingError('binding_mismatch');
        // Caller digest equality is checked again against the actual immutable release owner.
        const release = await readRelease(db, meaning.digest);
        if (!release || !isDeepStrictEqual(release, meaning.release) || !release.types[meaning.type])
          throw new BindingError('definition_missing');
        const source = await registerSource.run(db, {route_digest: routeDigest});
        if (!source) throw new BindingError('owner_unavailable');
        const definition = await defineSource.run(db, {source_id: source.source_id,
          configuration: source.configuration, route_digest: routeDigest, release_digest: meaning.digest,
          subject_type: meaning.type, capture_digest: hash(encoded), capture: encoded, dependency_keys: keys});
        if (!definition) throw new BindingError('configuration_changed');
        const native = await loadDefinition(definition.read_definition, db);
        freeze(native);
        return {status: 'resolved' as const, definition: native, cost};
      });
    },
    async join(request, context) {
      const deadline = context.deadline;
      if (!Number.isFinite(deadline) || deadline <= Date.now()) return fail('deadline');
      let retainedRequest: typeof request;
      try {
        retainedRequest = structuredClone(request);
      } catch {
        return fail('binding_mismatch');
      }
      // Caller mutation cannot extend the admitted deadline while custody performs native I/O.
      const retained = await readPublicFilterConsumerCustody(pool, retainedRequest, { deadline });
      if (deadline <= Date.now()) return fail('deadline', retained.cost);
      if (retained.status !== 'found') return retained;
      // Even a genuine Search row cannot certify native Source/configuration/read-definition identity.
      // Wide release references stay with their authoritative Semantic release owner for later binding.
      if ('authority' in retained.definition.meaning.release) return fail('source_missing', retained.cost);
      // These additive compiler contracts have no delivered native Source registration yet. Do not
      // reinterpret them with the legacy Subject-only compiler or turn partial keys into authority.
      if ('representation' in retained.definition.capture || 'purpose' in retained.definition.capture)
        return fail('source_missing', retained.cost);
      try {
        const keys = captureKeys(
          { ...retained.definition.meaning, release: retained.definition.meaning.release },
          retained.definition.capture,
        );
        if (!isDeepStrictEqual(keys, retained.definition.dependencyKeys))
          return fail('binding_mismatch', retained.cost);
      } catch {
        return fail('binding_mismatch', retained.cost);
      }
      if (deadline <= Date.now()) return fail('deadline', retained.cost);
      return fail('source_missing', retained.cost);
    },
  };
  const bootstrapBinding: PublicFilterSourceBootstrapBinding = {
    ...binding,
    async begin(_request, context) {
      return context.deadline <= Date.now()
        ? fail('deadline')
        : fail('source_missing');
    },
    async adopt(_request, context) {
      return context.deadline <= Date.now() ? fail('deadline') : fail('source_missing');
    },
    async abort(_request, context) {
      if (context.deadline <= Date.now()) return fail('deadline');
      // No bootstrap custody is available to prove physical closure or transfer.
      return { status: 'pending', cost: publicFilterBindingCost() };
    },
    async recover(_request, context) {
      return context.deadline <= Date.now()
        ? fail('deadline')
        : { status: 'pending', cost: publicFilterBindingCost() };
    },
    async repairPage(_request, context) {
      return context.deadline <= Date.now() ? fail('deadline') : fail('source_missing');
    },
    async settle(request, context) {
      void request;
      return context.deadline <= Date.now() ? fail('deadline') : fail('source_missing');
    },
  };
  return Object.freeze(bootstrapBinding);
}
