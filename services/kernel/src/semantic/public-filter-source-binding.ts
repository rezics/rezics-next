import { isDeepStrictEqual } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { publicFilterSource, publicFilterSourceOrigin } from './public-filter-source.ts';
import { readOriginalPublicFilterProjectionPage } from './public-filter-projection.ts';
import { systemClock } from '../clock.ts';
import { runCommand, noEffect } from '../command/command.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { readPartition } from '../partition/partition.ts';
import { readAccountDiscoveryReductionBinding } from '../access/account-discovery-reduction.ts';
import { readRelease, freeze } from './definitions.ts';
import { withRequestDeadline } from '../request/deadline.ts';
import { classifyUnavailability } from '../access/unavailable.ts';
import registerSource from './public-filter-source-binding-register.sql';
import defineSource from './public-filter-source-binding-define.sql';
import readDefinition from './public-filter-source-binding-definition.sql';
import beginBootstrap from './public-filter-source-binding-begin.sql';
import readBootstrap from './public-filter-source-binding-bootstrap.sql';
import adoptBootstrap from './public-filter-source-binding-adopt.sql';
import abortBootstrap from './public-filter-source-binding-abort.sql';
import accountPage from './public-filter-source-binding-account-page.sql';
import readAccounts from './public-filter-source-binding-accounts.sql';
import repairState from './public-filter-source-binding-repair-state.sql';
import repairRead from './public-filter-source-binding-repair-read.sql';
import repairSave from './public-filter-source-binding-repair-save.sql';
import repairKeys from './public-filter-source-binding-repair-keys.sql';
import repairAdvance from './public-filter-source-binding-repair-advance.sql';
import repairVersion from './public-filter-source-binding-repair-version.sql';
import type { Pool } from 'pg';
import { releaseDigest } from '@rezics/definitions';
import { admitFilter, walkFilter } from '@rezics/filter';
import type { Access } from '../request/access.ts';
import type { CustodyDefinition, CustodyRetainedDefinition } from '../search/public-filter-custody-contract.ts';
import { compileFilter } from '../search/filter.ts';
import { compileText } from '../search/text.ts';
import { validateSearchAfter } from '../search/query-payload.ts';
import { compileDiscoveryConsumerCapture, type DiscoveryConsumerCaptureInput } from '../search/discovery.ts';
import { validatePublicSuggestionInput } from '../search/public-suggestion-input.ts';
import { readPublicFilterConsumerCustody, readGenerationPublicationCustody } from '../search/public-filter-custody.ts';
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
  PublicFilterProjectionFrontier,
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
const nativeSourceRepairReceipt: unique symbol = Symbol('native Source repair receipt');
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
      | Readonly<{
          status: 'adopted';
          bootstrap: PublicSourceBootstrap;
          queried: PublicFilterQueriedObservation;
          cost: PublicFilterCost;
        }>
      | PublicFilterBindingFailure
    >;
    abort(
      request: Readonly<{ bootstrap: string }>,
      context: PublicFilterConsumerContext,
    ): Promise<Readonly<{ status: 'aborted' | 'pending'; cost: PublicFilterCost }> | PublicFilterBindingFailure>;
    recover(
      request: Readonly<{ bootstrap: string }>,
      context: PublicFilterConsumerContext,
    ): Promise<PublicSourceBootstrapRecovery>;
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
  statements: number;
  rows: number;
  bytes: number;
};
function publicFilterBindingCost(): BindingCost {
  return {
    statements: 0,
    rows: 0,
    bytes: 0,
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
      return [
        'object',
        Object.keys(entry)
          .sort()
          .map((key) => [key, pack((entry as Record<string, unknown>)[key])]),
      ];
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
    if (entry[0] === 'object')
      return Object.fromEntries(entry[1].map(([key, child]: [string, unknown]) => [key, unpack(child)]));
    if (entry[0] === 'value') return entry[1];
    throw new TypeError('Invalid stored Source data');
  }
  return unpack(JSON.parse(value)) as T;
}
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
class BindingError extends Error {
  constructor(readonly reason: PublicFilterBindingFailure['reason']) {
    super(reason);
  }
}
function checkDeadline(context: PublicFilterConsumerContext): void {
  if (!Number.isFinite(context.deadline) || context.deadline <= Date.now()) throw new BindingError('deadline');
}
/** Charge native release lookups as well as Source SQL, including failed submissions. */
function measuredPool(pool: Pool, cost: BindingCost): Pool {
  function wrap<T extends object>(target: T): T {
    return new Proxy(target, {
      get(object, key) {
        const value: unknown = Reflect.get(object, key, object);
        if (key === 'query' && typeof value === 'function')
          return async (text: string, values?: unknown[]) => {
            cost.statements++;
            cost.inputKeys += values?.length ?? 0;
            cost.bytes += Buffer.byteLength(text) + Buffer.byteLength(encode(values));
            const result = await value.call(object, text, values);
            cost.rows += result.rowCount ?? 0;
            cost.dependencyPoints += result.rowCount ?? 0;
            cost.bytes += Buffer.byteLength(encode(result.rows));
            if (/\b(INSERT|UPDATE|DELETE)\b/.test(text)) cost.resultWrites += result.rowCount ?? 0;
            return result;
          };
        if (key === 'connect' && typeof value === 'function') return async () => wrap(await value.call(object));
        return typeof value === 'function' ? value.bind(object) : value;
      },
    });
  }
  return wrap(pool);
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
  if (['name', 'collections', 'rating'].includes(input.sort))
    keys.push({ kind: 'field', field: 'name_sort' }, { kind: 'field', field: 'labels' });
  if (input.sort === 'collections') keys.push({ kind: 'function', input: 'public_collection_count' });
  if (input.sort === 'rating') keys.push({ kind: 'function', input: 'public_rating' });
  return keys.filter((key, index) => keys.findIndex((other) => isDeepStrictEqual(key, other)) === index);
}

