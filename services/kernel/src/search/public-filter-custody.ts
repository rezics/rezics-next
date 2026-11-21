import { bookBindingStep, bookCostShare, type BindingStep } from '../request/book-binding-steps.ts';
import { lockPublicationAdmission, readPublicationFence } from './publication-admission.ts';
import { encode, decode, requireValue } from './public-filter-codec.ts';
import { encodeGenerationPublicationQueried } from './generation-publication-pin.ts';
import { hasExactPublicFilterMeaning } from './public-filter-meaning.ts';
import { canonicalDiscoveryCatalogue, publicFilterCatalogue } from './discovery-catalogue.ts';
import { verifyPublicFilterRepairSourcePage, PublicFilterRepairSourceError } from './public-filter-custody-source.ts';
import { readRepairWinnerCheckpoint } from './public-filter-repair-checkpoint.ts';
import { withNativePublicFilterRepairReadBatch } from './native-bindings.ts';
import repairTransaction from './public-filter-custody-repair-transaction.sql';
import repairFinish from './public-filter-custody-repair-finish.sql';
import repairWriters from './public-filter-custody-repair-writers.sql';
import repairGate from './public-filter-custody-repair-gate.sql';
import repairOwner from './public-filter-custody-repair-owner.sql';
import repairTarget from './public-filter-custody-repair-target.sql';
import repairRegistration from './public-filter-custody-repair-registration.sql';
import repairEffects from './public-filter-custody-repair-effects.sql';
import repairPage from './public-filter-custody-repair-page.sql';
import repairEffect from './public-filter-custody-repair-effect.sql';
import repairPages from './public-filter-custody-repair-pages.sql';
import repairState from './public-filter-custody-repair-state.sql';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { isDeepStrictEqual } from 'node:util';
import {
  readSearchRepairWinner,
  assertRetainedRepairWriterFence,
  verifyDiscoveryRepairWinners,
  readPublicFilterRepairPhysicalTarget,
  repairWriterPosition,
  validatePublicFilterRepairWriterEvidence,
  isDiscoveryRepairWriterReceipt,
  type PublicFilterRepairWriterReceipt,
  inspectSearchRepairWriter,
  type SupersededSearchRepair,
} from './writer-guard.ts';
import { subjectPartition } from './source.ts';
import { validateRefreshResponse } from './write-actions.ts';
import { admitFilter, walkFilter } from '@rezics/filter';
import releaseExists from '../semantic/definitions-exists.sql';
import compositeReference from '../semantic/composite-read.sql';
import { discardConnection, withConnection, withoutQueryAccounting } from '../database/pool.ts';
import { withBoundedReadLifetime, type NativeReadQueryConfig } from '../database/bounded-read-lifetime.ts';
import { deadlineFor, withRequestDeadline } from '../request/deadline.ts';
import { compileDiscoveryConsumerCapture } from './discovery-filter.ts';
import { compileFilter } from './filter.ts';
import { compileText } from './text.ts';
import { validatePublicSuggestionInput } from './public-suggestion-input.ts';
import { createOpenSearch, OpenSearchError, type OpenSearch } from './opensearch.ts';
import type { PublicFilterCost } from '../semantic/index.ts';
import { assertRetainedPitDeletion } from './erasure-pit.ts';
import type { PublicFilterConsumer, PublicFilterDependencyKey } from '../semantic/index.ts';
import type {
  PublicCanonicalCaptureInput,
  PublicFilterConsumerContext,
  PublicFilterQueriedObservation,
} from './public-filter-consumer-contract.ts';
import type {
  PublicFilterRepairSettlementResult,
  NativePublicFilterRepairSettlement,
  RetainedRepairSettlement,
  RetainedRepairPage,
  PublicFilterRepairSourceBinding,
  CustodyCost,
  CustodyPreparationFrontier,
  CustodyDefinition,
  CustodyExecution,
  CustodyFailure,
  CustodyFound,
  CustodyRead,
  CustodyRetainedDefinition,
  CustodyReleaseReference,
  CustodyRegistration,
  PublicFilterCustody,
} from './public-filter-custody-contract.ts';
import {
  insertSegmentRows,
  readSegmentReplay,
  readSegmentWindow,
  retireSegmentRows,
  type PublicFilterPreparationSegmentKey,
} from './public-filter-preparation-segment.ts';

