import { isDeepStrictEqual } from 'node:util';
import type { CustodyDefinition } from '../search/public-filter-custody-contract.ts';
import type { PublicCanonicalCaptureInput, PublicFilterConsumerUnavailable } from '../search/public-filter-consumer-contract.ts';
import type { PrivacyReductionObservation, PrivacyReductionObservationRequest } from './public-filter-source-contract.ts';
import type { Pool } from 'pg';
import { releaseDigest } from '@rezics/definitions';
import { admitFilter, walkFilter } from '@rezics/filter';
import type { Access } from '../request/access.ts';
import type { CustodyDefinition } from '../search/public-filter-custody-contract.ts';
import { compileFilter } from '../search/filter.ts';
import { compileText } from '../search/text.ts';
import { validateSearchAfter } from '../search/query-payload.ts';
import { readPublicFilterConsumerCustody } from '../search/public-filter-custody.ts';
import type { DiscoveryConsumerCaptureInput } from '../search/discovery.ts';
import type {
  PublicFilterConsumerCaptureInput,
  PublicFilterConsumerContext,
  PublicCanonicalCaptureInput,
  PublicFilterConsumerUnavailable,
  PublicFilterQueriedObservation,
  PublicSuggestionCaptureInput,
} from '../search/public-filter-consumer-contract.ts';
import type {
  PublicFilterCost,
  PublicFilterDependencyKey,
  PublicFilterProjectionMeaning,
  PublicFilterSource,
  PublicFilterConsumer,
  PublicFilterProjectionObservation,
  PublicFilterProjectionPage,
  PublicFilterRepairLocator,
  PrivacyReductionStart,
  PrivacyReductionObservation,
  PrivacyReductionObservationRequest,
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

/** Legacy internal native Source shape consumed by the prefix adapter. */
export type JoinedPopulationRequest =
  | Readonly<{ kind: 'queried'; phase: 'start' | 'status'; queried: PublicFilterQueriedObservation }>
  | Readonly<{ kind: 'queried'; phase: 'final'; queried: PublicFilterQueriedObservation; execution: string }>;

export interface PublicFilterNativeSource extends Omit<PublicFilterSource, 'readPrivacyReductionHeads'> {
  resolvePublicFilterDefinition(
    request: Readonly<{ meaning: PublicFilterProjectionMeaning; capture: PublicCanonicalCaptureInput }>,
    context: PublicFilterConsumerContext,
  ): Promise<
    | Readonly<{ status: 'bound'; definition: CustodyDefinition<PublicCanonicalCaptureInput>; cost: PublicFilterCost }>
    | PublicFilterConsumerUnavailable
  >;
  readPrivacyReductionHeads(request: PrivacyReductionObservationRequest): Promise<PrivacyReductionObservation>;
  readPrivacyReductionHeads(request: JoinedPopulationRequest, context?: PublicFilterConsumerContext): Promise<PrivacyReductionObservation>;
}

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

function publicFilterBindingCost(): PublicFilterCost {
  return {
    inputKeys: 0,
    candidates: 0,
    accessPoints: 0,
    dependencyPoints: 0,
    engineSearches: 0,
    engineIteratorSteps: 0,
    outputSlots: 0,
    resultWrites: 0,
    frontierWrites: 0,
  };
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

/**
 * Provisional native-origin adapter: the actual three-reader producer has not landed.
 * Search custody is consumed through its committed primitive, but cannot establish Source origin.
 * No Source registry or constructor association is fabricated here. Replace this unavailable
 * branch with the producer's agreed native registration when that implementation is delivered.
 */
export function createPublicFilterSourceBinding(
  pool: Pool,
  routing: Uint8Array,
  access: Access,
): PublicFilterSourceBootstrapBinding {
  validatePublicFilterBindingConfiguration(pool, routing, access);
  const fail = (
    reason: PublicFilterBindingFailure['reason'],
    cost = publicFilterBindingCost(),
  ): PublicFilterBindingFailure => ({ status: reason === 'source_missing' ? 'unready' : 'unavailable', reason, cost });
  const binding: PublicFilterSourceBinding = {
    async resolve(request, context) {
      const deadline = context.deadline;
      if (!Number.isFinite(deadline) || deadline <= Date.now()) return fail('deadline');
      // Copy before the first suspension. Neither caller mutation nor a reader-shaped clone is an origin proof.
      try {
        const meaning = structuredClone(request.meaning);
        const capture = structuredClone(request.capture);
        // These agreed inputs require actual Search admission/compiler and owner bindings.
        // A mixed kind tree must never be cast to the Subject-only filter compiler.
        if ('representation' in capture || 'purpose' in capture) {
          if (meaning.digest !== releaseDigest(meaning.release) || !meaning.release.types[meaning.type])
            return fail('binding_mismatch');
          return fail(deadline <= Date.now() ? 'deadline' : 'source_missing');
        }
        captureKeys(meaning, capture);
      } catch {
        return fail('binding_mismatch');
      }
      if (deadline <= Date.now()) return fail('deadline');
      return fail('source_missing');
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