function deriveCaptureKeys(
  meaning: PublicFilterProjectionMeaning,
  input: PublicSourceCaptureInput,
): PublicFilterDependencyKey[] {
  if (meaning.digest !== releaseDigest(meaning.release) || !meaning.release.types[meaning.type])
    throw new TypeError('Unknown native meaning');
  let keys: readonly PublicFilterDependencyKey[];
  if ('purpose' in input) {
    validatePublicSuggestionInput(input);
    keys = [
      { kind: 'type' },
      { kind: 'field', field: 'id' },
      { kind: 'field', field: 'labels' },
      { kind: 'field', field: 'aliases' },
      { kind: 'field', field: 'name_sort' },
      { kind: 'order', order: 'name' },
      { kind: 'order', order: 'id' },
    ];
  } else if ('representation' in input) {
    keys = [
      ...compileDiscoveryConsumerCapture(input, meaning, undefined).dependencyKeys,
      { kind: 'field', field: 'id' },
      ...(input.sort === 'name'
        ? [
            { kind: 'field' as const, field: 'name_sort' as const },
            { kind: 'field' as const, field: 'labels' as const },
            { kind: 'field' as const, field: 'aliases' as const },
          ]
        : []),
    ];
  } else keys = captureKeys(meaning, input);
  return keys.filter((key, i) => keys.findIndex((other) => isDeepStrictEqual(key, other)) === i);
}

function allCaptureKeys(
  meaning: PublicFilterProjectionMeaning,
  input: PublicSourceCaptureInput,
): PublicFilterDependencyKey[] {
  try {
    return deriveCaptureKeys(meaning, input);
  } catch {
    throw new BindingError('binding_mismatch');
  }
}