const readSql = readFileSync(new URL('./public-filter-custody-read.sql', import.meta.url), 'utf8');
// Process-local hints span factories (and wrapped pools). No hint can establish durable drain.
const drainWaiters = new Map<string, Set<() => void>>();
function drainSignal(observation: string) {
  let signalled = false;
  let resume: (() => void) | undefined;
  const wake = () => {
    signalled = true;
    resume?.();
  };
  const waiters = drainWaiters.get(observation) ?? new Set<() => void>();
  waiters.add(wake);
  drainWaiters.set(observation, waiters);
  return {
    async wait(until: number) {
      if (signalled) {
        signalled = false;
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          new Promise<void>((resolve) => {
            resume = resolve;
          }),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, Math.max(0, until - Date.now()));
          }),
        ]);
      } finally {
        clearTimeout(timer);
        resume = undefined;
        signalled = false;
      }
    },
    dispose() {
      waiters.delete(wake);
      if (!waiters.size) drainWaiters.delete(observation);
    },
  };
}
/** Internal durable native encoding; never constructs a settlement or Source proof. */
export {
  encode as encodePublicFilterNativeState,
  decode as decodePublicFilterNativeState,
} from './public-filter-codec.ts';
const digest = (value: unknown) => createHash('sha256').update(encode(value)).digest('hex');
function text(value: unknown): asserts value is string {
  requireValue(typeof value === 'string' && value.length > 0 && value.length <= 65536 && !value.includes('\0'));
}
function home(value: number) {
  requireValue(Number.isInteger(value) && value >= 0 && value < 4096);
  return value;
}
function partition(observation: string) {
  text(observation);
  requireValue(/^(0|[1-9][0-9]{0,3}):[0-9a-f-]{36}$/.test(observation));
  return home(Number(observation.split(':')[0]));
}
function registration(value: CustodyRegistration) {
  home(value.partition);
  requireValue(/^[0-9a-f]{64}$/.test(value.id));
}
function lifetime(value: number) {
  requireValue(Number.isInteger(value) && value >= 1 && value <= 300_000);
}
function rows(value: CustodyExecution['ownRows']) {
  requireValue(Array.isArray(value) && value.length <= 1000);
  for (const row of value) {
    text(row.original);
    text(row.terminal);
  }
}
function queried(value: PublicFilterQueriedObservation) {
  publicFilterCatalogue(value.consumer);
  partition(value.snapshot.observation);
  for (const key of ['physicalTarget', 'incarnation', 'consumerGeneration', 'projectionGeneration'] as const)
    text(value.consumer[key]);
  if (value.snapshot.kind === 'pit') text(value.snapshot.pit);
  else {
    requireValue(
      value.snapshot.kind === 'prepared' &&
        typeof value.snapshot.generation === 'bigint' &&
        value.snapshot.generation > 0n,
    );
    text(value.snapshot.build);
  }
}
function cost(): CustodyCost {
  return {
    statements: 0,
    rows: 0,
    bytes: 0,
    engineRequests: 0,
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
type Meter = { -readonly [K in keyof CustodyCost]: CustodyCost[K] };
type Queryable = Pick<Pool, 'query'>;
const lifetimes = new WeakMap<Meter, Readonly<{ pool: Pool; context: PublicFilterConsumerContext }>>();
const queryCompletion = new AsyncLocalStorage<(result: QueryResult) => void>();

function requestContext(context: PublicFilterConsumerContext): PublicFilterConsumerContext {
  requireValue(Number.isFinite(context.deadline));
  return Object.freeze({
    deadline: Math.min(context.deadline, deadlineFor(Math.max(1, context.deadline - Date.now()))),
  });
}

function operationCost(pool: Pool, context: PublicFilterConsumerContext): Meter {
  const meter = cost();
  lifetimes.set(meter, { pool, context });
  return meter;
}

/** Keep the original Pool's checkout/release custody, including a checkout arriving after expiry. */
function connection<T>(meter: Meter, work: (client: PoolClient) => Promise<T>, unfinished?: () => boolean): Promise<T> {
  const { pool, context } = lifetimes.get(meter)!;
  let physical: PoolClient | undefined;
  return withBoundedReadLifetime(
    (bounded) =>
      withoutQueryAccounting(() =>
        withConnection(pool, async (raw) => {
          physical = raw;
          const observed = Object.create(raw) as PoolClient;
          observed.query = ((query: NativeReadQueryConfig) => {
            const complete = queryCompletion.getStore();
            // Observe the physical reply even when its caller has already expired.
            return raw.query(query).then((result) => {
              complete?.(result);
              return result;
            });
          }) as PoolClient['query'];
          try {
            return await bounded(observed);
          } finally {
            if (unfinished?.()) discardConnection(raw, new Failure('owner_unavailable'));
          }
        }),
      ),
    (_client, error) => discardConnection(physical!, error),
    context.deadline,
    work,
    {
      deadlineError: () => new Failure('deadline'),
      mapError: (error) => (Date.now() >= context.deadline ? new Failure('deadline') : error),
      isUncertainSettledQueryError: () => true,
    },
  );
}

async function transaction<T>(
  meter: Meter,
  work: (client: PoolClient) => Promise<T>,
  begin = 'BEGIN',
  admit?: () => void,
): Promise<T> {
  const { context } = lifetimes.get(meter)!;
  let unfinished = false;
  let client: PoolClient | undefined;
  let cleanup: Promise<void> | undefined;
  const rollback = () =>
    (cleanup ??= sql(client!, meter, 'ROLLBACK').then((result) => {
      if (result.command !== 'ROLLBACK') throw new Failure('owner_unavailable');
      unfinished = false;
    }));
  try {
    return await connection(
      meter,
      async (bounded) => {
        client = bounded;
        try {
          admit?.();
          unfinished = true;
          const started = await sql(client, meter, begin);
          if (started.command !== 'BEGIN') throw new Failure('owner_unavailable');
          admit?.();
          const value = await work(client);
          admit?.();
          const committed = await sql(client, meter, 'COMMIT');
          if (committed.command !== 'COMMIT') throw new Failure('owner_unavailable');
          unfinished = false;
          admit?.();
          return value;
        } catch (error) {
          // Cleanup spends the same meter and deadline, even after allowance exhaustion.
          if (unfinished && Date.now() < context.deadline) await rollback().catch(() => {});
          throw error;
        }
      },
      () => unfinished,
    );
  } catch (error) {
    // Expiry can precede the callback's catch. Only join cleanup already started
    // within the request; physical retirement never waits for a late owner callback.
    if (cleanup) await cleanup.catch(() => {});
    throw error;
  }
}

class Failure extends Error {
  constructor(readonly reason: CustodyFailure['reason']) {
    super(reason);
  }
}
function check(context: PublicFilterConsumerContext) {
  requireValue(Number.isFinite(context.deadline));
  if (context.deadline <= Date.now()) throw new Failure('deadline');
}
function failure(error: unknown, meter: CustodyCost): CustodyFailure {
  if (error instanceof TypeError) throw error;
  const reason =
    error instanceof Failure || error instanceof PublicFilterRepairSourceError
      ? error.reason
      : error instanceof OpenSearchError && error.status === 404
        ? 'observation_lost'
        : 'owner_unavailable';
  return {
    status: reason === 'deadline' || reason === 'owner_unavailable' ? 'unavailable' : 'unready',
    reason,
    cost: meter,
  };
}
async function sql(
  db: Queryable,
  meter: Meter,
  query: string,
  values: unknown[] = [],
  native?: Readonly<{ points: number; keys: number; writes: number }>,
): Promise<QueryResult> {
  meter.statements++;
  meter.inputKeys += native?.keys ?? values.length;
  if (native) {
    meter.dependencyPoints += native.points;
    meter.rows += native.points;
    meter.resultWrites += native.writes;
  }
  meter.bytes += Buffer.byteLength(query) + Buffer.byteLength(encode(values));
  const complete = (result: QueryResult) => {
    if (!native) meter.rows += result.rowCount ?? 0;
    meter.bytes += Buffer.byteLength(encode(result.rows));
    if (!native && /\b(INSERT|UPDATE|DELETE)\b/.test(query)) meter.resultWrites += result.rowCount ?? 0;
  };
  const dispatch = (client: Queryable) => queryCompletion.run(complete, () => client.query(query, values));
  return db === lifetimes.get(meter)!.pool ? connection(meter, dispatch) : dispatch(db);
}
function isReleaseReference(
  release: CustodyRetainedDefinition['meaning']['release'],
): release is CustodyReleaseReference {
  return 'authority' in release && release.authority === 'semantic.readRelease';
}
async function hasReleaseAuthority(pool: Queryable, meter: Meter, digest: string) {
  const db = { query: (query: string, values?: unknown[]) => sql(pool, meter, query, values) } as Queryable;
  return Boolean((await releaseExists.run(db, { route: 0, digest })) || (await compositeReference.run(db, { digest })));
}
async function requireReleaseAuthority(pool: Queryable, meter: Meter, digest: string) {
  if (!(await hasReleaseAuthority(pool, meter, digest))) throw new Failure('definition_missing');
}
async function retainedDefinition(
  pool: Queryable,
  meter: Meter,
  definition: CustodyDefinition<PublicCanonicalCaptureInput>,
) {
  return encodeRetainedDefinition(definition, await hasReleaseAuthority(pool, meter, definition.meaning.digest));
}
function encodeRetainedDefinition(definition: CustodyDefinition<PublicCanonicalCaptureInput>, installed: boolean) {
  const embedded = encode({ digest: digest(definition), data: definition });
  const embedsWithinLimit = Buffer.byteLength(embedded) <= 1_048_576;
  if (!installed) {
    if (!embedsWithinLimit) throw new Failure('definition_missing');
    return { encoded: embedded, previous: null };
  }
  return { encoded: encodeInstalledDefinition(definition), previous: embedsWithinLimit ? embedded : null };
}
function encodeInstalledDefinition(definition: CustodyDefinition<PublicCanonicalCaptureInput>) {
  // Installed releases share the same immutable owner reference at every size.
  const retained: CustodyRetainedDefinition = {
    ...definition,
    meaning: {
      digest: definition.meaning.digest,
      release: { authority: 'semantic.readRelease', digest: definition.meaning.digest },
    },
  };
  const encoded = encode({ digest: digest(retained), data: retained });
  requireValue(Buffer.byteLength(encoded) <= 1_048_576);
  return encoded;
}
async function engine<T>(
  search: OpenSearch,
  meter: Meter,
  context: PublicFilterConsumerContext,
  method: Parameters<OpenSearch['request']>[0],
  path: string,
  body?: unknown,
) {
  check(context);
  meter.engineRequests++;
  meter.bytes += Buffer.byteLength(path) + Buffer.byteLength(encode(body));
  if (path.endsWith('/_search')) meter.engineSearches++;
  const response = await search.request<T>(method, path, body, {
    timeoutMs: Math.max(1, context.deadline - Date.now()),
  });
  meter.bytes += Buffer.byteLength(encode(response.body));
  if (path.endsWith('/_search'))
    meter.engineIteratorSteps += (response.body as { _shards: { total: number } })._shards.total;
  return response.body;
}
async function native(
  search: OpenSearch,
  meter: Meter,
  context: PublicFilterConsumerContext,
  target: string,
): Promise<string> {
  requireValue(/^[a-z0-9][a-z0-9_-]{0,254}$/.test(target));
  const metadata = await engine<Record<string, { settings: { index: { uuid: string } } }>>(
    search,
    meter,
    context,
    'GET',
    `/${target}/_settings`,
  );
  if (Object.keys(metadata).length !== 1 || !metadata[target]?.settings.index.uuid)
    throw new Failure('binding_mismatch');
  return metadata[target]!.settings.index.uuid;
}
function validateDefinition(definition: CustodyDefinition<PublicCanonicalCaptureInput>) {
  home(definition.source.partition);
  requireValue(Number.isInteger(definition.source.epoch) && definition.source.epoch > 0);
  text(definition.source.id);
  text(definition.source.configuration);
  text(definition.readDefinition);
  requireValue(hasExactPublicFilterMeaning(definition.meaning));
  const input = definition.capture;
  requireValue(Object.hasOwn(input, 'filterDocument') && Object.hasOwn(input, 'text'));
  if ('purpose' in input) {
    validatePublicSuggestionInput(input);
    // Source resolves complete prefix/order/name dependencies; custody does not invent callback keys.
    return;
  }
  if ('representation' in input) {
    const compiled = compileDiscoveryConsumerCapture(input, definition.meaning, undefined);
    for (const key of compiled.dependencyKeys)
      requireValue(definition.dependencyKeys.some((entry) => encode(entry) === encode(key)));
    return;
  }
  requireValue(Number.isInteger(input.size) && input.size >= 1 && input.size <= 200);
  requireValue(['id', 'name', 'relevance', 'collections', 'rating'].includes(input.sort));
  if (input.filterDocument) {
    for (const node of walkFilter(input.filterDocument)) requireValue(!('owner' in node) && !('saved' in node));
    admitFilter(input.filterDocument, definition.meaning.release);
  }
  const filter = input.filterDocument
    ? compileFilter(input.filterDocument, { prefix: 'f', relationOverflow: true })
    : undefined;
  const compiledText = input.text ? compileText(input.text, { field: 'search_text', prefix: 't' }) : undefined;
  const properties = [
    ...new Set(
      filter?.leaves.flatMap((leaf) =>
        leaf.facet === 'statement' ? [leaf.property, ...(leaf.qualifiers?.map((q) => q.property) ?? [])] : [],
      ),
    ),
  ];
  const keys: PublicFilterDependencyKey[] = [{ kind: 'order', order: input.sort }];
  if (filter?.leaves.some((leaf) => leaf.facet === 'type')) keys.push({ kind: 'type' });
  keys.push(...properties.map((property) => ({ kind: 'property' as const, property })));
  // Source owns additional implicit text/order keys. Every compiler leaf must be retained, including NOT.
  for (const key of keys) requireValue(definition.dependencyKeys.some((entry) => encode(entry) === encode(key)));
  for (const [key, derived] of Object.entries({
    filter: filter?.query,
    query: compiledText?.query,
    boost: compiledText?.leaves
      .filter((leaf) => !leaf.negated)
      .map((leaf) => leaf.value)
      .join(' '),
  })) {
    if (Object.hasOwn(input, key)) requireValue(encode(input[key as keyof typeof input]) === encode(derived));
  }
  if (Object.hasOwn(input, 'overflowProperties')) {
    const actual = input.overflowProperties;
    const required = filter
      ? [...new Set(filter.leaves.flatMap((leaf) => (leaf.facet === 'statement' ? [leaf.property] : [])))]
      : [];
    requireValue(
      Array.isArray(actual) &&
        actual.every((property) => typeof property === 'string') &&
        required.every((property) => actual.includes(property)),
    );
  }
}
async function read(
  pool: Queryable,
  request: CustodyRead,
  context: PublicFilterConsumerContext,
  meter: Meter,
  verifiedDefinition?: CustodyRetainedDefinition,
): Promise<CustodyFound> {
  check(context);
  queried(request.queried);
  const execution = request.execution;
  if (execution !== undefined) text(execution);
  const q = request.queried;
  const result = await sql(pool, meter, readSql, [
    partition(q.snapshot.observation),
    q.snapshot.observation,
    encode(q),
    q.consumer.incarnation,
    Date.now(),
    execution ?? null,
    repairBootstrap(q),
  ]);
  const row = result.rows[0];
  check(context);
  if (!row) throw new Failure('observation_lost');
  if (row.failure) throw new Failure(row.failure);
  const definition = decode<{ digest: string; data: CustodyRetainedDefinition }>(row.definition);
  requireValue(definition.digest === digest(definition.data));
  if (isReleaseReference(definition.data.meaning.release)) {
    requireValue(definition.data.meaning.release.digest === definition.data.meaning.digest);
    if (verifiedDefinition !== undefined && !isDeepStrictEqual(verifiedDefinition, definition.data))
      throw new Failure('binding_mismatch');
    if (verifiedDefinition === undefined) await requireReleaseAuthority(pool, meter, definition.data.meaning.digest);
    check(context);
  }
  return {
    status: 'found',
    definition: definition.data,
    queried: decode(row.queried),
    covered: decode(row.covered),
    execution: execution === undefined ? null : decode(row.execution),
    cost: meter,
  };
}

function preparationKey(
  registration: CustodyRegistration,
  build: string,
  generation: bigint,
): PublicFilterPreparationSegmentKey {
  return { partition: registration.partition, registration: registration.id, build, generation };
}

function preparationFrontier(
  row:
    | {
        segment_state: CustodyPreparationFrontier['state'];
        raw_count: number;
        output_count: number;
        source_cursor: string | null;
        raw_exhausted: boolean;
      }
    | undefined,
): CustodyPreparationFrontier {
  if (!row) return { state: 'missing', rawCount: 0, outputCount: 0, after: undefined, rawExhausted: false };
  return {
    state: row.segment_state,
    rawCount: row.raw_count,
    outputCount: row.output_count,
    after: row.source_cursor === null ? undefined : decode(row.source_cursor),
    rawExhausted: row.raw_exhausted,
  };
}

function preparationCursor(value: readonly (string | number | null)[] | undefined) {
  return value === undefined ? null : encode(value);
}

export async function readPublicFilterConsumerCustody(
  pool: Pool,
  request: CustodyRead,
  context: PublicFilterConsumerContext,
): Promise<CustodyFound | CustodyFailure> {
  context = requestContext(context);
  const meter = operationCost(pool, context);
  try {
    return await read(pool, request, context, meter);
  } catch (error) {
    return failure(error, meter);
  }
}

// Constructor routing only, analogous to publicFilterSourceOrigin. No receipt, positive result,
// settlement or retained state is cached here. Recovery must install the real owner binding again.
const repairSources = new WeakMap<Pool, PublicFilterRepairSourceBinding>();
const repairAllowance = new AsyncLocalStorage<Readonly<{ spent: CustodyCost; maintenance: boolean }>>();
const discoveryRepair = new AsyncLocalStorage<{ observation: string; target: string; bootstrap: string }>();

/** Background repair retains an adopted cut as evidence after its serving PIT expires. */
export function withDiscoveryRepairCustody<T>(q: PublicFilterQueriedObservation, bootstrap: string, work: () => T): T {
  return discoveryRepair.run(
    { observation: q.snapshot.observation, target: q.consumer.physicalTarget, bootstrap },
    work,
  );
}

function repairBootstrap(q: PublicFilterQueriedObservation): string | null {
  const repair = discoveryRepair.getStore();
  return q.snapshot.kind === 'pit' &&
    repair?.observation === q.snapshot.observation &&
    repair.target === q.consumer.physicalTarget &&
    /discovery-g[1-9][0-9]*$/.test(repair.target)
    ? repair.bootstrap
    : null;
}

/** Keep all reader phases within the calling consumer's already-spent allowance. */
export function withPublicFilterRepairAllowance<T>(
  spent: CustodyCost,
  work: () => Promise<T>,
  maintenance = false,
): Promise<T> {
  return repairAllowance.run({ spent: { ...spent }, maintenance }, work);
}

// Only the generation's maintenance call can receive a repair candidate from this read.
// The candidate is invocation-local and never a successful settlement.
const publicationRepair = new AsyncLocalStorage<{ job: string; writer?: SupersededSearchRepair }>();
export async function readWithPublicationWriterRepair<T>(job: string, read: () => Promise<T>) {
  const attempt: { job: string; writer?: SupersededSearchRepair } = { job };
  const result = await publicationRepair.run(attempt, read);
  return { result, writer: attempt.writer };
}

/** The sole native guard: owner verification runs between released and freshly reopened local homes. */
type VerificationRow = { revision: string; progress: string | null };
type RepairVerificationProgress = {
  identity: string;
  linked: number;
  linkFrontier: string | null;
  after: number;
  page: number | null;
  item: number;
  winners: {
    basis: string;
    own: number;
    home: number;
    subject: string | null;
    done: boolean;
    superseded?: RepairWinnerCoordinate;
  } | null;
};
type RepairWinnerCoordinate = { subject: string; page: number | null; item: number | null };
type RepairSubjectVerification = RepairWinnerCoordinate & {
  home: number;
  pending_source: string | null;
  position: string | null;
  completion: string | null;
};

export async function readPublicFilterRepairSettlement(
  pool: Pool,
  request: Readonly<{
    queried: PublicFilterQueriedObservation;
    execution: string;
    commitReceiverManifest?: true;
  }>,
  context: PublicFilterConsumerContext,
): Promise<PublicFilterRepairSettlementResult> {
  context = requestContext(context);
  const meter = operationCost(pool, context);
  const allowance = repairAllowance.getStore();
  const spent = allowance?.spent ?? cost();
  const inputLimit = 1000;
  const input = structuredClone(request);
  try {
    check(context);
    queried(input.queried);
    text(input.execution);
    const binding = repairSources.get(pool);
    const url = process.env.OPENSEARCH_URL;
    if (!url || typeof binding?.readRepairStep !== 'function' || typeof binding.readRepairReceipt !== 'function')
      throw new Failure('owner_unavailable');
    const transport = createOpenSearch(url);
    const capacity = () => {
      const inputs = spent.inputKeys + meter.inputKeys;
      // The owning publication meter charges maintenance by native inputs.
      const width = Math.max(allowance?.maintenance ? inputs : spent.candidates + meter.candidates, 1);
      return {
        keys: inputLimit - inputs,
        bytes: 4 * 1024 * 1024 - spent.bytes - meter.bytes,
        rows: 64 + 16 * width - spent.rows - meter.rows,
        points:
          16 + 8 * width - spent.accessPoints - meter.accessPoints - spent.dependencyPoints - meter.dependencyPoints,
      };
    };
    const admit = () => {
      check(context);
      if (Object.values(capacity()).some((remaining) => remaining < 0)) throw new Failure('owner_unavailable');
    };
    const charge = (next?: PublicFilterCost) => {
      if (next)
        for (const key of Object.keys(meter) as (keyof CustodyCost)[]) {
          const value = Reflect.get(next, key) ?? 0;
          if (!Number.isSafeInteger(value) || value < 0) throw new Failure('owner_unavailable');
          meter[key] += value;
        }
      admit();
    };
    const search: OpenSearch = {
      async request(method, path, body, options) {
        admit();
        meter.engineRequests++;
        meter.bytes +=
          Buffer.byteLength(path) + Buffer.byteLength(encode(body)) + Buffer.byteLength(encode(options?.query));
        if (path.endsWith('/_search')) meter.engineSearches++;
        const result = await transport.request(method, path, body, {
          ...options,
          timeoutMs: Math.max(1, context.deadline - Date.now()),
        });
        meter.bytes += Buffer.byteLength(encode(result.body));
        if (path.endsWith('/_search')) {
          const shards = (result.body as { _shards?: { total?: number } })._shards?.total;
          if (Number.isSafeInteger(shards) && shards! > 0) meter.engineIteratorSteps += shards!;
        }
        admit();
        return result as never;
      },
      bulk() {
        throw new TypeError('Settlement reader never dispatches writes');
      },
    };
    // Resolve wide immutable release authority without holding Search's retained checkout.
    const initial = await read(pool, input, context, meter);
    admit();
    const subjectPublication =
      publicationRepair.getStore()?.job === input.execution && !('representation' in initial.definition.capture);
    const q = input.queried;
    const home = partition(q.snapshot.observation);
    const keys = {
      partition_no: home,
      observation: q.snapshot.observation,
      execution: input.execution,
    };
    const keyValues = [keys.partition_no, keys.observation, keys.execution];
    const local = async <T>(work: (db: Queryable, raw: Queryable) => Promise<T>): Promise<T> =>
      transaction(
        meter,
        async (client) => {
          const db = {
            query: async (statement: string, values: unknown[] = []) => {
              admit();
              const result = await sql(client, meter, statement, values);
              admit();
              return result;
            },
          } as Queryable;
          return work(db, client);
        },
        'BEGIN ISOLATION LEVEL REPEATABLE READ',
        admit,
      );
    const authority = async (db: Queryable, targets: string[], lock = false) => {
      const points = targets.length * 4;
      // Each target is one bounded range probe over four native revision rows.
      meter.inputKeys += points - 1;
      meter.dependencyPoints += targets.length;
      meter.rows += points - 1;
      const result = await db.query<{ revisions: string[] }>(
        `SELECT array_agg(revision::text ORDER BY physical_target,lane) AS revisions
         FROM (
           SELECT physical_target,lane,revision FROM search.public_filter_repair_authority
           WHERE physical_target=ANY($1::text[]) ORDER BY physical_target,lane ${lock ? 'FOR SHARE' : ''}
         ) authority`,
        [targets],
      );
      if (result.rows[0]?.revisions?.length !== points) throw new Failure('owner_unavailable');
      return digest(result.rows[0].revisions);
    };
    const load = async (db: Queryable, raw: Queryable) => {
      const stateRow = await repairState.run(db, keys);
      if (!stateRow?.repair_settlement || !stateRow.consumer_work) throw new Failure('execution_missing');
      const state = decode<RetainedRepairSettlement>(stateRow.repair_settlement);
      const retained = await read(raw, input, context, meter, initial.definition);
      admit();
      if (
        !retained.execution ||
        !state.closed ||
        !Number.isSafeInteger(state.pages) ||
        state.pages < 1 ||
        state.frontier !== null
      )
        throw new Failure('owner_unavailable');
      if (
        state.execution !== retained.execution.id ||
        !isDeepStrictEqual(state.covered, retained.covered) ||
        state.bootstrap !== retained.covered.observation ||
        stateRow.consumer_bootstrap !== state.bootstrap ||
        !isDeepStrictEqual(retained.definition, initial.definition) ||
        !isDeepStrictEqual(retained.execution, initial.execution)
      )
        throw new Failure('binding_mismatch');
      const work = decode<{
        bootstrap: { id: string; covered: unknown };
        execution: string;
        queried: PublicFilterQueriedObservation;
        repairPage: unknown;
        records: unknown[];
        projectionSource: unknown;
        repair: unknown;
        dispatch: unknown;
      }>(stateRow.consumer_work);
      if (
        work.bootstrap.id !== state.bootstrap ||
        !isDeepStrictEqual(work.bootstrap.covered, retained.covered) ||
        !isDeepStrictEqual(work.queried, q) ||
        work.execution !== input.execution
      )
        throw new Failure('binding_mismatch');
      if (work.repairPage || work.records.length || work.projectionSource || work.repair || work.dispatch)
        throw new Failure('owner_unavailable');
      const target = await repairTarget.run(db, {
        partition_no: home,
        physical_target: q.consumer.physicalTarget,
      });
      const registration = await repairRegistration.run(db, {
        partition_no: home,
        registration: stateRow.registration,
      });
      if (
        !registration ||
        !isDeepStrictEqual(decode(registration.consumer), q.consumer) ||
        target?.incarnation !== q.consumer.incarnation
      )
        throw new Failure('binding_mismatch');
      const sourceTargets = ['', '@source', ...('representation' in retained.definition.capture ? ['@accounts'] : [])];
      const sourceVersion = await authority(db, sourceTargets);
      const identity = digest({
        ...state,
        sourceVersion,
        fence: null,
        definition: retained.definition,
        execution: retained.execution,
        queried: retained.queried,
        work: stateRow.consumer_work,
        registration: stateRow.registration,
      });
      let row = (
        await db.query<VerificationRow>(
          `SELECT revision::text,progress FROM search.public_filter_repair_verification
           WHERE (partition_no,observation,execution)=($1,$2,$3) FOR UPDATE`,
          keyValues,
        )
      ).rows[0];
      if (!row) {
        row = (
          await db.query<VerificationRow>(
            `INSERT INTO search.public_filter_repair_verification(partition_no,observation,execution)
             VALUES ($1,$2,$3) RETURNING revision::text,progress`,
            keyValues,
          )
        ).rows[0]!;
      }
      let progress = row.progress ? decode<RepairVerificationProgress>(row.progress) : null;
      if (progress && progress.identity !== identity) {
        row = (
          await db.query<VerificationRow>(
            `UPDATE search.public_filter_repair_verification SET revision=revision+1,progress=NULL
             WHERE (partition_no,observation,execution)=($1,$2,$3) RETURNING revision::text,progress`,
            keyValues,
          )
        ).rows[0]!;
        progress = null;
      }
      return {
        state,
        stateRow,
        retained,
        identity,
        sourceVersion,
        sourceTargets,
        revision: row.revision,
        rowProgress: row.progress,
        progress: progress ?? {
          identity,
          linked: -1,
          linkFrontier: null,
          after: -1,
          page: null,
          item: 0,
          winners: null,
        },
      };
    };
    const verifySource = async (state: RetainedRepairSettlement, page: RetainedRepairPage) => {
      const execution = {
        bootstrap: state.bootstrap,
        queried: q,
        execution: input.execution,
      };
      const verify = () =>
        withRequestDeadline(context.deadline, () =>
          verifyPublicFilterRepairSourcePage(
            binding,
            { ...execution, predecessor: page.predecessor },
            page,
            context,
            charge,
          ),
        );
      await (withNativePublicFilterRepairReadBatch?.(binding, execution, context, verify, {
        ids: page.account ? [page.account.id] : [],
        charge,
      }) ?? verify());
    };
    const save = async (
      db: Queryable,
      current: Awaited<ReturnType<typeof load>>,
      progress: RepairVerificationProgress,
    ) => {
      const result = await db.query(
        `UPDATE search.public_filter_repair_verification SET progress=$5
         WHERE (partition_no,observation,execution)=($1,$2,$3) AND revision=$4
           AND progress IS NOT DISTINCT FROM $6::text`,
        [...keyValues, current.revision, encode(progress), current.rowProgress],
      );
      if (result.rowCount !== 1) throw new Failure('binding_mismatch');
      meter.frontierWrites++;
    };
    const linkPages = async (db: Queryable, current: Awaited<ReturnType<typeof load>>) => {
      const { progress, state } = current;
      const width = Math.min(32, state.pages - 1 - progress.linked);
      meter.inputKeys += width;
      meter.dependencyPoints++;
      const rows = (
        await db.query<{
          ordinal: number;
          has_repairs: boolean;
          source_step: string;
          predecessor: string | null;
          frontier: string | null;
          complete: boolean;
          nonempty: boolean;
        }>(
          `WITH next AS MATERIALIZED (
             SELECT ordinal,has_repairs,intent::jsonb AS tree FROM search.public_filter_repair_page
             WHERE (partition_no,observation,execution)=($1,$2,$3) AND ordinal>$4 ORDER BY ordinal LIMIT $5
           )
           SELECT ordinal,has_repairs,body->'sourceStep'->>1 AS source_step,body->'predecessor'->>1 AS predecessor,
             body->'frontier'->>1 AS frontier,body->'complete'->1 AS complete,
             (jsonb_array_length(body->'repairs'->1)>0 OR body ? 'account' OR body ? 'subject') AS nonempty
           FROM next CROSS JOIN LATERAL (
             SELECT jsonb_object_agg(entry->>0,entry->1) AS body FROM jsonb_array_elements(
               CASE WHEN tree->>0='references' THEN tree#>'{1,1,1}' ELSE tree->1 END
             ) entry
           ) page ORDER BY ordinal`,
          [...keyValues, progress.linked, width],
        )
      ).rows;
      if (rows.length !== width) throw new Failure('owner_unavailable');
      let { linked, linkFrontier } = progress;
      for (const row of rows) {
        const terminal = row.ordinal === state.pages - 1;
        if (
          row.ordinal !== linked + 1 ||
          !row.source_step ||
          row.predecessor !== linkFrontier ||
          row.complete !== terminal ||
          row.frontier !== (terminal ? null : row.source_step) ||
          row.nonempty !== row.has_repairs
        )
          throw new Failure('binding_mismatch');
        linked = row.ordinal;
        linkFrontier = row.frontier;
      }
      await save(db, current, { ...progress, linked, linkFrontier });
    };
    const remainingBytes = () => capacity().bytes;
    const coordinates = (page: RetainedRepairPage) => (page.account || page.subject ? 1 : page.repairs.length);
    const validatePage = (page: RetainedRepairPage, ordinal: number, terminal: number) => {
      if (
        ordinal < 0 ||
        ordinal > terminal ||
        !page.sourceStep ||
        page.repairs.length > 256 ||
        ((page.account || page.subject) && (page.repairs.length || page.complete || (page.account && page.subject))) ||
        page.complete !== (ordinal === terminal) ||
        page.frontier !== (page.complete ? null : page.sourceStep)
      )
        throw new Failure('binding_mismatch');
    };
    const foldEffects = async (db: Queryable, current: Awaited<ReturnType<typeof load>>) => {
      const { progress, revision, state } = current;
      const ordinal = progress.page!;
      const retained = await repairPage.run(db, { ...keys, ordinal });
      if (!retained) throw new Failure('owner_unavailable');
      const page = decode<RetainedRepairPage>(retained.intent);
      validatePage(page, ordinal, state.pages - 1);
      const end = Math.min(progress.item + 8, coordinates(page));
      const items = [];
      for (let item = progress.item; item < end; item++)
        if (page.account || page.subject || page.repairs[item]!.projection.status === 'complete') items.push(item);
      meter.inputKeys += items.length;
      meter.dependencyPoints += items.length;
      const effects = items.length
        ? await repairEffects.run(db, {
            ...keys,
            page: ordinal,
            items,
            bytes: Math.max(0, remainingBytes() - 128 * 1024),
          })
        : [];
      const values = new Map<string, RepairSubjectVerification>();
      let item = progress.item;
      for (; item < end; item++) {
        const repair = page.repairs[item];
        const account = page.account;
        const subjectSource = page.subject ?? repair?.source;
        const subject = account?.id ?? subjectSource!.subject;
        const partition_no = subjectPartition(subject);
        const source = subjectSource ? encode(subjectSource) : null;
        const receipt = effects.find((effect) => effect.item === item);
        const complete = !!account || !!page.subject || repair!.projection.status === 'complete';
        if (complete && !receipt) break;
        meter.candidates++;
        meter.inputKeys++;
        meter.accessPoints++;
        meter.dependencyPoints++;
        admit();
        if (
          repair &&
          ((repair.projection.status !== 'progress' && repair.projection.status !== 'complete') ||
            !isDeepStrictEqual(repair.source, repair.projection.source) ||
            repair.source.partition !== partition_no ||
            subject !== repair.locator.subject)
        )
          throw new Failure('binding_mismatch');
        const previous = values.get(subject) ??
          (
            await db.query<RepairSubjectVerification>(
              `SELECT subject::text,home,pending_source,page,item,position::text,completion::text
             FROM search.public_filter_repair_subject
             WHERE (partition_no,observation,execution,subject)=($1,$2,$3,$4) AND revision=$5`,
              [...keyValues, subject, revision],
            )
          ).rows[0] ?? {
            subject,
            home: partition_no,
            pending_source: null,
            page: null,
            item: null,
            position: null,
            completion: null,
          };
        if (!account && previous.pending_source && (page.subject || previous.pending_source !== source))
          throw new Failure('binding_mismatch');
        if (!complete) {
          values.set(subject, { ...previous, pending_source: source });
          continue;
        }
        const writer = decode<PublicFilterRepairWriterReceipt>(receipt!.receipt);
        if (
          writer.locator !==
            encode({
              observation: keys.observation,
              execution: keys.execution,
              page: ordinal,
              item,
            }) ||
          writer.subject !== subject ||
          writer.partition !== (account?.head.partition ?? subjectSource!.partition) ||
          writer.epoch !== (account?.head.epoch ?? subjectSource!.epoch) ||
          repairWriterPosition(writer) < (account?.position ?? subjectSource!.position) ||
          (page.subject && (page.subject.partition !== partition_no || isDiscoveryRepairWriterReceipt(writer))) ||
          writer.incarnation !== q.consumer.incarnation ||
          (account &&
            (!isDiscoveryRepairWriterReceipt(writer) ||
              writer.owner !== 'accounts' ||
              !writer.account ||
              !isDeepStrictEqual({ ...writer.account, position: account.position }, account))) ||
          (previous.position !== null &&
            (repairWriterPosition(writer) < BigInt(previous.position) ||
              writer.enrollment.position <= BigInt(previous.completion!)))
        )
          throw new Failure('binding_mismatch');
        validatePublicFilterRepairWriterEvidence(q.consumer.physicalTarget, writer);
        values.set(subject, {
          ...previous,
          pending_source: account ? previous.pending_source : null,
          page: ordinal,
          item,
          position: String(repairWriterPosition(writer)),
          completion: String(writer.completion.position),
        });
      }
      if (item === progress.item) throw new Failure('owner_unavailable');
      meter.inputKeys += values.size;
      meter.dependencyPoints += values.size;
      await db.query(
        `INSERT INTO search.public_filter_repair_subject
           (partition_no,observation,execution,revision,subject,home,pending_source,page,item,position,completion)
         SELECT $1,$2,$3,$4,s.* FROM jsonb_to_recordset($5::jsonb)
           s(subject uuid,home integer,pending_source text,page integer,item integer,position bigint,completion bigint)
         ON CONFLICT (partition_no,observation,execution,subject) DO UPDATE
         SET (revision,home,pending_source,page,item,position,completion)=
           (EXCLUDED.revision,EXCLUDED.home,EXCLUDED.pending_source,EXCLUDED.page,EXCLUDED.item,EXCLUDED.position,EXCLUDED.completion)`,
        [...keyValues, revision, JSON.stringify([...values.values()])],
      );
      await save(
        db,
        current,
        item === coordinates(page) ? { ...progress, after: ordinal, page: null, item: 0 } : { ...progress, item },
      );
    };
    const refreshed = async () => {
      const result = await search.request('POST', `/${q.consumer.physicalTarget}/_refresh`);
      validateRefreshResponse(result.status, result.body);
      return result.body;
    };
    const physical_target = q.consumer.physicalTarget;
    const physicalFor = async (db: Queryable) => {
      const physical = await readPublicFilterRepairPhysicalTarget(db, search, physical_target);
      if (physical.incarnation !== q.consumer.incarnation) throw new Failure('binding_mismatch');
      return physical;
    };
    const winner = async (
      db: Queryable,
      current: Awaited<ReturnType<typeof load>>,
      physical: Awaited<ReturnType<typeof physicalFor>>,
      subject: string,
      coordinate?: Pick<RepairSubjectVerification, 'page' | 'item'>,
    ): Promise<SupersededSearchRepair | undefined> => {
      const partition_no = subjectPartition(subject);
      meter.candidates++;
      meter.inputKeys += 6;
      admit();
      const [gate] = await repairGate.run(db, {
        homes: [partition_no],
        physical_target,
      });
      const [owner] = await repairOwner.run(db, { homes: [partition_no] });
      const [writer] = await repairWriters.run(db, {
        subjects: [{ partition_no, original_id: subject }],
        physical_target,
      });
      if (owner?.write_state !== 'active') throw new Failure('owner_unavailable');
      if (
        (gate &&
          (gate.incarnation !== physical.incarnation ||
            gate.write_alias !== physical.writeAlias ||
            gate.closed_token ||
            gate.owner_epoch !== owner.epoch)) ||
        (writer &&
          (writer.writer_token ||
            writer.closed_job ||
            writer.dispatch_state !== 'settled' ||
            writer.incarnation !== physical.incarnation ||
            writer.owner_epoch !== owner.epoch))
      )
        throw new Failure('identity_pending');
      if (!coordinate) return;
      const stored = await repairEffect.run(db, {
        ...keys,
        page: coordinate.page!,
        item: coordinate.item!,
      });
      if (!stored) throw new Failure('owner_unavailable');
      let receipt = decode<PublicFilterRepairWriterReceipt>(stored.receipt);
      if (
        q.snapshot.kind === 'prepared' &&
        !isDiscoveryRepairWriterReceipt(receipt) &&
        writer &&
        writer.writer_transaction_id !== receipt.enrollment.transactionId
      ) {
        const inspected = inspectSearchRepairWriter(physical_target, receipt, writer);
        if (!inspected) throw new Failure('identity_pending');
        const publication = (
          await db.query<{ phase: string; fence: string | null }>(
            `SELECT phase,fence FROM search.generation_publication
             WHERE (partition_no,job)=(0,$1::uuid) AND family='subjects' AND source_home=0
               AND physical_target=$2 AND native_incarnation=$3 AND consumer=$4::jsonb
               AND bootstrap=$5 AND queried=$6 AND observation=$7 AND execution=$1::text`,
            [
              input.execution,
              physical_target,
              q.consumer.incarnation,
              q.consumer,
              current.state.bootstrap,
              encodeGenerationPublicationQueried(q),
              keys.observation,
            ],
          )
        ).rows[0];
        if (publication) {
          if ('current' in inspected) receipt = inspected.current;
          else {
            if (publication.phase !== 'reconciled' || publication.fence !== null) throw new Failure('identity_pending');
            return inspected.superseded;
          }
        }
      }
      assertRetainedRepairWriterFence(receipt, gate, writer, owner);
      if (isDiscoveryRepairWriterReceipt(receipt)) {
        if (!('allocation' in physical) || typeof physical.allocation !== 'string')
          throw new Failure('binding_mismatch');
        await verifyDiscoveryRepairWinners(
          db,
          search,
          physical_target,
          { ...physical, allocation: physical.allocation },
          [receipt],
        );
      } else {
        if (physical.writeAlias !== receipt.writeAlias) throw new Failure('binding_mismatch');
        await readSearchRepairWinner(search, physical_target, receipt.action);
      }
    };
    const reopen = async (db: Queryable, raw: Queryable, current: Awaited<ReturnType<typeof load>>) => {
      const { progress, revision, retained, state } = current;
      const owners = [...new Set([home, retained.definition.source.partition])];
      const ownerRows = await repairOwner.run(db, { homes: owners });
      if (
        ownerRows.length !== owners.length ||
        ownerRows.some(
          (owner) =>
            owner.write_state !== 'active' ||
            (owner.partition_no === retained.definition.source.partition &&
              owner.epoch !== retained.definition.source.epoch),
        )
      )
        throw new Failure('owner_unavailable');

      if (!progress.winners) {
        const pending = await db.query(
          `SELECT 1 FROM search.public_filter_repair_subject WHERE
           (partition_no,observation,execution,revision)=($1,$2,$3,$4) AND pending_source IS NOT NULL LIMIT 1`,
          [...keyValues, revision],
        );
        if (pending.rowCount) throw new Failure('owner_unavailable');
        meter.inputKeys += 4;
        await db.query(
          `INSERT INTO search.public_filter_repair_authority(physical_target,lane)
           SELECT $1,lane FROM generate_series(0,3) lane ON CONFLICT DO NOTHING`,
          [physical_target],
        );
      }
      const physical = await physicalFor(db);
      const authorityVersion = await authority(db, [physical_target]);
      const checkpoint = async () =>
        digest(await readRepairWinnerCheckpoint(search, physical_target, physical.incarnation));
      const engineVersion = await checkpoint();
      const basis = digest({ authorityVersion, engineVersion, physical });
      const previous = progress.winners;
      const cursor: NonNullable<RepairVerificationProgress['winners']> =
        previous?.basis === basis ? { ...previous } : { basis, own: 0, home: -1, subject: null, done: false };
      if (previous?.basis !== basis) await refreshed();

      const own = [...new Set(retained.execution!.ownRows.flatMap((row) => [row.original, row.terminal]))].sort();
      // Bound both owner/writer work and exact engine bodies in this transaction.
      let checked = 0;
      while (!cursor.done && checked < 8 && (checked === 0 || room())) {
        if (cursor.own < own.length) {
          await winner(db, current, physical, own[cursor.own]!);
          cursor.own++;
        } else {
          const next = (
            await db.query<RepairSubjectVerification>(
              `SELECT subject::text,home,page,item FROM search.public_filter_repair_subject
               WHERE (partition_no,observation,execution,revision)=($1,$2,$3,$4)
                 AND page IS NOT NULL AND (home,subject)>($5,COALESCE($6::uuid,'00000000-0000-0000-0000-000000000000'))
               ORDER BY home,subject LIMIT 1`,
              [...keyValues, revision, cursor.home, cursor.subject],
            )
          ).rows[0];
          if (!next) {
            cursor.done = true;
            break;
          }
          if ((await winner(db, current, physical, next.subject, next)) && !cursor.superseded)
            cursor.superseded = { subject: next.subject, page: next.page, item: next.item };
          cursor.home = next.home;
          cursor.subject = next.subject;
        }
        checked++;
      }
      const superseded =
        cursor.done && cursor.superseded
          ? await winner(db, current, physical, cursor.superseded.subject, cursor.superseded)
          : undefined;
      if (cursor.done && cursor.superseded && !superseded) throw new Failure('identity_pending');
      if (
        authorityVersion !== (await authority(db, [physical_target], true)) ||
        current.sourceVersion !== (await authority(db, current.sourceTargets, true)) ||
        engineVersion !== (await checkpoint()) ||
        !isDeepStrictEqual(await physicalFor(db), physical)
      )
        throw new Failure('identity_pending');
      if (superseded) {
        const attempt = publicationRepair.getStore();
        if (attempt?.job === input.execution) attempt.writer = superseded;
        throw new Failure('identity_pending');
      }
      if (!cursor.done) {
        await save(db, current, { ...progress, winners: cursor });
        return null;
      }
      const allocation =
        'allocation' in physical && typeof physical.allocation === 'string' ? physical.allocation : undefined;
      const priorFence = state.fence;
      const retainedRefresh =
        previous?.done &&
        previous.basis === basis &&
        priorFence !== null &&
        (subjectPublication || allocation !== undefined) &&
        priorFence.allocation === allocation &&
        priorFence.incarnation === physical.incarnation &&
        priorFence.writeAlias === physical.writeAlias &&
        priorFence.sourceEpoch === retained.definition.source.epoch;
      const refresh = retainedRefresh ? priorFence.refresh : await refreshed();
      validateRefreshResponse(200, refresh);
      if (
        !(subjectPublication && retainedRefresh) &&
        (engineVersion !== (await checkpoint()) || !isDeepStrictEqual(await physicalFor(db), physical))
      )
        throw new Failure('binding_mismatch');
      const final = await read(raw, input, context, meter, initial.definition);
      if (!isDeepStrictEqual(final.execution, retained.execution) || !isDeepStrictEqual(final.covered, state.covered))
        throw new Failure('binding_mismatch');
      const transaction = await repairTransaction.run(db);
      if (!transaction?.id) throw new Failure('owner_unavailable');
      const fenced: RetainedRepairSettlement = {
        ...state,
        fence: {
          transaction: transaction.id,
          incarnation: physical.incarnation,
          ...(allocation === undefined ? {} : { allocation }),
          writeAlias: physical.writeAlias,
          sourceEpoch: retained.definition.source.epoch,
          refresh,
        },
      };
      const stored = await repairFinish.run(db, {
        ...keys,
        next: encode(fenced),
        previous: current.stateRow.repair_settlement!,
      });
      if (stored.length !== 1) throw new Failure('binding_mismatch');
      if (!previous?.done || previous.basis !== basis) await save(db, current, { ...progress, winners: cursor });
      if (input.commitReceiverManifest) {
        if (!subjectPublication) throw new Failure('binding_mismatch');
        // The database binds this insert to repairFinish's own fenced transaction.
        // Original range, terminal, authority lanes and their FKs are bounded points.
        meter.inputKeys += 76;
        meter.rows += 76;
        meter.dependencyPoints += 76;
        meter.frontierWrites++;
        admit();
        await db.query(`INSERT INTO search.public_filter_ack_manifest(job) VALUES ($1::uuid)`, [input.execution]);
      }
      return {
        status: 'settled' as const,
        definition: retained.definition,
        queried: retained.queried,
        execution: retained.execution!,
        settlement: Object.freeze({
          id: state.id,
        }) as NativePublicFilterRepairSettlement,
        cost: meter,
      };
    };
    const room = () => {
      const remaining = capacity();
      return remaining.bytes >= 1_500_000 && remaining.keys >= 160 && remaining.rows >= 32 && remaining.points >= 10;
    };
    for (let step = 0; step < 32; step++) {
      const stage = await local(async (db, raw) => {
        const current = await load(db, raw);
        const { progress, state } = current;
        if (progress.linked < state.pages - 1) {
          await linkPages(db, current);
          return { kind: 'advanced' as const };
        }
        if (progress.page !== null) {
          await foldEffects(db, current);
          return { kind: 'advanced' as const };
        }
        const terminal = state.pages - 1;
        // The exact terminal page is already verified under this retained Source
        // authority revision. Reopen live writer and engine evidence directly.
        if (subjectPublication && progress.after === terminal) {
          const result = await reopen(db, raw, current);
          return result ? { kind: 'settled' as const, result } : { kind: 'advanced' as const };
        }
        const row = await repairPages.run(db, {
          ...keys,
          after: progress.after,
          terminal,
        });
        if (!row) throw new Failure('owner_unavailable');
        const page = decode<RetainedRepairPage>(row.intent);
        validatePage(page, row.ordinal, terminal);
        if (row.ordinal <= progress.after && row.ordinal !== terminal) throw new Failure('binding_mismatch');
        return { kind: 'source' as const, row, page, current };
      });
      if (stage.kind === 'settled') return stage.result;
      if (stage.kind === 'source') {
        await verifySource(stage.current.state, stage.page);
        const result = await local(async (db, raw) => {
          const current = await load(db, raw);
          if (
            stage.current.identity !== current.identity ||
            stage.current.revision !== current.revision ||
            stage.current.rowProgress !== current.rowProgress
          )
            throw new Failure('binding_mismatch');
          const { progress, state } = current;
          if (progress.after === state.pages - 1) return reopen(db, raw, current);
          const { ordinal } = stage.row;
          const next = coordinates(stage.page)
            ? { ...progress, page: ordinal, item: 0 }
            : { ...progress, after: ordinal };
          if (next.after === state.pages - 1 && room()) return reopen(db, raw, { ...current, progress: next });
          await save(db, current, next);
          return null;
        });
        if (result) return result;
      }
      if (!room()) break;
    }
    return {
      ...failure(new Failure('owner_unavailable'), meter),
      advanced: true,
    };
  } catch (error) {
    return failure(error, meter);
  }
}

/** No Source authority, ACK, permission or population completion is minted by this storage boundary. */
export function createPublicFilterCustody(
  pool: Pool,
  sourceBinding?: PublicFilterRepairSourceBinding,
): PublicFilterCustody {
  if (sourceBinding) repairSources.set(pool, sourceBinding);
  const pending = new Set<Promise<unknown>>();
  let closed = false;
  function run<T>(
    context: PublicFilterConsumerContext,
    work: (meter: Meter, context: PublicFilterConsumerContext) => Promise<T>,
    allowClosed = false,
  ): Promise<T | CustodyFailure> {
    context = requestContext(context);
    const meter = operationCost(pool, context);
    const promise = withRequestDeadline(context.deadline, async () => {
      try {
        check(context);
        if (closed && !allowClosed) throw new Failure('owner_unavailable');
        const value = await work(meter, context);
        check(context);
        return value;
      } catch (error) {
        return failure(error, meter);
      }
    });
    pending.add(promise);
    void promise.finally(() => pending.delete(promise)).catch(() => {});
    return promise;
  }
  function bookRows<I>(
    step: BindingStep,
    cohort: string,
    key: string,
    input: I,
    meter: Meter,
    read: (items: readonly I[], shared: Meter, context: PublicFilterConsumerContext) => Promise<QueryResult>,
  ) {
    const { context } = lifetimes.get(meter)!;
    const batch = bookBindingStep(
      step,
      api,
      cohort,
      key,
      context.deadline,
      { key, input },
      async (members, deadline) => {
        const shared = operationCost(pool, { deadline });
        try {
          const result = await read(
            members.map((m) => m.input),
            shared,
            { deadline },
          );
          const rows = new Map(result.rows.map((r) => [r.id, r]));
          return members.map((m, i) => ({ row: rows.get(m.key), cost: bookCostShare(shared, i, members.length) }));
        } catch (error) {
          const failed = failure(error, shared);
          return members.map((_, i) => ({ ...failed, cost: bookCostShare(shared, i, members.length) }));
        }
      },
    );
    return batch?.then((result) => {
      for (const k of Object.keys(meter) as (keyof Meter)[]) meter[k] += result.cost[k];
      if ('reason' in result) throw new Failure(result.reason);
      return result.row;
    });
  }
  async function registered(value: CustodyRegistration, meter: Meter) {
    registration(value);
    const result = await sql(
      pool,
      meter,
      `SELECT r.consumer FROM search.public_filter_registration r JOIN search.public_filter_target t USING (partition_no, physical_target)
      WHERE (r.partition_no,r.id)=($1,$2) AND r.state='active'`,
      [value.partition, value.id],
    );
    if (!result.rows[0]) throw new Failure('definition_missing');
    const consumer = decode<PublicFilterConsumer>(result.rows[0].consumer);
    publicFilterCatalogue(consumer);
    return consumer;
  }
  async function retain(
    value: CustodyRegistration,
    q: PublicFilterQueriedObservation,
    covered: unknown,
    expiresAt: number,
    prepared: unknown,
    meter: Meter,
    db: PoolClient,
    preparedKey?: Readonly<{ build: string; generation: bigint }>,
  ) {
    const inserted = await sql(
      db,
      meter,
      `WITH retained AS (INSERT INTO search.public_filter_observation
        (partition_no,observation,registration,queried,covered,expires_at,state,prepared_rows,prepared_build,prepared_generation)
      SELECT r.partition_no,$3,r.id,$4,$5,$6,'open',$7,$11,$12
      FROM search.public_filter_registration r JOIN search.public_filter_target t USING (partition_no,physical_target)
      WHERE (r.partition_no,r.id)=($1,$2) AND r.state='active' AND t.incarnation=$8 FOR SHARE OF r,t RETURNING partition_no,observation), owned AS (INSERT INTO search.public_filter_pit SELECT partition_no,observation,$9,$10,'owned' FROM retained WHERE $10::text IS NOT NULL) SELECT observation FROM retained`,
      [
        value.partition,
        value.id,
        q.snapshot.observation,
        encode(q),
        encode(covered),
        expiresAt,
        prepared === null ? null : encode(prepared),
        q.consumer.incarnation,
        q.snapshot.kind === 'pit' ? digest(q.snapshot.pit) : null,
        q.snapshot.kind === 'pit' ? q.snapshot.pit : null,
        preparedKey?.build ?? null,
        preparedKey?.generation.toString() ?? null,
      ],
    );
    if (!inserted.rowCount) throw new Failure('binding_mismatch');
    return { status: 'retained' as const, queried: q, cost: meter };
  }
  async function lockCopyAdmission(client: PoolClient, meter: Meter, target: string) {
    await sql(client, meter, lockPublicationAdmission, [target]);
    return sql(client, meter, readPublicationFence, [target]);
  }
  async function admitPreparationWrite(
    client: PoolClient,
    meter: Meter,
    input: Readonly<{ registration: CustodyRegistration; consumer: PublicFilterConsumer }>,
  ) {
    if ((await lockCopyAdmission(client, meter, input.consumer.physicalTarget)).rowCount)
      throw new Failure('binding_mismatch');
    // The database locks the original incarnation consistently with the active enrollment protocol.
    const active = await sql(
      client,
      meter,
      `WITH target AS MATERIALIZED (
         SELECT partition_no,physical_target,incarnation FROM search.lock_retained_copy_target($1,$3)
       )
       SELECT r.consumer,t.incarnation FROM target t
       JOIN search.public_filter_registration r USING(partition_no,physical_target)
       WHERE r.id=$2 AND r.state='active' FOR SHARE OF r`,
      [input.registration.partition, input.registration.id, input.consumer.physicalTarget],
    );
    if (
      !active.rowCount ||
      active.rows[0]!.incarnation !== input.consumer.incarnation ||
      !isDeepStrictEqual(decode<PublicFilterConsumer>(active.rows[0]!.consumer), input.consumer)
    )
      throw new Failure('binding_mismatch');
  }
  function registrationIdentity(input: Parameters<PublicFilterCustody['register']>[0], incarnation: string) {
    const definition = input.definition;
    const consumer: PublicFilterConsumer = {
      physicalTarget: input.physicalTarget,
      incarnation,
      consumerGeneration: input.consumerGeneration,
      projectionGeneration: input.projectionGeneration,
      meaningDigest: definition.meaning.digest,
      readDefinition: definition.readDefinition,
      catalogue: canonicalDiscoveryCatalogue(input.catalogue ?? null),
    };
    const identity = {
      partition: definition.source.partition,
      id: digest({ consumer, source: definition.source.id }),
    };
    return { consumer, identity };
  }
  // An exact registration can already be replayed under a publication fence.
  // Observe it at one current snapshot without rewriting the target shared by every query.
  async function registeredWork(
    meter: Meter,
    partition: number,
    target: string,
    incarnation: string,
    members: readonly { id: string; consumer: string; definition: string }[],
  ) {
    const rows = await sql(
      pool,
      meter,
      `SELECT r.id,r.consumer_work
       FROM unnest($4::text[],$5::text[],$6::text[]) AS i(id,consumer,definition)
       JOIN search.public_filter_registration r ON (r.partition_no,r.id)=($1,i.id)
       JOIN search.public_filter_target t USING(partition_no,physical_target)
       WHERE r.physical_target=$2 AND t.incarnation=$3 AND r.state='active'
         AND r.consumer=i.consumer AND r.definition=i.definition`,
      [
        partition,
        target,
        incarnation,
        members.map((m) => m.id),
        members.map((m) => m.consumer),
        members.map((m) => m.definition),
      ],
    );
    return new Map(rows.rows.map((r) => [r.id as string, r.consumer_work as string | null]));
  }
  const api: PublicFilterCustody = {
    register(request, search, context) {
      // Copy before the first await, so concurrent caller mutation never changes persisted identity.
      const input = decode<typeof request>(encode(request));
      validateDefinition(input.definition);
      text(input.consumerGeneration);
      text(input.projectionGeneration);
      canonicalDiscoveryCatalogue(input.catalogue ?? null);
      return run(context, async (meter, context) => {
        const grouped =
          'bookTypeList' in input.definition.capture &&
          input.definition.capture.bookTypeList &&
          bookBindingStep(
            'registration',
            api,
            JSON.stringify([input.physicalTarget, input.definition.source.partition, input.definition.meaning.digest]),
            input.definition.readDefinition,
            context.deadline,
            input,
            async (inputs, deadline) => {
              const shared = operationCost(pool, { deadline });
              try {
                const incarnation = await native(search, shared, { deadline }, input.physicalTarget);
                const installed = await hasReleaseAuthority(pool, shared, input.definition.meaning.digest);
                const members = inputs.map((item) => {
                  const { consumer, identity } = registrationIdentity(item, incarnation);
                  const encoded = installed
                    ? encodeInstalledDefinition(item.definition)
                    : encodeRetainedDefinition(item.definition, false).encoded;
                  return {
                    consumer,
                    identity,
                    row: { id: identity.id, consumer: encode(consumer), definition: encoded },
                  };
                });
                const home = input.definition.source.partition;
                const current = await registeredWork(
                  shared,
                  home,
                  input.physicalTarget,
                  incarnation,
                  members.map((m) => m.row),
                );
                const accepted =
                  current.size === members.length
                    ? current
                    : await transaction(shared, async (client) => {
                        // Take a fresh statement snapshot after waiting for publication.
                        await sql(client, shared, lockPublicationAdmission, [input.physicalTarget]);
                        const target = await sql(
                          client,
                          shared,
                          `INSERT INTO search.public_filter_target(partition_no,physical_target,incarnation)
                     SELECT $1,$2,$3 WHERE NOT EXISTS (SELECT 1 FROM search.identity_writer_gate
                       WHERE partition_no=0 AND physical_target=$2 AND publication_fence IS NOT NULL)
                     ON CONFLICT (partition_no,physical_target) DO UPDATE SET incarnation=EXCLUDED.incarnation`,
                          [home, input.physicalTarget, incarnation],
                        );
                        const fenced = !target.rowCount;
                        const rows = await sql(
                          client,
                          shared,
                          fenced
                            ? `SELECT r.id,r.consumer_work FROM jsonb_to_recordset($1) i(id text,consumer text,definition text)
                     JOIN search.public_filter_registration r ON (r.partition_no,r.id)=($2,i.id)
                     JOIN search.public_filter_target t USING(partition_no,physical_target)
                     WHERE r.physical_target=$3 AND t.incarnation=$4 AND r.consumer=i.consumer
                       AND r.definition=i.definition AND r.state='active'`
                            : `INSERT INTO search.public_filter_registration(partition_no,id,physical_target,consumer,definition,state)
                     SELECT $2,i.id,$3,i.consumer,i.definition,'active' FROM jsonb_to_recordset($1)
                       i(id text,consumer text,definition text) ORDER BY i.id
                     ON CONFLICT(partition_no,id) DO UPDATE SET id=EXCLUDED.id
                       WHERE public_filter_registration.consumer=EXCLUDED.consumer AND public_filter_registration.definition=EXCLUDED.definition
                         AND public_filter_registration.state='active' RETURNING id,consumer_work`,
                          [
                            JSON.stringify(members.map((m) => m.row)),
                            home,
                            input.physicalTarget,
                            ...(fenced ? [incarnation] : []),
                          ],
                        );
                        return new Map(rows.rows.map((r) => [r.id, r.consumer_work as string | null]));
                      });
                return members.map(({ consumer, identity }, i) => ({
                  consumer,
                  identity,
                  work: accepted.get(identity.id),
                  cost: bookCostShare(shared, i, members.length),
                }));
              } catch (e) {
                const failed = failure(e, shared);
                return inputs.map((_, i) => ({ ...failed, cost: bookCostShare(shared, i, inputs.length) }));
              }
            },
          );
        if (grouped) {
          const result = await grouped;
          for (const k of Object.keys(meter) as (keyof Meter)[]) meter[k] += result.cost[k];
          if ('status' in result) return { ...result, cost: meter };
          if (result.work !== undefined)
            return {
              status: 'registered' as const,
              registration: result.identity,
              consumer: result.consumer,
              consumerWork: result.work,
              cost: meter,
            };
          // The scalar owner handles legacy embedded definitions and reports its exact replay error.
        }
        const incarnation = await native(search, meter, context, input.physicalTarget);
        const { consumer, identity } = registrationIdentity(input, incarnation);
        const retained = await retainedDefinition(pool, meter, input.definition);
        const encodedConsumer = encode(consumer);
        const current = await registeredWork(meter, identity.partition, consumer.physicalTarget, incarnation, [
          { id: identity.id, consumer: encodedConsumer, definition: retained.encoded },
        ]);
        const consumerWork = current.get(identity.id);
        if (consumerWork !== undefined) {
          return {
            status: 'registered' as const,
            registration: identity,
            consumer,
            consumerWork,
            cost: meter,
          };
        }
        await transaction(meter, async (client) => {
          if ((await lockCopyAdmission(client, meter, consumer.physicalTarget)).rowCount) {
            // An exact registration replay needs no new target or copy and cannot change incarnation.
            const replay = (encoded: string) =>
              sql(
                client,
                meter,
                `SELECT 1 FROM search.public_filter_registration r
                 JOIN search.public_filter_target t USING (partition_no,physical_target)
                 WHERE (r.partition_no,r.id,r.physical_target) = ($1,$2,$3)
                   AND t.incarnation=$4 AND r.consumer=$5 AND r.definition=$6 AND r.state='active'`,
                [identity.partition, identity.id, consumer.physicalTarget, incarnation, encodedConsumer, encoded],
              );
            if (
              !(await replay(retained.encoded)).rowCount &&
              (!retained.previous || !(await replay(retained.previous)).rowCount)
            )
              throw new Failure('binding_mismatch');
            return;
          }
          await sql(
            client,
            meter,
            `INSERT INTO search.public_filter_target VALUES ($1,$2,$3) ON CONFLICT (partition_no,physical_target) DO UPDATE SET incarnation=EXCLUDED.incarnation`,
            [identity.partition, consumer.physicalTarget, incarnation],
          );
          const result = await sql(
            client,
            meter,
            `INSERT INTO search.public_filter_registration VALUES ($1,$2,$3,$4,$5,'active')
            ON CONFLICT (partition_no,id) DO UPDATE SET id=EXCLUDED.id WHERE public_filter_registration.consumer=EXCLUDED.consumer AND public_filter_registration.definition=EXCLUDED.definition AND public_filter_registration.state='active' RETURNING id`,
            [identity.partition, identity.id, consumer.physicalTarget, encodedConsumer, retained.encoded],
          );
          if (result.rowCount) return;
          if (!retained.previous) throw new Failure('binding_mismatch');
          // Convert an exact embedded definition under the same registration and writer admission lock.
          const upgraded = await sql(
            client,
            meter,
            `UPDATE search.public_filter_registration SET definition=$6
             WHERE (partition_no,id,physical_target)=($1,$2,$3)
               AND consumer=$4 AND definition=$5 AND state='active' RETURNING id`,
            [
              identity.partition,
              identity.id,
              consumer.physicalTarget,
              encodedConsumer,
              retained.previous,
              retained.encoded,
            ],
          );
          if (!upgraded.rowCount) throw new Failure('binding_mismatch');
        });
        return { status: 'registered' as const, registration: identity, consumer, cost: meter };
      });
    },
    openPit(request, search, context) {
      const input = decode<typeof request>(encode(request));
      lifetime(input.keepAliveMs);
      text(input.covered.observation);
      return run(context, async (meter, context) => {
        const owners = bookRows(
          'pitOwner',
          String(input.registration.partition),
          input.registration.id,
          input.registration.id,
          meter,
          (ids, shared) =>
            sql(
              pool,
              shared,
              `SELECT r.id,r.consumer FROM search.public_filter_registration r JOIN search.public_filter_target t USING(partition_no,physical_target)
             WHERE r.partition_no=$1 AND r.id=ANY($2::text[]) AND r.state='active'`,
              [input.registration.partition, ids],
            ),
        );
        const owner = await owners;
        if (owners && !owner) throw new Failure('definition_missing');
        const consumer = owner
          ? decode<PublicFilterConsumer>(owner.consumer)
          : await registered(input.registration, meter);
        publicFilterCatalogue(consumer);
        const checkTarget = async (step: 'beforePit' | 'afterPit') => {
          const batch = bookBindingStep(
            step,
            search,
            consumer.physicalTarget,
            input.registration.id,
            context.deadline,
            null,
            async (members, deadline) => {
              const shared = operationCost(pool, { deadline });
              try {
                const incarnation = await native(search, shared, { deadline }, consumer.physicalTarget);
                return members.map((_, i) => ({ incarnation, cost: bookCostShare(shared, i, members.length) }));
              } catch (error) {
                const failed = failure(error, shared);
                return members.map((_, i) => ({ ...failed, cost: bookCostShare(shared, i, members.length) }));
              }
            },
          );
          if (!batch) return native(search, meter, context, consumer.physicalTarget);
          const result = await batch;
          for (const k of Object.keys(meter) as (keyof Meter)[]) meter[k] += result.cost[k];
          if ('reason' in result) throw new Failure(result.reason);
          return result.incarnation;
        };
        if ((await checkTarget('beforePit')) !== consumer.incarnation) throw new Failure('binding_mismatch');
        const openedAt = Date.now();
        const opened = await engine<{ pit_id: string; _shards: { failed: number } }>(
          search,
          meter,
          context,
          'POST',
          `/${consumer.physicalTarget}/_search/point_in_time?keep_alive=${input.keepAliveMs}ms`,
        );
        text(opened.pit_id);
        try {
          if (opened._shards.failed) throw new Failure('observation_lost');
          if ((await checkTarget('afterPit')) !== consumer.incarnation) throw new Failure('binding_mismatch');
          const q: PublicFilterQueriedObservation = {
            consumer,
            snapshot: {
              kind: 'pit',
              observation: `${input.registration.partition}:${randomUUID()}`,
              pit: opened.pit_id,
            },
          };
          const batch = bookRows(
            'retain',
            JSON.stringify([input.registration.partition, consumer.physicalTarget, consumer.incarnation]),
            input.registration.id,
            {
              id: input.registration.id,
              observation: q.snapshot.observation,
              queried: encode(q),
              consumer: encode(consumer),
              covered: encode(input.covered),
              expires: openedAt + input.keepAliveMs,
              pit: opened.pit_id,
              hash: digest(opened.pit_id),
            },
            meter,
            (items, shared) =>
              transaction(shared, async (client) => {
                await sql(client, shared, lockPublicationAdmission, [consumer.physicalTarget]);
                return sql(
                  client,
                  shared,
                  `WITH target AS MATERIALIZED (
                SELECT partition_no,physical_target FROM search.lock_retained_copy_target($2,$3)
                WHERE incarnation=$4 AND NOT EXISTS (SELECT 1 FROM search.identity_writer_gate
                    WHERE partition_no=0 AND physical_target=$3 AND publication_fence IS NOT NULL)), admitted AS MATERIALIZED (
                SELECT r.partition_no,i.* FROM target t JOIN search.public_filter_registration r USING(partition_no,physical_target)
                JOIN jsonb_to_recordset($1) i(id text, observation text, queried text, consumer text, covered text, expires bigint, pit text, hash text)
                  ON i.id=r.id AND i.consumer=r.consumer WHERE r.state='active' ORDER BY r.id FOR SHARE OF r), retained AS (
                INSERT INTO search.public_filter_observation(partition_no,observation,registration,queried,covered,expires_at,state)
                SELECT partition_no,observation,id,queried,covered,expires,'open' FROM admitted RETURNING partition_no,observation,registration),
                owned AS (INSERT INTO search.public_filter_pit SELECT r.partition_no,r.observation,i.hash,i.pit,'owned'
                  FROM retained r JOIN admitted i USING(observation)) SELECT registration AS id FROM retained`,
                  [JSON.stringify(items), input.registration.partition, consumer.physicalTarget, consumer.incarnation],
                );
              }),
          );
          if (batch) {
            if (!(await batch)) throw new Failure('binding_mismatch');
            return { status: 'retained' as const, queried: q, cost: meter };
          }
          return await transaction(meter, async (client) => {
            await admitPreparationWrite(client, meter, { registration: input.registration, consumer });
            return retain(
              input.registration,
              {
                consumer,
                snapshot: {
                  kind: 'pit',
                  observation: `${input.registration.partition}:${randomUUID()}`,
                  pit: opened.pit_id,
                },
              },
              input.covered,
              openedAt + input.keepAliveMs,
              null,
              meter,
              client,
            );
          });
        } catch (error) {
          await deletePit(opened.pit_id, search, context, meter);
          throw error;
        }
      });
    },
    retainPrepared(request, context) {
      const input = decode<typeof request>(encode(request));
      rows(input.rows);
      text(input.build);
      text(input.covered.observation);
      requireValue(typeof input.generation === 'bigint' && input.generation > 0n && input.expiresAt > Date.now());
      return run(context, async (meter) => {
        const consumer = await registered(input.registration, meter);
        return transaction(meter, async (client) => {
          await admitPreparationWrite(client, meter, { registration: input.registration, consumer });
          const saved = await sql(
            client,
            meter,
            `INSERT INTO search.public_filter_prepared(partition_no,registration,build,generation,rows) VALUES ($1,$2,$3,$4,$5)
            ON CONFLICT (partition_no,registration,build,generation) DO UPDATE SET build=EXCLUDED.build WHERE public_filter_prepared.state='active' AND public_filter_prepared.rows=EXCLUDED.rows RETURNING build`,
            [
              input.registration.partition,
              input.registration.id,
              input.build,
              input.generation.toString(),
              encode(input.rows),
            ],
          );
          if (!saved.rowCount) throw new Failure('binding_mismatch');
          return retain(
            input.registration,
            {
              consumer,
              snapshot: {
                kind: 'prepared',
                observation: `${input.registration.partition}:${randomUUID()}`,
                build: input.build,
                generation: input.generation,
              },
            },
            input.covered,
            input.expiresAt,
            input.rows,
            meter,
            client,
          );
        });
      });
    },
    readPreparationFrontier(request, context) {
      const input = decode<typeof request>(encode(request));
      registration(input.registration);
      text(input.build);
      requireValue(typeof input.generation === 'bigint' && input.generation > 0n);
      return run(context, async (meter) => {
        await registered(input.registration, meter);
        const result = await sql(
          pool,
          meter,
          `SELECT segment_state,raw_count,output_count,source_cursor,raw_exhausted
           FROM search.public_filter_prepared
           WHERE (partition_no,registration,build,generation)=($1,$2,$3,$4::numeric)`,
          [input.registration.partition, input.registration.id, input.build, input.generation.toString()],
        );
        return {
          status: 'found' as const,
          frontier: preparationFrontier(result.rows[0]),
          cost: meter,
        };
      });
    },
    appendPreparationSegment(request, context) {
      const input = decode<typeof request>(encode(request));
      registration(input.registration);
      text(input.consumer.physicalTarget);
      text(input.consumer.incarnation);
      text(input.build);
      requireValue(typeof input.generation === 'bigint' && input.generation > 0n);
      requireValue(input.entries.length <= 100);
      requireValue(Number.isInteger(input.expected.rawCount) && Number.isInteger(input.expected.outputCount));
      for (const [index, entry] of input.entries.entries()) {
        requireValue(entry.rawOrdinal === input.expected.rawCount + index);
        if (entry.outputOrdinal !== null) requireValue(Number.isInteger(entry.outputOrdinal));
      }
      return run(context, async (meter) => {
        const known = await registered(input.registration, meter);
        if (!isDeepStrictEqual(known, input.consumer)) throw new Failure('binding_mismatch');
        const result = await transaction(meter, async (client) => {
          await admitPreparationWrite(client, meter, input);
          const key = preparationKey(input.registration, input.build, input.generation);
          await sql(
            client,
            meter,
            `INSERT INTO search.public_filter_prepared
              (partition_no,registration,build,generation,rows,state,segment_state,raw_count,output_count,raw_exhausted,source_cursor)
             VALUES ($1,$2,$3,$4,$5,'active','building',0,0,false,NULL)
             ON CONFLICT (partition_no,registration,build,generation) DO NOTHING`,
            [input.registration.partition, input.registration.id, input.build, input.generation.toString(), encode([])],
          );
          const saved = await sql(
            client,
            meter,
            `SELECT state,segment_state,raw_count,output_count,source_cursor,raw_exhausted
             FROM search.public_filter_prepared
             WHERE (partition_no,registration,build,generation)=($1,$2,$3,$4::numeric) FOR UPDATE`,
            [input.registration.partition, input.registration.id, input.build, input.generation.toString()],
          );
          const row = saved.rows[0];
          if (!row || row.state !== 'active' || row.segment_state === 'erasing' || row.segment_state === 'legacy')
            throw new Failure('binding_mismatch');
          const current = preparationFrontier(row);
          const nextRaw = input.expected.rawCount + input.entries.length;
          const nextOutput =
            input.expected.outputCount + input.entries.filter((entry) => entry.outputOrdinal !== null).length;
          const nextCursor = preparationCursor(input.after);
          const sameNext =
            current.rawCount === nextRaw &&
            current.outputCount === nextOutput &&
            current.rawExhausted === input.rawExhausted &&
            (row.source_cursor ?? null) === nextCursor;
          const replay =
            sameNext &&
            input.expected.rawCount <= current.rawCount &&
            (input.entries.length > 0 || current.rawExhausted);
          if (replay) {
            const prior = await readSegmentReplay(
              (statement, values) => sql(client, meter, statement, values),
              key,
              input.expected.rawCount,
              nextRaw,
            );
            if (
              prior.rows.length === input.entries.length &&
              prior.rows.every((savedEntry, index) => {
                const requested = input.entries[index]!;
                return (
                  savedEntry.raw_ordinal === requested.rawOrdinal &&
                  savedEntry.output_ordinal === requested.outputOrdinal &&
                  isDeepStrictEqual(savedEntry.payload, requested.payload)
                );
              })
            )
              return 'replayed' as const;
            throw new Failure('binding_mismatch');
          }
          if (
            current.state !== 'building' ||
            current.rawExhausted ||
            current.rawCount !== input.expected.rawCount ||
            current.outputCount !== input.expected.outputCount ||
            !isDeepStrictEqual(current.after, input.expected.after) ||
            nextRaw > 1000
          )
            throw new Failure('observation_lost');
          let nextOutputOrdinal = input.expected.outputCount;
          for (const entry of input.entries) {
            if (entry.outputOrdinal !== null) {
              if (entry.outputOrdinal !== nextOutputOrdinal) throw new Failure('binding_mismatch');
              nextOutputOrdinal++;
            }
          }
          const inserted = await insertSegmentRows(
            (statement, values) => sql(client, meter, statement, values),
            key,
            input.entries,
          );
          if (inserted !== input.entries.length) throw new Failure('binding_mismatch');
          const advanced = await sql(
            client,
            meter,
            `UPDATE search.public_filter_prepared SET raw_count=$5,output_count=$6,source_cursor=$7,raw_exhausted=$8
             WHERE (partition_no,registration,build,generation)=($1,$2,$3,$4::numeric)
               AND state='active' AND segment_state='building' AND raw_count=$9 AND output_count=$10
               AND raw_exhausted=false RETURNING raw_count`,
            [
              input.registration.partition,
              input.registration.id,
              input.build,
              input.generation.toString(),
              nextRaw,
              nextOutput,
              nextCursor,
              input.rawExhausted,
              input.expected.rawCount,
              input.expected.outputCount,
            ],
          );
          if (advanced.rowCount !== 1) throw new Failure('observation_lost');
          meter.frontierWrites++;
          return 'appended' as const;
        });
        return { status: result, cost: meter };
      });
    },
    retainPreparedSegments(request, context) {
      const input = decode<typeof request>(encode(request));
      registration(input.registration);
      text(input.build);
      text(input.covered.observation);
      requireValue(typeof input.generation === 'bigint' && input.generation > 0n);
      requireValue(Number.isInteger(input.rawCount) && input.rawCount >= 0 && input.rawCount <= 1000);
      requireValue(
        Number.isInteger(input.outputCount) && input.outputCount >= 0 && input.outputCount <= input.rawCount,
      );
      requireValue(Number.isSafeInteger(input.expiresAt) && input.expiresAt > Date.now());
      return run(context, async (meter) => {
        const consumer = await registered(input.registration, meter);
        return transaction(meter, async (client) => {
          await admitPreparationWrite(client, meter, { registration: input.registration, consumer });
          const prepared = await sql(
            client,
            meter,
            `SELECT state,segment_state,raw_count,output_count,source_cursor,raw_exhausted
             FROM search.public_filter_prepared
             WHERE (partition_no,registration,build,generation)=($1,$2,$3,$4::numeric) FOR UPDATE`,
            [input.registration.partition, input.registration.id, input.build, input.generation.toString()],
          );
          const frontier = preparationFrontier(prepared.rows[0]);
          if (
            prepared.rows[0]?.state !== 'active' ||
            (frontier.state !== 'building' && frontier.state !== 'complete') ||
            !frontier.rawExhausted ||
            frontier.rawCount !== input.rawCount ||
            frontier.outputCount !== input.outputCount
          )
            throw new Failure('observation_lost');
          const prior = await sql(
            client,
            meter,
            `SELECT queried FROM search.public_filter_observation
             WHERE (partition_no,registration,prepared_build,prepared_generation)=($1,$2,$3,$4::numeric)
               AND state='open' ORDER BY observation DESC LIMIT 1`,
            [input.registration.partition, input.registration.id, input.build, input.generation.toString()],
          );
          if (prior.rowCount) {
            const queriedValue = decode<PublicFilterQueriedObservation>(prior.rows[0]!.queried);
            queried(queriedValue);
            if (
              queriedValue.consumer.incarnation !== consumer.incarnation ||
              queriedValue.snapshot.kind !== 'prepared' ||
              queriedValue.snapshot.build !== input.build ||
              queriedValue.snapshot.generation !== input.generation
            )
              throw new Failure('binding_mismatch');
            return { status: 'retained' as const, queried: queriedValue, cost: meter };
          }
          const marker = {
            storage: 'segments-v1',
            build: input.build,
            generation: input.generation,
            rawCount: input.rawCount,
            outputCount: input.outputCount,
          };
          return retain(
            input.registration,
            {
              consumer,
              snapshot: {
                kind: 'prepared',
                observation: `${input.registration.partition}:${randomUUID()}`,
                build: input.build,
                generation: input.generation,
              },
            },
            input.covered,
            input.expiresAt,
            marker,
            meter,
            client,
            { build: input.build, generation: input.generation },
          );
        });
      });
    },
    completePreparationBuild(request, context) {
      const input = decode<typeof request>(encode(request));
      queried(input.queried);
      requireValue(input.queried.snapshot.kind === 'prepared');
      requireValue(Number.isInteger(input.rawCount) && input.rawCount >= 0 && input.rawCount <= 1000);
      requireValue(
        Number.isInteger(input.outputCount) && input.outputCount >= 0 && input.outputCount <= input.rawCount,
      );
      return run(context, async (meter) => {
        const q = input.queried;
        if (q.snapshot.kind !== 'prepared') throw new Failure('binding_mismatch');
        return transaction(meter, async (client) => {
          const snapshot = q.snapshot;
          if (snapshot.kind !== 'prepared') throw new Failure('binding_mismatch');
          const found = await sql(
            client,
            meter,
            `SELECT o.state,o.queried,o.registration,p.state AS prepared_state,p.segment_state,p.raw_count,p.output_count,
                    p.raw_exhausted
             FROM search.public_filter_observation o
             JOIN search.public_filter_prepared p
               ON (p.partition_no,p.registration,p.build,p.generation)=
                  (o.partition_no,o.registration,o.prepared_build,o.prepared_generation)
             WHERE (o.partition_no,o.observation)=($1,$2) AND o.queried=$3
               AND o.prepared_build=$4 AND o.prepared_generation=$5::numeric
             FOR UPDATE OF o,p`,
            [
              partition(snapshot.observation),
              snapshot.observation,
              encode(q),
              snapshot.build,
              snapshot.generation.toString(),
            ],
          );
          const row = found.rows[0];
          if (!row || row.state !== 'open' || row.prepared_state !== 'active') throw new Failure('observation_lost');
          if (row.segment_state === 'complete') {
            if (row.raw_count !== input.rawCount || row.output_count !== input.outputCount)
              throw new Failure('binding_mismatch');
            return { status: 'complete' as const, cost: meter };
          }
          if (
            row.segment_state !== 'building' ||
            !row.raw_exhausted ||
            row.raw_count !== input.rawCount ||
            row.output_count !== input.outputCount
          )
            throw new Failure('observation_lost');
          const exact = await sql(
            client,
            meter,
            `SELECT count(*)::integer AS raw_count,min(raw_ordinal) AS first_raw,max(raw_ordinal) AS last_raw,
                    count(output_ordinal)::integer AS output_count,min(output_ordinal) AS first_output,
                    max(output_ordinal) AS last_output
             FROM search.public_filter_preparation_segment
             WHERE (partition_no,registration,build,generation)=($1,$2,$3,$4::numeric)`,
            [partition(snapshot.observation), row.registration, snapshot.build, snapshot.generation.toString()],
          );
          const counts = exact.rows[0]!;
          const rawCount = Number(counts.raw_count);
          const outputCount = Number(counts.output_count);
          const rawComplete =
            rawCount === input.rawCount &&
            (rawCount === 0 || (counts.first_raw === 0 && counts.last_raw === rawCount - 1));
          const outputComplete =
            outputCount === input.outputCount &&
            (outputCount === 0 || (counts.first_output === 0 && counts.last_output === outputCount - 1));
          if (!rawComplete || !outputComplete) throw new Failure('observation_lost');
          const completed = await sql(
            client,
            meter,
            `UPDATE search.public_filter_prepared SET segment_state='complete'
             WHERE (partition_no,registration,build,generation)=($1,$2,$3,$4::numeric)
               AND state='active' AND segment_state='building' AND raw_exhausted=true
               AND raw_count=$5 AND output_count=$6 RETURNING build`,
            [
              partition(snapshot.observation),
              row.registration,
              snapshot.build,
              snapshot.generation.toString(),
              input.rawCount,
              input.outputCount,
            ],
          );
          if (completed.rowCount !== 1) throw new Failure('observation_lost');
          meter.frontierWrites++;
          return { status: 'complete' as const, cost: meter };
        });
      });
    },
    readPreparedWindow(request, context) {
      const input = decode<typeof request>(encode(request));
      queried(input.queried);
      requireValue(input.queried.snapshot.kind === 'prepared');
      text(input.use.token);
      requireValue(input.use.observation === input.queried.snapshot.observation);
      requireValue(Number.isInteger(input.afterOutputOrdinal) && input.afterOutputOrdinal >= 0);
      requireValue(Number.isInteger(input.size) && input.size >= 1 && input.size <= 200);
      return run(context, async (meter) =>
        transaction(meter, async (client) => {
          const q = input.queried;
          if (q.snapshot.kind !== 'prepared') throw new Failure('binding_mismatch');
          const observation = await sql(
            client,
            meter,
            `SELECT o.registration FROM search.public_filter_observation o
           JOIN search.public_filter_reference f ON (f.partition_no,f.observation)=(o.partition_no,o.observation)
           WHERE (o.partition_no,o.observation)=($1,$2) AND o.queried=$3 AND o.prepared_build=$4
             AND o.prepared_generation=$5::numeric AND o.state='open' AND o.expires_at>$7
             AND f.token=$6 AND f.expires_at>$7 FOR SHARE OF o,f`,
            [
              partition(q.snapshot.observation),
              q.snapshot.observation,
              encode(q),
              q.snapshot.build,
              q.snapshot.generation.toString(),
              input.use.token,
              Date.now(),
            ],
          );
          if (!observation.rowCount) return { status: 'missing' as const, cost: meter };
          const result = await readSegmentWindow(
            (statement, values) => sql(client, meter, statement, values),
            preparationKey(
              { partition: partition(q.snapshot.observation), id: observation.rows[0]!.registration },
              q.snapshot.build,
              q.snapshot.generation,
            ),
            input.afterOutputOrdinal,
            input.size,
          );
          const row = result.rows[0];
          if (!row) return { status: 'missing' as const, cost: meter };
          if (row.segment_state !== 'complete' || !row.raw_exhausted)
            return { status: 'preparing' as const, cost: meter };
          const hits = result.rows.flatMap((entry) => (entry.payload === null ? [] : [entry.payload.hit]));
          return {
            status: 'ready' as const,
            hits,
            rawCount: row.raw_count,
            outputCount: row.output_count,
            cost: meter,
          };
        }),
      );
    },
    acquire(q, context) {
      const input = decode<typeof q>(encode(q));
      queried(input);
      return run(context, async (meter, context) => {
        const token = randomUUID();
        const home = partition(input.snapshot.observation);
        const bootstrap = repairBootstrap(input);
        const batch =
          input.snapshot.kind === 'pit' &&
          bootstrap === null &&
          bookRows(
            'reference',
            JSON.stringify([home, input.consumer.physicalTarget, input.consumer.incarnation]),
            input.snapshot.observation,
            { observation: input.snapshot.observation, queried: encode(input), token, deadline: context.deadline },
            meter,
            (items, shared) =>
              transaction(shared, async (client) => {
                await sql(client, shared, lockPublicationAdmission, [input.consumer.physicalTarget]);
                return sql(
                  client,
                  shared,
                  `WITH locked AS MATERIALIZED (
              SELECT o.partition_no,i.observation,i.token,i.deadline FROM jsonb_to_recordset($1)
                i(observation text,queried text,token uuid,deadline bigint)
              JOIN search.public_filter_observation o ON (o.partition_no,o.observation)=($2,i.observation)
              JOIN search.public_filter_registration r ON (r.partition_no,r.id)=(o.partition_no,o.registration)
              JOIN search.public_filter_target t ON (t.partition_no,t.physical_target)=(r.partition_no,r.physical_target)
              WHERE o.queried=i.queried AND o.state='open' AND o.expires_at>$3 AND r.state='active'
                AND r.physical_target=$4 AND t.incarnation=$5 AND NOT EXISTS (SELECT 1 FROM search.identity_writer_gate
                  WHERE partition_no=0 AND physical_target=$4 AND publication_fence IS NOT NULL)
              ORDER BY o.observation FOR UPDATE OF o FOR SHARE OF r,t)
              INSERT INTO search.public_filter_reference SELECT partition_no,observation,token,least(deadline,$3::bigint+300000) FROM locked
              RETURNING observation AS id`,
                  [JSON.stringify(items), home, Date.now(), input.consumer.physicalTarget, input.consumer.incarnation],
                );
              }),
          );
        if (batch) {
          if (!(await batch)) throw new Failure('observation_lost');
          return { status: 'acquired' as const, use: { observation: input.snapshot.observation, token }, cost: meter };
        }
        return transaction(meter, async (client) => {
          // Serialize reader enrollment with the ordinary publication admission fence.
          await sql(client, meter, lockPublicationAdmission, [input.consumer.physicalTarget]);
          const token = randomUUID();
          const result = await sql(
            client,
            meter,
            `WITH locked AS (
          SELECT o.partition_no,o.observation FROM search.public_filter_observation o
          JOIN search.public_filter_registration r ON (r.partition_no,r.id)=(o.partition_no,o.registration)
          JOIN search.public_filter_target t ON (t.partition_no,t.physical_target)=(r.partition_no,r.physical_target)
          WHERE (o.partition_no,o.observation)=($1,$2) AND o.queried=$3 AND o.state='open'
            AND (o.expires_at>$4 OR (o.consumer_bootstrap=$10::text AND o.consumer_work IS NOT NULL))
            AND r.state='active' AND t.incarnation=$7
            AND NOT EXISTS (SELECT 1 FROM search.identity_writer_gate g
              WHERE g.partition_no=0 AND g.physical_target=r.physical_target AND g.publication_fence IS NOT NULL)
            AND NOT EXISTS (SELECT 1 FROM search.public_filter_prepared p
              WHERE (p.partition_no,p.registration,p.build,p.generation)=(r.partition_no,r.id,$8::text,$9::bigint)
                AND (p.state='erasing' OR (p.segment_state='building' AND p.raw_exhausted=false)))
          FOR UPDATE OF o FOR SHARE OF r,t)
          INSERT INTO search.public_filter_reference SELECT partition_no,observation,$5,$6 FROM locked RETURNING token`,
            [
              partition(input.snapshot.observation),
              input.snapshot.observation,
              encode(input),
              Date.now(),
              token,
              Math.min(context.deadline, Date.now() + 300_000),
              input.consumer.incarnation,
              input.snapshot.kind === 'prepared' ? input.snapshot.build : null,
              input.snapshot.kind === 'prepared' ? input.snapshot.generation.toString() : null,
              bootstrap,
            ],
          );
          if (!result.rowCount) throw new Failure('observation_lost');
          return { status: 'acquired' as const, use: { observation: input.snapshot.observation, token }, cost: meter };
        });
      });
    },
    appendExecution(request, context) {
      const input = decode<typeof request>(encode(request));
      text(input.execution.id);
      text(input.execution.start.observation);
      rows(input.execution.ownRows);
      return run(context, async (meter) => {
        const result = await sql(
          pool,
          meter,
          `WITH locked AS (
          SELECT o.partition_no,o.observation FROM search.public_filter_observation o JOIN search.public_filter_reference f USING (partition_no,observation)
          WHERE (o.partition_no,o.observation)=($1,$2) AND f.token=$3 AND f.expires_at>$4 AND o.state<>'closed' FOR UPDATE OF o)
          INSERT INTO search.public_filter_execution SELECT partition_no,observation,$5,$6 FROM locked
          ON CONFLICT (partition_no,observation,id) DO UPDATE SET id=EXCLUDED.id WHERE public_filter_execution.execution=EXCLUDED.execution RETURNING id`,
          [
            partition(input.use.observation),
            input.use.observation,
            input.use.token,
            Date.now(),
            input.execution.id,
            encode(input.execution),
          ],
        );
        if (!result.rowCount) throw new Failure('execution_missing');
        return { status: 'appended' as const, cost: meter };
      });
    },
    release(use, context) {
      return run(
        context,
        async (meter) => {
          const home = partition(use.observation);
          const batch = bookRows('release', String(home), use.observation, use, meter, async (items, shared) => {
            const members = JSON.stringify(items);
            const deleted = await sql(
              pool,
              shared,
              `DELETE FROM search.public_filter_reference f USING jsonb_to_recordset($1) i(observation text, token uuid)
              WHERE (f.partition_no,f.observation,f.token)=($2,i.observation,i.token)`,
              [members, home],
            );
            // Only a local closer can use the signal. A new closer reads durable leases itself.
            if (!items.some((item) => drainWaiters.has(item.observation))) return deleted;
            return sql(
              pool,
              shared,
              `SELECT i.observation AS id FROM jsonb_to_recordset($1) i(observation text)
              WHERE NOT EXISTS (SELECT 1 FROM search.public_filter_reference f
                WHERE (f.partition_no,f.observation)=($2,i.observation) AND f.expires_at>$3)`,
              [members, home, Date.now()],
            );
          });
          if (batch) {
            if (await batch) for (const wake of drainWaiters.get(use.observation) ?? []) wake();
            return { status: 'released' as const, cost: meter };
          }
          await sql(
            pool,
            meter,
            'DELETE FROM search.public_filter_reference WHERE (partition_no,observation,token)=($1,$2,$3)',
            [partition(use.observation), use.observation, use.token],
          );
          if (!drainWaiters.has(use.observation)) return { status: 'released' as const, cost: meter };
          const active = await sql(
            pool,
            meter,
            'SELECT expires_at FROM search.public_filter_reference WHERE (partition_no,observation)=($1,$2) AND expires_at>$3 ORDER BY expires_at DESC LIMIT 1',
            [partition(use.observation), use.observation, Date.now()],
          );
          if (!active.rowCount) for (const wake of drainWaiters.get(use.observation) ?? []) wake();
          return { status: 'released' as const, cost: meter };
        },
        true,
      );
    },
    retainPit(request, context) {
      const input = decode<typeof request>(encode(request));
      text(input.pit);
      queried(input.queried);
      return run(context, async (meter) => {
        const q = input.queried;
        if (q.snapshot.kind !== 'pit' || input.use.observation !== q.snapshot.observation)
          throw new Failure('binding_mismatch');
        const successor = { ...q, snapshot: { ...q.snapshot, pit: input.pit } };
        const home = partition(q.snapshot.observation);
        const batch = bookRows(
          'successor',
          String(home),
          q.snapshot.observation,
          {
            observation: q.snapshot.observation,
            queried: encode(q),
            token: input.use.token,
            hash: digest(input.pit),
            pit: input.pit,
            successor: encode(successor),
          },
          meter,
          (items, shared) =>
            sql(
              pool,
              shared,
              `WITH locked AS MATERIALIZED (
            SELECT o.partition_no,i.* FROM jsonb_to_recordset($1) i(observation text,queried text,token uuid,hash text,pit text,successor text)
            JOIN search.public_filter_observation o ON (o.partition_no,o.observation)=($2,i.observation)
            JOIN search.public_filter_reference f ON (f.partition_no,f.observation,f.token)=(o.partition_no,i.observation,i.token)
            WHERE o.queried=i.queried AND o.state<>'closed' AND f.expires_at>$3 ORDER BY o.observation FOR UPDATE OF o),
            owned AS (INSERT INTO search.public_filter_pit SELECT partition_no,observation,hash,pit,'owned' FROM locked ON CONFLICT DO NOTHING)
            UPDATE search.public_filter_observation o SET queried=i.successor,revision=revision+1 FROM locked i
            WHERE (o.partition_no,o.observation)=(i.partition_no,i.observation) RETURNING o.observation AS id`,
              [JSON.stringify(items), home, Date.now()],
            ),
        );
        if (batch) {
          if (!(await batch)) throw new Failure('observation_lost');
          return { status: 'retained' as const, queried: successor, cost: meter };
        }
        const result = await sql(
          pool,
          meter,
          `WITH locked AS (
          SELECT o.partition_no,o.observation FROM search.public_filter_observation o
          JOIN search.public_filter_reference f USING(partition_no,observation)
          WHERE (o.partition_no,o.observation)=($1,$2) AND o.queried=$3 AND o.state<>'closed'
          AND f.token=$4 AND f.expires_at>$5 FOR UPDATE OF o
        ), owned AS (
          INSERT INTO search.public_filter_pit SELECT partition_no,observation,$6,$7,'owned' FROM locked
          ON CONFLICT DO NOTHING
        ) UPDATE search.public_filter_observation o SET queried=$8,revision=revision+1
          FROM locked l WHERE (o.partition_no,o.observation)=(l.partition_no,l.observation) RETURNING o.observation`,
          [
            partition(q.snapshot.observation),
            q.snapshot.observation,
            encode(q),
            input.use.token,
            Date.now(),
            digest(input.pit),
            input.pit,
            encode(successor),
          ],
        );
        if (!result.rowCount) throw new Failure('observation_lost');
        return { status: 'retained' as const, queried: successor, cost: meter };
      });
    },
    renewPit(q, keepAliveMs, search, context) {
      const input = decode<typeof q>(encode(q));
      queried(input);
      lifetime(keepAliveMs);
      return run(context, async (meter, context) => {
        if (input.snapshot.kind !== 'pit') throw new Failure('binding_mismatch');
        const acquired = await api.acquire(input, context);
        addCost(meter, acquired.cost);
        if (acquired.status !== 'acquired') throw new Failure(acquired.reason);
        try {
          const old = await sql(
            pool,
            meter,
            'SELECT revision FROM search.public_filter_observation WHERE (partition_no,observation)=($1,$2)',
            [partition(input.snapshot.observation), input.snapshot.observation],
          );
          if ((await native(search, meter, context, input.consumer.physicalTarget)) !== input.consumer.incarnation)
            throw new Failure('binding_mismatch');
          const renewedAt = Date.now();
          const response = await engine<{ pit_id?: string; _shards: { failed: number }; timed_out: boolean }>(
            search,
            meter,
            context,
            'POST',
            '/_search',
            {
              size: 0,
              track_total_hits: false,
              query: { match_none: {} },
              pit: { id: input.snapshot.pit, keep_alive: `${keepAliveMs}ms` },
            },
          ).catch(async (error: unknown) => {
            if (error instanceof OpenSearchError && error.status === 404)
              await sql(
                pool,
                meter,
                "UPDATE search.public_filter_observation SET state='closing' WHERE (partition_no,observation)=($1,$2) AND queried=$3 AND revision=$4 AND state='open'",
                [
                  partition(input.snapshot.observation),
                  input.snapshot.observation,
                  encode(input),
                  old.rows[0].revision,
                ],
              );
            throw error;
          });
          const successor: PublicFilterQueriedObservation = {
            consumer: input.consumer,
            snapshot: { ...input.snapshot, pit: response.pit_id ?? input.snapshot.pit },
          };
          await sql(
            pool,
            meter,
            `INSERT INTO search.public_filter_pit VALUES ($1,$2,$3,$4,'owned') ON CONFLICT DO NOTHING`,
            [
              partition(input.snapshot.observation),
              input.snapshot.observation,
              digest(successor.snapshot.kind === 'pit' ? successor.snapshot.pit : ''),
              successor.snapshot.kind === 'pit' ? successor.snapshot.pit : '',
            ],
          );
          if (response.timed_out || response._shards.failed) throw new Failure('observation_lost');
          const updated = await sql(
            pool,
            meter,
            `UPDATE search.public_filter_observation o SET queried=$4,expires_at=$5,revision=o.revision+1 FROM search.public_filter_registration r JOIN search.public_filter_target t USING (partition_no,physical_target)
            WHERE (o.partition_no,o.observation)=($1,$2) AND o.queried=$3 AND o.revision=$6 AND o.state='open' AND o.expires_at>$7
            AND (r.partition_no,r.id)=(o.partition_no,o.registration) AND r.state='active' AND t.incarnation=$8 RETURNING o.observation`,
            [
              partition(input.snapshot.observation),
              input.snapshot.observation,
              encode(input),
              encode(successor),
              renewedAt + keepAliveMs,
              old.rows[0].revision,
              Date.now(),
              input.consumer.incarnation,
            ],
          );
          if (!updated.rowCount) throw new Failure('observation_lost');
          return { status: 'retained' as const, queried: successor, cost: meter };
        } finally {
          const released = await api.release(acquired.use, context);
          addCost(meter, released.cost);
          if (released.status !== 'released') throw new Failure(released.reason);
        }
      });
    },
    closeObservation(q, search, context) {
      const input = decode<typeof q>(encode(q));
      queried(input);
      return run(context, async (meter, context) => {
        const values = [partition(input.snapshot.observation), input.snapshot.observation];
        const barrier = await sql(
          pool,
          meter,
          `UPDATE search.public_filter_observation SET state=CASE WHEN state='closed' THEN 'closed' ELSE 'closing' END WHERE (partition_no,observation)=($1,$2) AND queried=$3 RETURNING state`,
          [...values, encode(input)],
        );
        if (!barrier.rowCount) throw new Failure('observation_lost');
        if (barrier.rows[0].state === 'closed') return { status: 'closed' as const, cost: meter };
        const signal = drainSignal(input.snapshot.observation);
        try {
          // At most three indexed maximum probes, including stale delivery and cross-process fallback.
          // Timer fallbacks revalidate halfway and near the deadline, reserving up to 100ms for native close.
          // Release signals can advance a wait; every advance re-reads durable state before deletion.
          for (let attempt = 0; attempt < 3; attempt++) {
            check(context);
            const refs = await sql(
              pool,
              meter,
              'SELECT expires_at FROM search.public_filter_reference WHERE (partition_no,observation)=($1,$2) AND expires_at>$3 ORDER BY expires_at DESC LIMIT 1',
              [...values, Date.now()],
            );
            if (!refs.rowCount) break;
            if (attempt === 2) throw new Failure('deadline');
            const now = Date.now();
            const remaining = context.deadline - now;
            const next = attempt === 0 ? now + remaining / 2 : context.deadline - Math.min(100, remaining / 4);
            await signal.wait(Math.min(Number(refs.rows[0].expires_at) + 1, next));
          }
        } finally {
          signal.dispose();
        }
        check(context);
        const expired = await sql(
          pool,
          meter,
          `DELETE FROM search.public_filter_reference WHERE (partition_no,observation,token) IN
           (SELECT partition_no,observation,token FROM search.public_filter_reference
            WHERE (partition_no,observation)=($1,$2) AND expires_at<=$3 ORDER BY expires_at LIMIT 1) RETURNING token`,
          [...values, Date.now()],
          { points: 2, keys: 6, writes: 1 },
        );
        if (expired.rowCount) {
          const more = await sql(
            pool,
            meter,
            `SELECT token FROM search.public_filter_reference WHERE (partition_no,observation)=($1,$2)
             AND expires_at<=$3 ORDER BY expires_at LIMIT 1`,
            [...values, Date.now()],
            { points: 1, keys: 3, writes: 0 },
          );
          if (more.rowCount) throw new Failure('deadline');
        }
        check(context);
        // One funded PIT batch per invocation. The owned-only index prevents
        // released locator history from turning a bounded probe into a scan.
        const owned = await sql(
          pool,
          meter,
          "SELECT id,locator FROM search.public_filter_pit WHERE (partition_no,observation)=($1,$2) AND state='owned' ORDER BY id LIMIT 32",
          values,
        );
        if (owned.rowCount) {
          for (const pit of owned.rows) await deletePit(pit.locator, search, context, meter);
          check(context);
          await sql(
            pool,
            meter,
            "UPDATE search.public_filter_pit SET state='released' WHERE (partition_no,observation)=($1,$2) AND id=ANY($3::text[])",
            [...values, owned.rows.map((row) => row.id)],
          );
          const more = await sql(
            pool,
            meter,
            "SELECT id FROM search.public_filter_pit WHERE (partition_no,observation)=($1,$2) AND state='owned' ORDER BY id LIMIT 1",
            values,
            { points: 1, keys: 2, writes: 0 },
          );
          if (more.rowCount) throw new Failure('deadline');
        }
        check(context);
        await sql(
          pool,
          meter,
          "UPDATE search.public_filter_observation SET state='closed' WHERE (partition_no,observation)=($1,$2) AND state='closing'",
          values,
        );
        return { status: 'closed' as const, cost: meter };
      });
    },
    retire(value, context) {
      registration(value);
      return run(context, async (meter) => {
        const result = await sql(
          pool,
          meter,
          "UPDATE search.public_filter_registration SET state='retired' WHERE (partition_no,id)=($1,$2) RETURNING id",
          [value.partition, value.id],
        );
        if (!result.rowCount) throw new Failure('definition_missing');
        return { status: 'retired' as const, cost: meter };
      });
    },
    read(request, context) {
      return run(context, (meter, context) => read(pool, request, context, meter));
    },
    async close() {
      closed = true;
      await Promise.allSettled([...pending]);
    },
  };
  return api;
}
function addCost(target: Meter, value: CustodyCost) {
  for (const key of Object.keys(target) as (keyof Meter)[]) target[key] += value[key];
}
async function deletePit(pit: string, search: OpenSearch, context: PublicFilterConsumerContext, meter: Meter) {
  const receipt = await engine(search, meter, context, 'DELETE', '/_search/point_in_time', { pit_id: [pit] });
  assertRetainedPitDeletion(pit, receipt);
}

/** Exact located native copy, supplied by inventory receiving custody. No payload in workflow input. */
export type RetainedErasureCopy = Readonly<{
  partition: number;
  registration: string;
  observation: string;
  incarnation: string;
}>;
export type RetainedErasureProgress = Readonly<{
  state: 'more' | 'removed' | 'pending';
  reason?: 'in-use' | 'configuration-unavailable' | 'binding-mismatch' | 'native-ambiguous' | 'deadline';
  cost: CustodyCost;
}>;

/** One finite cleanup unit in existing custody. `removed` covers THIS observation only, never account
 * coverage, source reconciliation or an ACK. Replays remove one child at a time, returning no payload.
 * Existing calls admitted before the barrier drain through their native leases. No connection spans I/O.
 */
export async function stepRetainedObservationErasure(
  pool: Pool,
  copy: RetainedErasureCopy,
  search: OpenSearch | undefined,
  context: PublicFilterConsumerContext,
): Promise<RetainedErasureProgress> {
  context = requestContext({ deadline: Math.min(context.deadline, Date.now() + 5000) });
  home(copy.partition);
  requireValue(partition(copy.observation) === copy.partition);
  registration({ partition: copy.partition, id: copy.registration });
  text(copy.incarnation);
  const meter = operationCost(pool, context);
  const keys = [copy.partition, copy.observation];
  let q: PublicFilterQueriedObservation | undefined;
  try {
    check(context);
    // The observation lock serializes acquire, renew, execution append and final erasure.
    // Compare against the observation's original UUID; a newer public_filter_target cannot certify it.
    const barrier = await transaction(meter, async (tx) => {
      await sql(tx, meter, "SET LOCAL statement_timeout='5000ms'");
      const found = await sql(
        tx,
        meter,
        `SELECT registration,queried FROM search.public_filter_observation
           WHERE (partition_no,observation)=($1,$2) FOR UPDATE`,
        keys,
      );
      if (!found.rowCount) return 'absent';
      const row = found.rows[0];
      q = decode<PublicFilterQueriedObservation>(row.queried);
      queried(q);
      if (
        row.registration !== copy.registration ||
        q.snapshot.observation !== copy.observation ||
        q.consumer.incarnation !== copy.incarnation
      )
        return 'mismatch';
      await sql(
        tx,
        meter,
        `UPDATE search.public_filter_observation SET state=CASE WHEN state='closed' THEN state ELSE 'closing' END
           WHERE (partition_no,observation)=($1,$2)`,
        keys,
      );
      if (q.snapshot.kind === 'prepared') {
        // The payload is shared with other retained observations. Refuse recapture of this generation
        // before scrubbing its duplicate; their own observation payloads remain separate work items.
        await sql(
          tx,
          meter,
          `UPDATE search.public_filter_prepared SET state='erasing'
             ,segment_state=CASE WHEN segment_state='legacy' THEN 'legacy' ELSE 'erasing' END
             WHERE (partition_no,registration,build,generation)=($1,$2,$3,$4)`,
          [copy.partition, copy.registration, q.snapshot.build, q.snapshot.generation.toString()],
        );
      }
      return 'found';
    });
    if (barrier === 'mismatch') return { state: 'pending', reason: 'binding-mismatch', cost: meter };
    if (barrier === 'absent') return { state: 'removed', cost: meter };
    check(context);
    const live = await sql(
      pool,
      meter,
      `SELECT token FROM search.public_filter_reference
       WHERE (partition_no,observation)=($1,$2) AND expires_at>$3 ORDER BY expires_at DESC LIMIT 1`,
      [...keys, Date.now()],
    );
    if (live.rowCount) return { state: 'pending', reason: 'in-use', cost: meter };
    // Delete one expired lease per unit; don't disguise a large DELETE as a bounded probe.
    const refs = await sql(
      pool,
      meter,
      `DELETE FROM search.public_filter_reference WHERE (partition_no,observation,token) IN
       (SELECT partition_no,observation,token FROM search.public_filter_reference
        WHERE (partition_no,observation)=($1,$2) ORDER BY token LIMIT 1) RETURNING token`,
      keys,
    );
    if (refs.rowCount) return { state: 'more', cost: meter };
    const pits = await sql(
      pool,
      meter,
      `SELECT id,locator,state FROM search.public_filter_pit
       WHERE (partition_no,observation)=($1,$2) ORDER BY id LIMIT 1`,
      keys,
    );
    if (pits.rowCount) {
      const pit = pits.rows[0];
      if (pit.state === 'owned') {
        if (!search) return { state: 'pending', reason: 'configuration-unavailable', cost: meter };
        await deletePit(pit.locator, search, context, meter);
        check(context);
      }
      await sql(pool, meter, 'DELETE FROM search.public_filter_pit WHERE (partition_no,observation,id)=($1,$2,$3)', [
        ...keys,
        pit.id,
      ]);
      return { state: 'more', cost: meter };
    }
    // Closing the observation already excludes current use. Release the manifest's
    // immutable foreign keys before removing the underlying native evidence.
    const ack = await sql(
      pool,
      meter,
      `DELETE FROM search.public_filter_ack_manifest WHERE (partition_no,observation)=($1,$2) RETURNING job`,
      keys,
      { points: 5, keys: 8, writes: 2 },
    );
    if (ack.rowCount) return { state: 'more', cost: meter };
    const proofSubject = await sql(
      pool,
      meter,
      `DELETE FROM search.public_filter_repair_subject WHERE (partition_no,observation,execution,subject) IN
       (SELECT partition_no,observation,execution,subject FROM search.public_filter_repair_subject
        WHERE (partition_no,observation)=($1,$2) ORDER BY execution,subject LIMIT 1) RETURNING subject`,
      keys,
    );
    if (proofSubject.rowCount) return { state: 'more', cost: meter };
    const effect = await sql(
      pool,
      meter,
      `DELETE FROM search.public_filter_repair_effect WHERE (partition_no,observation,execution,page,item) IN
       (SELECT partition_no,observation,execution,page,item FROM search.public_filter_repair_effect
        WHERE (partition_no,observation)=($1,$2) ORDER BY execution,page,item LIMIT 1) RETURNING item`,
      keys,
    );
    if (effect.rowCount) return { state: 'more', cost: meter };
    const page = await sql(
      pool,
      meter,
      `DELETE FROM search.public_filter_repair_page WHERE (partition_no,observation,execution,ordinal) IN
       (SELECT partition_no,observation,execution,ordinal FROM search.public_filter_repair_page
        WHERE (partition_no,observation)=($1,$2) ORDER BY execution,ordinal LIMIT 1) RETURNING ordinal`,
      keys,
    );
    if (page.rowCount) return { state: 'more', cost: meter };
    check(context);
    // A crashed request may never have disposed its root. Close one admitted
    // root before retiring children, retaining its full reservation and meter.
    // The partial index excludes finished/failed history from this finite step.
    const abandoned = await sql(
      pool,
      meter,
      `WITH candidate AS MATERIALIZED (
         SELECT partition_no,id FROM search.public_filter_coverage_page
         WHERE (partition_no,observation)=($1,$2) AND state IN ('planned','open','sealed')
         ORDER BY id LIMIT 1)
       UPDATE search.public_filter_coverage_page p SET state='failed',revision=revision+1
       FROM candidate c WHERE (p.partition_no,p.id)=(c.partition_no,c.id)
         AND p.state IN ('planned','open','sealed') RETURNING p.id`,
      keys,
      { points: 2, keys: 4, writes: 1 },
    );
    if (abandoned.rowCount) return { state: 'more', cost: meter };
    check(context);
    const executions = await sql(
      pool,
      meter,
      // Lock the original observation and page before the child, matching
      // completion's page-before-child order. The trigger rechecks actual drain;
      // an expired/missing lease or a missing deletion receipt is not a shortcut.
      `WITH candidate AS MATERIALIZED (
         SELECT partition_no,observation,id,page_id FROM search.public_filter_execution
         WHERE (partition_no,observation)=($1,$2) ORDER BY id LIMIT 1),
       observation AS MATERIALIZED (
         SELECT o.partition_no,o.observation FROM search.public_filter_observation o
         JOIN candidate c USING(partition_no,observation)
         WHERE o.state IN ('closing','closed') FOR UPDATE OF o),
       page AS MATERIALIZED (
         SELECT p.partition_no,p.id FROM search.public_filter_coverage_page p
         JOIN candidate c ON (p.partition_no,p.id)=(c.partition_no,c.page_id)
         JOIN observation o ON (o.partition_no,o.observation)=(p.partition_no,p.observation) FOR UPDATE OF p)
       DELETE FROM search.public_filter_execution e USING candidate c,observation o
       WHERE (e.partition_no,e.observation,e.id)=(c.partition_no,c.observation,c.id)
         AND (o.partition_no,o.observation)=(c.partition_no,c.observation)
         AND (c.page_id IS NULL OR EXISTS (SELECT 1 FROM page p
           WHERE (p.partition_no,p.id)=(c.partition_no,c.page_id))) RETURNING e.id`,
      keys,
      // Candidate/write, original observation/page, repeated native guard
      // controls, lease/PIT misses and the repair-page foreign-key check. Reserve
      // the entire footprint before dispatch, including an ambiguous response.
      { points: 9, keys: 24, writes: 1 },
    );
    if (executions.rowCount) return { state: 'more', cost: meter };
    check(context);
    // A page retains its immutable plan, cursor boundary and failed dispatches
    // until the original observation has drained. Retire one bounded root only.
    const coveragePage = await sql(
      pool,
      meter,
      `DELETE FROM search.public_filter_coverage_page WHERE (partition_no,id) IN
       (SELECT partition_no,id FROM search.public_filter_coverage_page
        WHERE (partition_no,observation)=($1,$2) ORDER BY id LIMIT 1) RETURNING id`,
      keys,
      { points: 7, keys: 14, writes: 1 },
    );
    if (coveragePage.rowCount) return { state: 'more', cost: meter };
    check(context);
    // Retire one original Source start only after the same observation has
    // excluded admission and drained every native lease, copy and child above.
    // Reserve the candidate/write and four keyed trigger controls, including misses.
    const starts = await sql(
      pool,
      meter,
      `DELETE FROM semantic.public_filter_population_start WHERE (partition_no,id) IN
       (SELECT partition_no,id FROM semantic.public_filter_population_start
        WHERE (partition_no,observation)=($1,$2) ORDER BY id LIMIT 1) RETURNING id`,
      keys,
      { points: 6, keys: 12, writes: 1 },
    );
    if (starts.rowCount) return { state: 'more', cost: meter };
    check(context);
    if (q?.snapshot.kind === 'prepared') {
      const key = preparationKey(
        { partition: copy.partition, id: copy.registration },
        q.snapshot.build,
        q.snapshot.generation,
      );
      const removed = await retireSegmentRows((statement, values) => sql(pool, meter, statement, values), key, 100);
      if (removed) return { state: 'more', cost: meter };
      await sql(
        pool,
        meter,
        `UPDATE search.public_filter_prepared SET rows=$5,
          segment_state=CASE WHEN segment_state='legacy' THEN 'legacy' ELSE 'erasing' END,
          raw_count=0,output_count=0,raw_exhausted=false,source_cursor=NULL
         WHERE (partition_no,registration,build,generation)=($1,$2,$3,$4) AND state='erasing'`,
        [copy.partition, copy.registration, q.snapshot.build, q.snapshot.generation.toString(), encode([])],
      );
    }
    await sql(
      pool,
      meter,
      `DELETE FROM search.public_filter_observation WHERE (partition_no,observation)=($1,$2)
       AND state IN ('closing','closed')`,
      keys,
    );
    return { state: 'removed', cost: meter };
  } catch (error) {
    // Lost native responses and missing endpoints retain the locator for retry. A generic 404 isn't proof.
    if (error instanceof TypeError) throw error;
    return {
      state: 'pending',
      reason: error instanceof Failure && error.reason === 'deadline' ? 'deadline' : 'native-ambiguous',
      cost: meter,
    };
  }
}

/** One registration range of ALL retained populations, including excluded/zero-hit observations and
 * prepared payloads whose last observation was already closed. The stored consumer supplies the UUID;
 * a reused physical name never makes an old PIT belong to the new incarnation.
 */
export async function stepRetainedTargetErasure(
  pool: Pool,
  target: Readonly<{ partition: number; physicalTarget: string; after: string | null }>,
  search: OpenSearch | undefined,
  context: PublicFilterConsumerContext,
): Promise<
  Readonly<{
    state: 'more' | 'complete' | 'pending';
    after: string | null;
    reason?: RetainedErasureProgress['reason'];
    cost: CustodyCost;
  }>
> {
  context = requestContext(context);
  home(target.partition);
  text(target.physicalTarget);
  const meter = operationCost(pool, context);
  try {
    check(context);
    const registrations = await sql(
      pool,
      meter,
      `SELECT id,consumer FROM search.public_filter_registration
       WHERE partition_no=$1 AND physical_target=$2 AND ($3::text IS NULL OR id>$3)
       ORDER BY id LIMIT 1`,
      [target.partition, target.physicalTarget, target.after],
    );
    const row = registrations.rows[0];
    if (!row) return { state: 'complete', after: target.after, cost: meter };
    const consumer = decode<PublicFilterConsumer>(row.consumer);
    requireValue(consumer.physicalTarget === target.physicalTarget);
    const observation = await sql(
      pool,
      meter,
      `SELECT observation FROM search.public_filter_observation
       WHERE (partition_no,registration)=($1,$2) ORDER BY observation LIMIT 1`,
      [target.partition, row.id],
    );
    if (observation.rowCount) {
      const progress = await stepRetainedObservationErasure(
        pool,
        {
          partition: target.partition,
          registration: row.id,
          observation: observation.rows[0].observation,
          incarnation: consumer.incarnation,
        },
        search,
        context,
      );
      addCost(meter, progress.cost);
      return {
        state: progress.state === 'pending' ? 'pending' : 'more',
        after: target.after,
        reason: progress.reason,
        cost: meter,
      };
    }
    // Prepared has independent custody after the observation disappeared. Lock its own immutable
    // key and refuse recapture BEFORE clearing it, under the same lock used by retainPrepared's UPSERT.
    const prepared = await sql(
      pool,
      meter,
      `SELECT p.build,p.generation,p.segment_state,p.rows,p.state
       FROM search.public_filter_prepared p
       WHERE (p.partition_no,p.registration)=($1,$2)
         AND (p.state<>'erasing' OR p.rows<>$3 OR p.raw_count<>0 OR p.output_count<>0
           OR p.raw_exhausted OR p.source_cursor IS NOT NULL OR EXISTS (
           SELECT 1 FROM search.public_filter_preparation_segment s
           WHERE (s.partition_no,s.registration,s.build,s.generation)=
             (p.partition_no,p.registration,p.build,p.generation)))
       ORDER BY p.build,p.generation LIMIT 1 FOR UPDATE`,
      [target.partition, row.id, encode([])],
    );
    if (!prepared.rowCount) return { state: 'more', after: row.id, cost: meter };
    const build = prepared.rows[0]!.build as string;
    const generation = BigInt(String(prepared.rows[0]!.generation));
    await sql(
      pool,
      meter,
      `UPDATE search.public_filter_prepared SET state='erasing',
         segment_state=CASE WHEN segment_state='legacy' THEN 'legacy' ELSE 'erasing' END
       WHERE (partition_no,registration,build,generation)=($1,$2,$3,$4::numeric)`,
      [target.partition, row.id, build, generation.toString()],
    );
    const key = preparationKey({ partition: target.partition, id: row.id }, build, generation);
    const removed = await retireSegmentRows((statement, values) => sql(pool, meter, statement, values), key, 100);
    if (removed) return { state: 'more', after: target.after, cost: meter };
    await sql(
      pool,
      meter,
      `UPDATE search.public_filter_prepared SET rows=$5,raw_count=0,output_count=0,
         raw_exhausted=false,source_cursor=NULL
       WHERE (partition_no,registration,build,generation)=($1,$2,$3,$4::numeric)
         AND state='erasing' AND (rows<>$5 OR raw_count<>0 OR output_count<>0
           OR raw_exhausted OR source_cursor IS NOT NULL)`,
      [target.partition, row.id, build, generation.toString(), encode([])],
    );
    return { state: 'more', after: target.after, cost: meter };
  } catch (error) {
    if (error instanceof TypeError) throw error;
    return {
      state: 'pending',
      after: target.after,
      reason: error instanceof Failure && error.reason === 'deadline' ? 'deadline' : 'native-ambiguous',
      cost: meter,
    };
  }
}

export const readBookRegistrations: NonNullable<
  import('../semantic/index.ts').PublicFilterSearchBindingPort['readBookRegistrations']
> = async (pool, members, context) => {
  const shared = operationCost(pool, context);
  try {
    const inputs = members.map(({ consumer, definition }) => {
      return {
        id: digest({ consumer, source: definition.source.id }),
        consumer: encode(consumer),
        target: consumer.physicalTarget,
        incarnation: consumer.incarnation,
        definition: encodeInstalledDefinition(definition),
      };
    });
    // Embedded definitions can contain the entire release. Only send that form on the legacy path.
    const rows = await sql(
      pool,
      shared,
      `SELECT r.id FROM jsonb_to_recordset($1)
        i(id text,consumer text,target text,incarnation text,definition text)
        JOIN search.public_filter_registration r ON (r.partition_no,r.id)=(0,i.id) AND r.consumer=i.consumer
          AND r.definition=i.definition AND r.physical_target=i.target AND r.state='active'
        JOIN search.public_filter_target t ON (t.partition_no,t.physical_target,t.incarnation)=(0,i.target,i.incarnation)
        WHERE NOT EXISTS (SELECT 1 FROM search.public_filter_registration other
          WHERE other.partition_no=0 AND other.physical_target=i.target AND md5(other.consumer)=md5(i.consumer)
            AND other.consumer=i.consumer AND other.state='active' AND other.id<>r.id)`,
      [JSON.stringify(inputs)],
    );
    const ids = new Set(rows.rows.map((r) => r.id));
    const results = [];
    for (const [index, { consumer, definition }] of members.entries()) {
      const id = inputs[index]!.id;
      const cost = bookCostShare(shared, index, members.length);
      if (ids.has(id))
        results.push({
          definition,
          registeredDefinition: inputs[index]!.definition,
          registration: { partition: 0, id },
          queried: null,
          cost,
        });
      else {
        const original = await readGenerationPublicationCustody(pool, consumer, 0, context, undefined, 'registration');
        for (const k of Object.keys(cost) as (keyof Meter)[]) cost[k] += original.cost[k];
        results.push({ ...original, cost });
      }
    }
    return results;
  } catch (error) {
    const failed = failure(error, shared);
    return members.map((_, i) => ({ ...failed, cost: bookCostShare(shared, i, members.length) }));
  }
};

/** Publication adopts existing immutable custody; it never creates observation readiness.
 * The source home and physical consumer indexes bound both lookups to one native record.
 */
export async function readGenerationPublicationCustody(
  pool: Pool,
  consumer: PublicFilterConsumer,
  sourceHome: number | undefined,
  context: PublicFilterConsumerContext,
  observation?: string,
  recovery?: 'registration' | Readonly<{ bootstrap: { observation: string }; snapshot: 'pit' | 'prepared' }>,
): Promise<
  | Readonly<{
      definition: CustodyRetainedDefinition;
      registration: CustodyRegistration;
      queried: PublicFilterQueriedObservation | null;
      cost: CustodyCost;
    }>
  | CustodyFailure
> {
  context = requestContext(context);
  const meter = operationCost(pool, context);
  try {
    check(context);
    if (sourceHome !== undefined) home(sourceHome);
    const original = typeof recovery === 'object' ? recovery : undefined;
    const registered = await sql(
      pool,
      meter,
      `SELECT r.partition_no,r.id,r.definition,o.queried,o.expires_at
       FROM search.public_filter_registration r
       JOIN search.public_filter_target t USING(partition_no,physical_target)
       LEFT JOIN LATERAL (
         SELECT queried,expires_at FROM search.public_filter_observation
         WHERE (partition_no,registration)=(r.partition_no,r.id)
           AND NOT $8::boolean AND (observation=$5::text OR $5::text IS NULL) AND state='open'
           AND ($6::text IS NULL OR
             (md5(covered)=md5($6) AND covered=$6 AND prepared_build IS NOT DISTINCT FROM $7::text))
         ORDER BY observation DESC LIMIT (CASE WHEN $6::text IS NULL THEN 1 ELSE 2 END)
       ) o ON true
       WHERE ($1::integer IS NULL OR r.partition_no=$1) AND r.physical_target=$2 AND md5(r.consumer)=md5($3)
         AND r.consumer=$3 AND r.state='active' AND t.incarnation=$4 LIMIT 2`,
      [
        sourceHome,
        consumer.physicalTarget,
        encode(consumer),
        consumer.incarnation,
        observation ?? null,
        original ? encode(original.bootstrap) : null,
        original?.snapshot === 'prepared' ? original.bootstrap.observation : null,
        recovery === 'registration',
      ],
    );
    const row = registered.rows[0];
    if (!row || registered.rows.length !== 1) throw new Failure('definition_missing');
    const definition = decode<{ digest: string; data: CustodyRetainedDefinition }>(row.definition);
    requireValue(definition.digest === digest(definition.data));
    const registration = { partition: row.partition_no as number, id: row.id as string };
    if (row.queried === null) return { definition: definition.data, registration, queried: null, cost: meter };
    const q = decode<PublicFilterQueriedObservation>(row.queried);
    queried(q);
    requireValue(encode(q.consumer) === encode(consumer) && encode(q) === row.queried);
    if (!(Number(row.expires_at) > Date.now())) throw new Failure('observation_lost');
    if (isReleaseReference(definition.data.meaning.release)) {
      requireValue(definition.data.meaning.release.digest === definition.data.meaning.digest);
      await requireReleaseAuthority(pool, meter, definition.data.meaning.digest);
    }
    check(context);
    return { definition: definition.data, registration, queried: q, cost: meter };
  } catch (error) {
    return failure(error, meter);
  }
}

export { drainGenerationPublicationProofCopy, hasRetainedWriterPublicationCopies } from './publication-proof-copy.ts';