/** Native Source-owned registration; the origin association only locates the constructor configuration. */
export function createPublicFilterSourceBinding(
  pool: Pool,
  routing: Uint8Array,
  access: Access,
): PublicFilterSourceBootstrapBinding {
  validatePublicFilterBindingConfiguration(pool, routing, access);
  const nativeRouting = new Uint8Array(routing);
  const routeDigest = hash(nativeRouting);
  const fail = (
    reason: PublicFilterBindingFailure['reason'],
    cost: PublicFilterCost = publicFilterBindingCost(),
  ): PublicFilterBindingFailure => ({
    status: ['source_missing', 'definition_missing', 'identity_pending'].includes(reason) ? 'unready' : 'unavailable',
    reason,
    cost,
  });
  async function run<T>(
    context: PublicFilterConsumerContext,
    work: (cost: BindingCost, db: Pool) => Promise<T>,
  ): Promise<T | PublicFilterBindingFailure> {
    const cost = publicFilterBindingCost();
    const deadline = context.deadline;
    try {
      checkDeadline({ deadline });
      const result = await withRequestDeadline(deadline, () => work(cost, measuredPool(pool, cost)));
      checkDeadline({ deadline });
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
    const row = await readDefinition.run(db, { read_definition: id });
    if (!row) throw new BindingError('definition_missing');
    if (row.route_digest !== routeDigest) throw new BindingError('configuration_changed');
    const release = await readRelease(db, row.release_digest);
    if (!release || !release.types[row.subject_type]) throw new BindingError('definition_missing');
    const capture = decode<PublicSourceCaptureInput>(row.capture);
    const meaning = { digest: row.release_digest, release, type: row.subject_type };
    const keys = allCaptureKeys(meaning, capture);
    if (!isDeepStrictEqual(keys, row.dependency_keys)) throw new BindingError('binding_mismatch');
    return {
      source: { id: row.source_id, partition: 0, epoch: row.owner_epoch, configuration: row.configuration },
      readDefinition: id,
      meaning,
      capture,
      dependencyKeys: keys,
    };
  }
  const readers = new Map<string, PublicFilterSource>();
  const sourceReader = (definition: PublicFilterSourceDefinition) =>
    readers.get(definition.source.id) ??
    publicFilterSource({ pool, routeKey: new Uint8Array(nativeRouting), access, clock: systemClock });
  function nativeId(locator: string): string {
    if (typeof locator !== 'string' || !locator.startsWith('0:') || !uuid.test(locator.slice(2)))
      throw new BindingError('observation_lost');
    return locator.slice(2);
  }
  function requireSameDefinition(own: PublicFilterSourceDefinition, retained: CustodyRetainedDefinition): void {
    if (
      encode(own.source) !== encode(retained.source) ||
      own.readDefinition !== retained.readDefinition ||
      own.meaning.digest !== retained.meaning.digest ||
      own.meaning.type !== retained.meaning.type ||
      encode(own.capture) !== encode(retained.capture) ||
      encode(own.dependencyKeys) !== encode(retained.dependencyKeys)
    )
      throw new BindingError('binding_mismatch');
    if ('authority' in retained.meaning.release) {
      if (
        retained.meaning.release.authority !== 'semantic.readRelease' ||
        retained.meaning.release.digest !== own.meaning.digest
      )
        throw new BindingError('binding_mismatch');
    } else if (!isDeepStrictEqual(own.meaning.release, retained.meaning.release))
      throw new BindingError('binding_mismatch');
  }
  async function loadBootstrap(locator: string, db: Pool, knownDefinition?: PublicFilterSourceDefinition) {
    const row = await readBootstrap.run(db, { bootstrap: nativeId(locator) });
    if (!row) throw new BindingError('observation_lost');
    if (knownDefinition && knownDefinition.readDefinition !== row.read_definition)
      throw new BindingError('binding_mismatch');
    const definition = knownDefinition ?? (await loadDefinition(row.read_definition, db));
    if (row.owner_epoch !== definition.source.epoch) throw new BindingError('configuration_changed');
    if (row.snapshot_kind !== 'pit' && row.snapshot_kind !== 'prepared') throw new BindingError('binding_mismatch');
    const bootstrap: PublicSourceBootstrap = {
      id: locator,
      definition,
      consumer: decode<PublicFilterConsumer>(row.consumer),
      snapshot: row.snapshot_kind,
      covered: { observation: locator },
    };
    return { row, definition, bootstrap };
  }
  async function validateAccounts(
    row: NonNullable<Awaited<ReturnType<typeof readBootstrap.run>>>,
    definition: PublicFilterSourceDefinition,
    db: Pool,
    context: PublicFilterConsumerContext,
  ) {
    if (row.account_after !== 4096) throw new BindingError('owner_unavailable');
    if (!('representation' in definition.capture)) return;
    for (let after = 0; after < 4096; after += 100) {
      checkDeadline(context);
      const original = await readAccounts.run(db, { bootstrap: row.bootstrap, after_partition: after });
      const count = Math.min(100, 4096 - after);
      if (original.length !== count || original.some((head, i) => head.account_partition !== after + i))
        throw new BindingError('owner_unavailable');
      const current = await readAccountDiscoveryReductionBinding(
        db,
        original.map((head) => head.account_partition),
        context,
      );
      if (
        current.heads.length !== original.length ||
        current.heads.some((head, i) => {
          const old = original[i]!;
          return (
            head.partition !== old.account_partition ||
            head.epoch !== old.owner_epoch ||
            head.revision !== BigInt(old.revision) ||
            head.claimRevision !== BigInt(old.claim_revision)
          );
        })
      )
        throw new BindingError('binding_mismatch');
    }
  }
  type Joined = Extract<Awaited<ReturnType<PublicFilterSourceBinding['join']>>, { status: 'joined' }>;
  async function validateOriginalAndFinal(
    bootstrap: PublicSourceBootstrap,
    joined: Joined,
    cost: BindingCost,
    context: PublicFilterConsumerContext,
  ) {
    if (!joined.execution) throw new BindingError('execution_missing');
    const observed = await sourceReader(bootstrap.definition).readPrivacyReductionHeads({
      kind: 'population',
      queried: joined.queried,
      start: joined.execution.start,
      execution: joined.execution.id,
      context,
    });
    addCost(cost, observed.cost);
    if (observed.status !== 'observed')
      throw new BindingError(
        'reason' in observed && observed.reason === 'identity_pending'
          ? 'identity_pending'
          : 'reason' in observed && observed.reason === 'deadline'
            ? 'deadline'
            : 'owner_unavailable',
      );
    if (
      !observed.routingComplete ||
      observed.changed.length ||
      observed.unacknowledged.length ||
      observed.blocking.length
    )
      throw new BindingError('binding_mismatch');
  }
  type RepairState = {
    partition: number;
    after: { route: number; id: string } | null;
    subject: string | null;
    phase: 'scan' | 'advance' | 'project';
    advance: string;
    version: bigint | null;
    epoch: number | null;
    projection: PublicFilterProjectionFrontier | null;
  };
  type RepairRecord = {
    input: RepairState;
    next: RepairState;
    output: { digest: string; frontier: PublicFilterProjectionFrontier } | null;
  };
  async function repairNative(
    bootstrap: PublicSourceBootstrap,
    joined: Joined,
    request: { execution: string; frontier: string | null; inputLimit: number },
    db: Pool,
    cost: BindingCost,
    context: PublicFilterConsumerContext,
  ): Promise<PublicSourceRepairPage> {
    const id = nativeId(bootstrap.id);
    if (
      !request.execution ||
      request.execution.length > 4096 ||
      (request.frontier !== null && !uuid.test(request.frontier))
    )
      throw new BindingError('binding_mismatch');
    const old = await repairRead.run(db, {
      bootstrap: id,
      execution: request.execution,
      predecessor: request.frontier ?? '',
    });
    const replay = old ? decode<RepairRecord>(old.state) : null;
    let state: RepairState;
    if (replay) state = replay.input;
    else if (request.frontier !== null) {
      const previous = await repairState.run(db, {
        bootstrap: id,
        execution: request.execution,
        step: request.frontier,
      });
      if (!previous || previous.complete) throw new BindingError('binding_mismatch');
      state = decode<RepairRecord>(previous.state).next;
    } else
      state = {
        partition: 0,
        after: null,
        subject: null,
        phase: 'scan',
        advance: randomUUID(),
        version: null,
        epoch: null,
        projection: null,
      };
    let next = structuredClone(state);
    let repairs: PublicSourceRepair[] = [],
      output: RepairRecord['output'] = null,
      complete = false;
    if (state.partition === 4096) {
      // A full enumeration alone cannot close the creation/change bridge or certify a moving Source.
      await validateOriginalAndFinal(bootstrap, joined, cost, context);
      complete = true;
    } else {
      const owner = await readPartition(db, state.partition);
      if (!owner || owner.writeState !== 'active') throw new BindingError('owner_unavailable');
      if (state.epoch !== null && state.epoch !== owner.epoch) throw new BindingError('configuration_changed');
      next.epoch = owner.epoch;
      if (state.phase === 'scan') {
        const key = await repairKeys.run(db, {
          partition_no: state.partition,
          after_route: state.after?.route ?? state.partition * 16,
          after_id: state.after?.id ?? '00000000-0000-0000-0000-000000000000',
        });
        if (!key) next = { ...next, partition: state.partition + 1, after: null, epoch: null };
        else {
          // Raw keys include hidden/redirected/rejected originals. No returned-hit subset supplies work.
          cost.candidates++;
          next = {
            ...next,
            subject: key.subject_id,
            after: { route: key.route, id: key.subject_id },
            phase: 'advance',
            advance: randomUUID(),
            version: null,
            projection: null,
          };
        }
      } else if (state.phase === 'advance') {
        const route = routeOf(state.subject!);
        if (route === null || partitionOf(route) !== state.partition) throw new BindingError('binding_mismatch');
        const values = {
          partition_no: state.partition,
          bootstrap: id,
          execution: request.execution,
          step: state.advance,
          route,
          subject_id: state.subject!,
        };
        const advancement = await runCommand(
          db,
          {
            partition: state.partition,
            deadline: context.deadline,
            clock: publicFilterSourceOrigin(sourceReader(bootstrap.definition))?.clock ?? systemClock,
          },
          async (tx) => {
            const existing = await repairVersion.run(tx, values);
            if (existing) return noEffect(existing);
            const result = await repairAdvance.run(tx, values);
            const inserted = Array.isArray(result) ? result[0] : result;
            if (!inserted) throw new BindingError('owner_unavailable');
            return {
              value: inserted,
              events: [
                {
                  type: 'com.rezics.semantic.public-source.advanced.v1',
                  subject: state.subject!,
                  data: { id: state.subject!, bootstrap: id, execution: request.execution },
                },
              ],
            };
          },
        );
        if (advancement.value.owner_epoch !== owner.epoch || BigInt(advancement.value.position) > advancement.position)
          throw new BindingError('configuration_changed');
        next = { ...next, version: BigInt(advancement.value.position), phase: 'project' };
      } else {
        const source = sourceReader(bootstrap.definition);
        const origin = publicFilterSourceOrigin(source);
        if (!origin) throw new BindingError('source_missing');
        const page = await readOriginalPublicFilterProjectionPage(origin, {
          subject: state.subject!,
          meaning: bootstrap.definition.meaning,
          inputLimit: request.inputLimit,
          frontier: state.projection,
          context,
        }, {
          bootstrap: nativeId(bootstrap.id),
          execution: request.execution,
          predecessor: request.frontier,
        });
        addCost(cost, page.cost);
        if (page.status !== 'progress' && page.status !== 'complete') {
          if (page.status === 'changed') throw new BindingError('binding_mismatch');
          throw new BindingError(
            page.reason === 'identity_pending'
              ? 'identity_pending'
              : page.reason === 'deadline'
                ? 'deadline'
                : 'owner_unavailable',
          );
        }
        if (
          page.source.partition !== state.partition ||
          page.source.subject !== state.subject ||
          page.source.epoch !== owner.epoch ||
          state.version === null ||
          page.source.position < state.version
        )
          throw new BindingError('binding_mismatch');
        const digest = hash(
          encode({
            status: page.status,
            source: page.source,
            records: page.records,
            repairLocators: page.repairLocators,
            heads: page.status === 'complete' ? page.requiredHeads : undefined,
          }),
        );
        if (replay?.output && replay.output.digest !== digest) throw new BindingError('binding_mismatch');
        output = replay?.output ?? { digest, frontier: page.frontier };
        // This frontier was emitted by the real Source. Replays revalidate the exact source/version/content.
        const projection = { ...page, frontier: output.frontier };
        const receipt = Object.freeze({ [nativeSourceRepairReceipt]: true as const });
        repairs = page.repairLocators.map((locator) => ({
          kind: locator.dependencies.some(
            (dependency) => 'route' in dependency && partitionOf(dependency.route) !== state.partition,
          )
            ? ('foreign' as const)
            : ('local' as const),
          locator,
          source: page.source,
          projection,
          receipt,
        }));
        next =
          page.status === 'complete'
            ? { ...next, subject: null, phase: 'scan', projection: null, version: null }
            : { ...next, projection: output.frontier };
      }
    }
    checkDeadline(context);
    const step = old?.step ?? randomUUID();
    if (!old) {
      const saved = await repairSave.run(db, {
        bootstrap: id,
        execution: request.execution,
        step,
        predecessor: request.frontier ?? '',
        state: encode({ input: state, next, output } satisfies RepairRecord),
        complete,
      });
      // A concurrent successor cannot discard an independently produced Source page. Retry its retained predecessor.
      if (!(Array.isArray(saved) ? saved[0] : saved)) throw new BindingError('binding_mismatch');
      cost.frontierWrites++;
    }
    return complete
      ? { status: 'complete', repairs, frontier: null, cost }
      : { status: 'progress', repairs, frontier: step, cost };
  }
  const binding: PublicFilterSourceBinding = {
    async resolve(request, context) {
      // Capture all caller data and constructor identity before the first suspension.
      let meaning: PublicFilterProjectionMeaning, capture: PublicSourceCaptureInput;
      const origin = publicFilterSourceOrigin(request.source);
      if (!origin || origin.pool !== pool || origin.access !== access || hash(origin.routeKey) !== routeDigest)
        return fail('source_missing');
      try {
        meaning = structuredClone(request.meaning);
        capture = structuredClone(request.capture);
      } catch {
        return fail('binding_mismatch');
      }
      return run(context, async (cost, db) => {
        const keys = allCaptureKeys(meaning, capture);
        const encoded = encode(capture);
        if (Buffer.byteLength(encoded) > 1048576) throw new BindingError('binding_mismatch');
        // Caller digest equality is checked again against the actual immutable release owner.
        const release = await readRelease(db, meaning.digest);
        if (!release || !isDeepStrictEqual(release, meaning.release) || !release.types[meaning.type])
          throw new BindingError('definition_missing');
        const source = (await registerSource.run(db, { route_digest: routeDigest }))[0];
        if (!source) throw new BindingError('owner_unavailable');
        const definition = (
          await defineSource.run(db, {
            source_id: source.source_id,
            configuration: source.configuration,
            route_digest: routeDigest,
            release_digest: meaning.digest,
            subject_type: meaning.type,
            capture_digest: hash(encoded),
            capture: encoded,
            dependency_keys: keys,
          })
        )[0];
        if (!definition) throw new BindingError('configuration_changed');
        const native = await loadDefinition(definition.read_definition, db);
        freeze(native);
        return { status: 'resolved' as const, definition: native, cost };
      });
    },
    async join(request, context) {
      let input: typeof request;
      try {
        input = structuredClone(request);
      } catch {
        return fail('binding_mismatch');
      }
      const deadline = context.deadline;
      return run({ deadline }, async (cost, db) => {
        const retained = await readPublicFilterConsumerCustody(pool, input, { deadline });
        addCost(cost, retained.cost);
        if (retained.status !== 'found') return { ...retained, cost };
        const definition = await loadDefinition(retained.definition.readDefinition, db);
        requireSameDefinition(definition, retained.definition);
        // Custody owns immutable root input and lineage. Never compare refill frontier/size to it.
        const cut = await loadBootstrap(retained.covered.observation, db, definition);
        if (
          cut.definition.readDefinition !== definition.readDefinition ||
          encode(cut.bootstrap.consumer) !== encode(retained.queried.consumer) ||
          cut.bootstrap.snapshot !== retained.queried.snapshot.kind ||
          cut.row.state === 'aborting' ||
          cut.row.state === 'aborted'
        )
          throw new BindingError('binding_mismatch');
        await validateAccounts(cut.row, definition, db, { deadline });
        if (retained.execution !== null) {
          const started = await loadBootstrap(retained.execution.start.observation, db, definition);
          if (
            started.definition.readDefinition !== definition.readDefinition ||
            encode(started.bootstrap.consumer) !== encode(retained.queried.consumer) ||
            started.bootstrap.snapshot !== retained.queried.snapshot.kind ||
            started.row.state === 'aborting' ||
            started.row.state === 'aborted'
          )
            throw new BindingError('binding_mismatch');
          await validateAccounts(started.row, definition, db, { deadline });
        }
        freeze(definition);
        return {
          status: 'joined' as const,
          definition,
          queried: retained.queried,
          covered: retained.covered,
          execution: retained.execution,
          cost,
        };
      });
    },
  };
  const bootstrapBinding: PublicFilterSourceBootstrapBinding = {
    ...binding,
    async begin(request, context) {
      const deadline = context.deadline;
      let capture: PublicSourceCaptureInput, consumer: PublicFilterConsumer;
      const snapshot = request.snapshot;
      try {
        capture = structuredClone(request.capture);
        consumer = structuredClone(request.consumer);
      } catch {
        return fail('binding_mismatch');
      }
      if (snapshot !== 'pit' && snapshot !== 'prepared') return fail('binding_mismatch');
      const resolved = await binding.resolve(
        { source: request.source, meaning: request.meaning, capture },
        { deadline },
      );
      if (resolved.status !== 'resolved') return resolved;
      readers.set(resolved.definition.source.id, request.source);
      return run({ deadline }, async (cost, db) => {
        addCost(cost, resolved.cost);
        // Validate the already registered physical consumer through its real owner, before making a cut.
        const registration = await readGenerationPublicationCustody(pool, consumer, 0, { deadline });
        addCost(cost, registration.cost);
        if (!('definition' in registration)) return { ...registration, cost };
        requireSameDefinition(resolved.definition, registration.definition);
        if (
          consumer.readDefinition !== resolved.definition.readDefinition ||
          consumer.meaningDigest !== resolved.definition.meaning.digest
        )
          throw new BindingError('binding_mismatch');
        const inserted = (
          await beginBootstrap.run(db, {
            bootstrap: randomUUID(),
            read_definition: resolved.definition.readDefinition,
            request_key: hash(encode({ consumer, snapshot })),
            consumer: encode(consumer),
            snapshot_kind: snapshot,
            mixed: 'representation' in capture,
          })
        )[0];
        if (!inserted) throw new BindingError('configuration_changed');
        const cut = await loadBootstrap('0:' + inserted.bootstrap, db, resolved.definition);
        if (cut.row.state === 'capturing') {
          // One bounded owner page per retry. Excluded, empty, order and hashed-claim homes are all retained.
          const homes = Array.from(
            { length: Math.min(100, 4096 - cut.row.account_after) },
            (_, i) => cut.row.account_after + i,
          );
          const native = await readAccountDiscoveryReductionBinding(db, homes, { deadline });
          if (native.heads.length !== homes.length || native.heads.some((head, i) => head.partition !== homes[i]))
            throw new BindingError('owner_unavailable');
          const advanced = (
            await accountPage.run(db, {
              bootstrap: inserted.bootstrap,
              after_partition: cut.row.account_after,
              next_partition: cut.row.account_after + homes.length,
              head_count: homes.length,
              heads: native.heads.map((head) => ({
                partition: head.partition,
                epoch: head.epoch,
                revision: String(head.revision),
                claim_revision: String(head.claimRevision),
              })),
            })
          )[0];
          if (!advanced || cut.row.account_after + homes.length !== 4096)
            return { status: 'unready' as const, reason: 'owner_unavailable' as const, cost };
        }
        const begun = await loadBootstrap('0:' + inserted.bootstrap, db, resolved.definition);
        return { status: 'begun' as const, bootstrap: begun.bootstrap, cost };
      });
    },
    async adopt(request, context) {
      const input = structuredClone(request),
        deadline = context.deadline;
      const joined = await binding.join({ queried: input.queried }, { deadline });
      if (joined.status !== 'joined') return joined;
      return run({ deadline }, async (cost, db) => {
        addCost(cost, joined.cost);
        const cut = await loadBootstrap(input.bootstrap, db, joined.definition);
        if (
          encode(joined.covered) !== encode(cut.bootstrap.covered) ||
          joined.definition.readDefinition !== cut.definition.readDefinition ||
          encode(joined.queried.consumer) !== encode(cut.bootstrap.consumer) ||
          joined.queried.snapshot.kind !== cut.bootstrap.snapshot
        )
          throw new BindingError('binding_mismatch');
        if (
          !(
            await adoptBootstrap.run(db, {
              bootstrap: cut.row.bootstrap,
              observation: joined.queried.snapshot.observation,
            })
          )[0]
        )
          throw new BindingError('binding_mismatch');
        return { status: 'adopted' as const, bootstrap: cut.bootstrap, queried: joined.queried, cost };
      });
    },
    async abort(request, context) {
      const id = request.bootstrap;
      return run(context, async (cost, db) => {
        const cut = await loadBootstrap(id, db);
        const result = (await abortBootstrap.run(db, { bootstrap: cut.row.bootstrap }))[0];
        if (!result) throw new BindingError('configuration_changed');
        // Search's public lookup cannot distinguish closed from unknown/expired/uncertain native custody.
        // Persist the barrier and retain the cut; neither a timeout nor observation_lost proves closure.
        return { status: result.state === 'aborted' ? ('aborted' as const) : ('pending' as const), cost };
      });
    },
    async recover(request, context) {
      const id = request.bootstrap,
        deadline = context.deadline;
      return run({ deadline }, async (cost, db) => {
        const cut = await loadBootstrap(id, db);
        if (cut.row.state === 'aborting' || cut.row.state === 'aborted' || cut.row.state === 'capturing')
          return { status: 'pending' as const, cost };
        // Search may have committed retain/open before the caller crashed before adoption.
        // Resolve its actual owner record; an absent/uncertain observation never proves no physical effect.
        const native = await readGenerationPublicationCustody(
          pool,
          cut.bootstrap.consumer,
          0,
          { deadline },
          cut.row.queried ?? undefined,
        );
        addCost(cost, native.cost);
        if (!('definition' in native)) return { ...native, cost };
        if (native.queried === null) return { status: 'pending' as const, cost };
        requireSameDefinition(cut.definition, native.definition);
        const joined = await binding.join({ queried: native.queried }, { deadline });
        addCost(cost, joined.cost);
        if (joined.status !== 'joined') return { ...joined, cost };
        if (encode(joined.covered) !== encode(cut.bootstrap.covered)) return { status: 'pending' as const, cost };
        if (
          !(
            await adoptBootstrap.run(db, {
              bootstrap: cut.row.bootstrap,
              observation: joined.queried.snapshot.observation,
            })
          )[0]
        )
          throw new BindingError('binding_mismatch');
        return { status: 'adopted' as const, bootstrap: cut.bootstrap, queried: joined.queried, cost };
      });
    },
    async repairPage(request, context) {
      const input = structuredClone(request),
        deadline = context.deadline;
      if (!Number.isInteger(input.inputLimit) || input.inputLimit < 1 || input.inputLimit > 256)
        throw new RangeError('Repair inputLimit must be 1 through 256');
      const joined = await binding.join({ queried: input.queried, execution: input.execution }, { deadline });
      if (joined.status !== 'joined') return joined;
      return run({ deadline }, async (cost, db) => {
        addCost(cost, joined.cost);
        const cut = await loadBootstrap(input.bootstrap, db, joined.definition);
        if (
          cut.row.state !== 'adopted' ||
          cut.row.queried !== joined.queried.snapshot.observation ||
          encode(joined.covered) !== encode(cut.bootstrap.covered)
        )
          throw new BindingError('binding_mismatch');
        // An Account family needs the Accounts native repair owner; Subject versions never certify it.
        if ('representation' in cut.definition.capture) throw new BindingError('owner_unavailable');
        return repairNative(cut.bootstrap, joined, input, db, cost, { deadline });
      });
    },
    async settle(request, context) {
      const input = structuredClone(request),
        deadline = context.deadline;
      const joined = await binding.join({ queried: input.queried, execution: input.execution }, { deadline });
      if (joined.status !== 'joined') return joined;
      return run({ deadline }, async (cost, db) => {
        addCost(cost, joined.cost);
        const cut = await loadBootstrap(input.bootstrap, db, joined.definition);
        if (
          cut.row.state !== 'adopted' ||
          cut.row.queried !== joined.queried.snapshot.observation ||
          encode(joined.covered) !== encode(cut.bootstrap.covered)
        )
          throw new BindingError('binding_mismatch');
        await validateOriginalAndFinal(cut.bootstrap, joined, cost, { deadline });
        // The committed Search custody primitive exposes immutable execution, NOT engine-visible repair
        // receipts/dispatch settlement. Never turn a custody row, current ACK or Source receipt into that proof.
        throw new BindingError('owner_unavailable');
      });
    },
  };
  return Object.freeze(bootstrapBinding);
}
