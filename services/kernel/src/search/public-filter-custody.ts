import { canonicalDiscoveryCatalogue, publicFilterCatalogue } from './discovery-catalogue.ts';
import { verifyPublicFilterRepairSourcePage, PublicFilterRepairSourceError } from './public-filter-custody-source.ts';
import repairTransaction from './public-filter-custody-repair-transaction.sql';
import repairFinish from './public-filter-custody-repair-finish.sql';
import repairWriter from './public-filter-custody-repair-writer.sql';
import repairGate from './public-filter-custody-repair-gate.sql';
import repairOwner from './public-filter-custody-repair-owner.sql';
import repairTarget from './public-filter-custody-repair-target.sql';
import repairRegistration from './public-filter-custody-repair-registration.sql';
import repairEffect from './public-filter-custody-repair-effect.sql';
import repairPage from './public-filter-custody-repair-page.sql';
import repairPages from './public-filter-custody-repair-pages.sql';
import repairState from './public-filter-custody-repair-state.sql';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { isDeepStrictEqual } from 'node:util';
import {
  verifyPublicFilterRepairWriterReceipt,
  readPublicFilterRepairPhysicalTarget,
  repairWriterPosition,
  validatePublicFilterRepairWriterEvidence,
  isDiscoveryRepairWriterReceipt,
  type PublicFilterRepairWriterReceipt,
} from './writer-guard.ts';
import { subjectPartition } from './source.ts';
import { validateRefreshResponse } from './write-actions.ts';
import { releaseDigest } from '@rezics/definitions';
import { admitFilter, walkFilter } from '@rezics/filter';
import releaseExists from '../semantic/definitions-exists.sql';
import compositeReference from '../semantic/composite-read.sql';
import { withConnection } from '../database/pool.ts';
import { compileDiscoveryConsumerCapture } from './discovery.ts';
import { compileFilter } from './filter.ts';
import { compileText } from './text.ts';
import { validatePublicSuggestionInput } from './public-suggestion-input.ts';
import { createOpenSearch, OpenSearchError, type OpenSearch } from './opensearch.ts';
import type { PublicFilterCost } from '../semantic/public-filter-source-contract.ts';
import { assertRetainedPitDeletion } from './erasure-pit.ts';
import type { PublicFilterConsumer, PublicFilterDependencyKey } from '../semantic/public-filter-source-contract.ts';
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
// A tagged canonical tree preserves bigint/undefined without collisions with user JSON objects.
type Tree = [string, unknown?];
function tree(value: unknown): Tree {
  if (value === undefined) return ['undefined'];
  if (typeof value === 'bigint') return ['bigint', value.toString()];
  if (Array.isArray(value)) return ['array', value.map(tree)];
  if (value !== null && typeof value === 'object')
    return [
      'object',
      Object.keys(value)
        .sort()
        .map((key) => [key, tree((value as Record<string, unknown>)[key])]),
    ];
  requireValue(
    value === null ||
      typeof value === 'string' ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value)),
  );
  return ['scalar', value];
}
function untree(value: Tree): unknown {
  switch (value[0]) {
    case 'undefined':
      return undefined;
    case 'bigint':
      return BigInt(value[1] as string);
    case 'array':
      return (value[1] as Tree[]).map(untree);
    case 'object':
      return Object.fromEntries((value[1] as [string, Tree][]).map(([key, entry]) => [key, untree(entry)]));
    case 'value': // Existing consumer_work encoding.
    case 'scalar':
      return value[1];
    default:
      throw new TypeError('Invalid custody encoding');
  }
}
const encode = (value: unknown) => JSON.stringify(tree(value));
const decode = <T>(value: string): T => untree(JSON.parse(value) as Tree) as T;
/** Internal durable native encoding; never constructs a settlement or Source proof. */
export const encodePublicFilterNativeState = encode;
export const decodePublicFilterNativeState = decode;
const digest = (value: unknown) => createHash('sha256').update(encode(value)).digest('hex');
function requireValue(value: unknown): asserts value {
  if (!value) throw new TypeError('Invalid public filter custody input');
}
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
  db: Pool | PoolClient,
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
  const result = await db.query(query, values);
  if (!native) meter.rows += result.rowCount ?? 0;
  meter.bytes += Buffer.byteLength(encode(result.rows));
  if (!native && /\b(INSERT|UPDATE|DELETE)\b/.test(query)) meter.resultWrites += result.rowCount ?? 0;
  return result;
}
function isReleaseReference(
  release: CustodyRetainedDefinition['meaning']['release'],
): release is CustodyReleaseReference {
  return 'authority' in release && release.authority === 'semantic.readRelease';
}
async function requireReleaseAuthority(pool: Pool, meter: Meter, digest: string) {
  // Use the existing immutable owner lookups. Charge their actual SQL and returned metadata too.
  // Neither lookup loads a release body, joins homes, nor consults/caches permission.
  const db = { query: (query: string, values?: unknown[]) => sql(pool, meter, query, values) } as Pool;
  if (await releaseExists.run(db, { route: 0, digest })) return;
  if (await compositeReference.run(db, { digest })) return;
  throw new Failure('definition_missing');
}
async function retainedDefinition(
  pool: Pool,
  meter: Meter,
  definition: CustodyDefinition<PublicCanonicalCaptureInput>,
) {
  let retained: CustodyRetainedDefinition = definition;
  let encoded = encode({ digest: digest(retained), data: retained });
  if (Buffer.byteLength(encoded) > 1048576) {
    await requireReleaseAuthority(pool, meter, definition.meaning.digest);
    retained = {
      ...definition,
      meaning: {
        digest: definition.meaning.digest,
        type: definition.meaning.type,
        release: { authority: 'semantic.readRelease', digest: definition.meaning.digest },
      },
    };
    encoded = encode({ digest: digest(retained), data: retained });
  }
  // The original storage ceiling applies to all retained capture/key metadata as well.
  requireValue(Buffer.byteLength(encoded) <= 1048576);
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
  requireValue(definition.meaning.digest === releaseDigest(definition.meaning.release));
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
  pool: Pool,
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
export async function readPublicFilterConsumerCustody(
  pool: Pool,
  request: CustodyRead,
  context: PublicFilterConsumerContext,
): Promise<CustodyFound | CustodyFailure> {
  const meter = cost();
  try {
    return await read(pool, request, context, meter);
  } catch (error) {
    return failure(error, meter);
  }
}

// Constructor routing only, analogous to publicFilterSourceOrigin. No receipt, positive result,
// settlement or retained state is cached here. Recovery must install the real owner binding again.
const repairSources = new WeakMap<Pool, PublicFilterRepairSourceBinding>();
const repairAllowance = new AsyncLocalStorage<CustodyCost>();
/** Keep all reader phases within the calling consumer's already-spent allowance. */
export function withPublicFilterRepairAllowance<T>(spent: CustodyCost, work: () => Promise<T>): Promise<T> {
  return repairAllowance.run({ ...spent }, work);
}

/** The sole native guard: owner verification runs between released and freshly reopened local homes. */
export async function readPublicFilterRepairSettlement(
  pool: Pool,
  request: Readonly<{
    queried: PublicFilterQueriedObservation;
    execution: string;
  }>,
  context: PublicFilterConsumerContext,
): Promise<PublicFilterRepairSettlementResult> {
  const meter: Meter = cost();
  const spent = repairAllowance.getStore() ?? cost();
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
    const admit = () => {
      check(context);
      if (
        spent.inputKeys + meter.inputKeys > 1000 ||
        spent.bytes + meter.bytes > 4 * 1024 * 1024 ||
        spent.rows + meter.rows > 64 + 16 * Math.max(spent.candidates + meter.candidates, 1) ||
        spent.accessPoints + meter.accessPoints + spent.dependencyPoints + meter.dependencyPoints >
          16 + 8 * Math.max(spent.candidates + meter.candidates, 1)
      )
        throw new Failure('owner_unavailable');
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
        meter.bytes += Buffer.byteLength(path) + Buffer.byteLength(encode(body));
        const result = await transport.request(method, path, body, {
          ...options,
          timeoutMs: Math.max(1, context.deadline - Date.now()),
        });
        meter.bytes += Buffer.byteLength(encode(result.body));
        if (path.endsWith('/_search')) {
          meter.engineSearches++;
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
    const q = input.queried;
    const home = partition(q.snapshot.observation);
    const keys = {
      partition_no: home,
      observation: q.snapshot.observation,
      execution: input.execution,
    };
    const local = async <T>(work: (db: Pool, raw: Pool) => Promise<T>): Promise<T> =>
      withConnection(pool, async (client) => {
        const raw = {
          query: (statement: string, values: unknown[] = []) => {
            admit();
            const request: import('pg').QueryConfig & { query_timeout: number } = {
              text: statement,
              values,
              query_timeout: Math.max(1, context.deadline - Date.now()),
            };
            return client.query(request);
          },
        } as Pool;
        const db = {
          query: async (statement: string, values: unknown[] = []) => {
            admit();
            const result = await sql(raw, meter, statement, values);
            admit();
            return result;
          },
        } as Pool;
        await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        try {
          const result = await work(db, raw);
          await db.query('COMMIT');
          return result;
        } catch (error) {
          // Cleanup still runs when the original allowance/deadline is exhausted.
          meter.statements++;
          meter.bytes += Buffer.byteLength('ROLLBACK') + Buffer.byteLength(encode([]));
          const rolledBack = await client.query('ROLLBACK');
          meter.rows += rolledBack.rowCount ?? 0;
          meter.bytes += Buffer.byteLength(encode(rolledBack.rows));
          throw error;
        }
      });
    const load = async (db: Pool, raw: Pool) => {
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
      const registration = await repairRegistration.run(db, {
        partition_no: home,
        registration: stateRow.registration,
      });
      const target = await repairTarget.run(db, {
        partition_no: home,
        physical_target: q.consumer.physicalTarget,
      });
      if (
        !registration ||
        !isDeepStrictEqual(decode(registration.consumer), q.consumer) ||
        target?.incarnation !== q.consumer.incarnation
      )
        throw new Failure('binding_mismatch');
      const pages: {
        ordinal: number;
        intent: string;
        page: RetainedRepairPage;
      }[] = [];
      const copies = new Map<string, string>();
      const latest = new Map<string, PublicFilterRepairWriterReceipt>();
      const effects: { page: number; item: number; receipt: string }[] = [];
      const append = async (ordinal: number, intent: string) => {
        const page = decode<RetainedRepairPage>(intent);
        if (
          !page.sourceStep ||
          page.repairs.length > 256 ||
          (page.complete ? page.frontier !== null : page.frontier !== page.sourceStep)
        )
          throw new Failure('binding_mismatch');
        // The native producer CAS advances through every page. Check adjacent retained links at
        // each selected page; complete Source chain/window proof belongs to the final owner read.
        const previous = ordinal === 0 ? null : await repairPage.run(db, { ...keys, ordinal: ordinal - 1 });
        if (
          (ordinal > 0 && !previous) ||
          page.predecessor !== (previous ? decode<RetainedRepairPage>(previous.intent).frontier : null)
        )
          throw new Failure('binding_mismatch');
        pages.push({ ordinal, intent, page });
        for (const [item, repair] of page.repairs.entries()) {
          meter.candidates++;
          meter.inputKeys++;
          meter.accessPoints++;
          meter.dependencyPoints++;
          admit();
          if (
            (repair.projection.status !== 'progress' && repair.projection.status !== 'complete') ||
            !isDeepStrictEqual(repair.source, repair.projection.source) ||
            repair.source.partition !== subjectPartition(repair.source.subject) ||
            repair.source.subject !== repair.locator.subject
          )
            throw new Failure('binding_mismatch');
          const sourceKey = encode(repair.source);
          const prior = copies.get(repair.source.subject);
          if (prior && prior !== sourceKey) throw new Failure('binding_mismatch');
          if (repair.projection.status === 'progress') {
            copies.set(repair.source.subject, sourceKey);
            continue;
          }
          const effect = await repairEffect.run(db, {
            ...keys,
            page: ordinal,
            item,
          });
          if (!effect) throw new Failure('owner_unavailable');
          effects.push({ page: ordinal, item, receipt: effect.receipt });
          const receipt = decode<PublicFilterRepairWriterReceipt>(effect.receipt);
          const locator = encode({
            observation: q.snapshot.observation,
            execution: input.execution,
            page: ordinal,
            item,
          });
          if (
            receipt.locator !== locator ||
            receipt.subject !== repair.source.subject ||
            receipt.partition !== repair.source.partition ||
            receipt.epoch !== repair.source.epoch ||
            repairWriterPosition(receipt) < repair.source.position ||
            receipt.incarnation !== q.consumer.incarnation
          )
            throw new Failure('binding_mismatch');
          validatePublicFilterRepairWriterEvidence(q.consumer.physicalTarget, receipt);
          const previous = latest.get(receipt.subject);
          if (
            previous &&
            (repairWriterPosition(receipt) < repairWriterPosition(previous) ||
              receipt.enrollment.position <= previous.completion.position)
          )
            throw new Failure('binding_mismatch');
          latest.set(receipt.subject, receipt);
          copies.delete(receipt.subject);
        }
        if (page.account) {
          if (page.repairs.length || page.complete) throw new Failure('binding_mismatch');
          meter.candidates++;
          meter.inputKeys++;
          admit();
          const effect = await repairEffect.run(db, { ...keys, page: ordinal, item: 0 });
          if (!effect) throw new Failure('owner_unavailable');
          const receipt = decode<PublicFilterRepairWriterReceipt>(effect.receipt);
          if (
            !isDiscoveryRepairWriterReceipt(receipt) ||
            receipt.owner !== 'accounts' ||
            !receipt.account ||
            !isDeepStrictEqual({ ...receipt.account, position: page.account.position }, page.account) ||
            receipt.locator !==
              encode({ observation: q.snapshot.observation, execution: input.execution, page: ordinal, item: 0 }) ||
            receipt.subject !== page.account.id ||
            receipt.partition !== page.account.head.partition ||
            receipt.epoch !== page.account.head.epoch ||
            repairWriterPosition(receipt) < page.account.position ||
            receipt.incarnation !== q.consumer.incarnation
          )
            throw new Failure('binding_mismatch');
          validatePublicFilterRepairWriterEvidence(q.consumer.physicalTarget, receipt);
          const previous = latest.get(receipt.subject);
          if (
            previous &&
            (repairWriterPosition(receipt) < repairWriterPosition(previous) ||
              receipt.enrollment.position <= previous.completion.position)
          )
            throw new Failure('binding_mismatch');
          effects.push({ page: ordinal, item: 0, receipt: effect.receipt });
          latest.set(receipt.subject, receipt);
        }
      };
      let after = -1;
      for (;;) {
        admit();
        const row = await repairPages.run(db, { ...keys, after });
        if (!row) break;
        if (row.ordinal <= after || row.ordinal >= state.pages) throw new Failure('binding_mismatch');
        await append(row.ordinal, row.intent);
        after = row.ordinal;
      }
      if (after !== state.pages - 1) {
        const last = await repairPage.run(db, {
          ...keys,
          ordinal: state.pages - 1,
        });
        if (!last) throw new Failure('owner_unavailable');
        await append(state.pages - 1, last.intent);
      }
      const last = pages.at(-1)!;
      if (!last.page.complete || last.page.frontier !== null) throw new Failure('owner_unavailable');
      if (copies.size) throw new Failure('owner_unavailable');
      const physical = await readPublicFilterRepairPhysicalTarget(db, search, q.consumer.physicalTarget);
      if (physical.incarnation !== q.consumer.incarnation) throw new Failure('binding_mismatch');
      const own = [...new Set(retained.execution.ownRows.flatMap((row) => [row.original, row.terminal]))].sort();
      const subjects = [...new Set([...own, ...latest.keys()])].sort(
        (a, b) => subjectPartition(a) - subjectPartition(b) || a.localeCompare(b),
      );
      const homes = [...new Set(subjects.map(subjectPartition))].sort((a, b) => a - b);
      const gates = [];
      for (const partition_no of homes) {
        const gate = await repairGate.run(db, {
          partition_no,
          physical_target: q.consumer.physicalTarget,
        });
        if (
          gate &&
          (gate.incarnation !== physical.incarnation || gate.write_alias !== physical.writeAlias || gate.closed_token)
        )
          throw new Failure('identity_pending');
        gates.push({ partition_no, gate });
      }
      const owners = [];
      for (const partition_no of [...new Set([...homes, home, retained.definition.source.partition])].sort(
        (a, b) => a - b,
      )) {
        const owner = await repairOwner.run(db, { partition_no });
        if (
          owner?.write_state !== 'active' ||
          (partition_no === retained.definition.source.partition && owner.epoch !== retained.definition.source.epoch)
        )
          throw new Failure('owner_unavailable');
        owners.push({
          partition_no,
          epoch: owner.epoch,
          write_state: owner.write_state,
        });
      }
      const writers = [];
      for (const original_id of subjects) {
        meter.inputKeys++;
        meter.candidates++;
        admit();
        const partition_no = subjectPartition(original_id);
        const writer = await repairWriter.run(db, {
          partition_no,
          physical_target: q.consumer.physicalTarget,
          original_id,
        });
        const owner = owners.find((row) => row.partition_no === partition_no)!;
        const gate = gates.find((row) => row.partition_no === partition_no)!.gate;
        if (
          (gate && gate.owner_epoch !== owner.epoch) ||
          (writer &&
            (writer.writer_token ||
              writer.closed_job ||
              writer.dispatch_state !== 'settled' ||
              writer.incarnation !== physical.incarnation ||
              writer.owner_epoch !== owner.epoch))
        )
          throw new Failure('identity_pending');
        writers.push({ original_id, writer });
      }
      return {
        state,
        retained,
        latest,
        // Compare data only; mutable accumulated cost and unrelated partition command positions are excluded.
        basis: {
          stateRow,
          definition: retained.definition,
          queried: retained.queried,
          covered: retained.covered,
          execution: retained.execution,
          registration,
          target,
          pages,
          effects,
          physical,
          owners,
          gates,
          writers,
        },
      };
    };
    const staged = await local(load);
    // No held Search checkout, transaction, writer lock or foreign-home lease crosses this boundary.
    for (const entry of staged.basis.pages) {
      await verifyPublicFilterRepairSourcePage(
        binding,
        {
          bootstrap: staged.state.bootstrap,
          queried: q,
          execution: input.execution,
          predecessor: entry.page.predecessor,
        },
        entry.page,
        context,
        charge,
      );
    }
    return await local(async (db, raw) => {
      const final = await load(db, raw);
      if (!isDeepStrictEqual(final.basis, staged.basis)) throw new Failure('binding_mismatch');
      for (const receipt of [...final.latest.values()].sort(
        (a, b) => a.partition - b.partition || a.subject.localeCompare(b.subject),
      ))
        await verifyPublicFilterRepairWriterReceipt(db, search, q.consumer.physicalTarget, receipt);
      const refreshed = await search.request('POST', `/${q.consumer.physicalTarget}/_refresh`);
      validateRefreshResponse(refreshed.status, refreshed.body);
      if (
        !isDeepStrictEqual(
          await readPublicFilterRepairPhysicalTarget(db, search, q.consumer.physicalTarget),
          final.basis.physical,
        )
      )
        throw new Failure('binding_mismatch');
      const retained = await read(raw, input, context, meter, initial.definition);
      if (
        !isDeepStrictEqual(retained.execution, final.retained.execution) ||
        !isDeepStrictEqual(retained.covered, staged.state.covered)
      )
        throw new Failure('binding_mismatch');
      const transaction = await repairTransaction.run(db);
      if (!transaction?.id) throw new Failure('owner_unavailable');
      const fenced: RetainedRepairSettlement = {
        ...final.state,
        fence: {
          transaction: transaction.id,
          incarnation: final.basis.physical.incarnation,
          writeAlias: final.basis.physical.writeAlias,
          sourceEpoch: retained.definition.source.epoch,
          refresh: refreshed.body,
        },
      };
      const stored = await repairFinish.run(db, {
        ...keys,
        next: encode(fenced),
        previous: final.basis.stateRow.repair_settlement!,
      });
      if (stored.length !== 1) throw new Failure('binding_mismatch');
      admit();
      return {
        status: 'settled',
        definition: retained.definition,
        queried: retained.queried,
        execution: retained.execution!,
        settlement: Object.freeze({
          id: final.state.id,
        }) as NativePublicFilterRepairSettlement,
        cost: meter,
      };
    });
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
    work: (meter: Meter) => Promise<T>,
    allowClosed = false,
  ): Promise<T | CustodyFailure> {
    const meter = cost();
    const promise = (async () => {
      try {
        check(context);
        if (closed && !allowClosed) throw new Failure('owner_unavailable');
        const value = await work(meter);
        check(context);
        return value;
      } catch (error) {
        return failure(error, meter);
      }
    })();
    pending.add(promise);
    void promise.finally(() => pending.delete(promise)).catch(() => {});
    return promise;
  }
  async function transaction<T>(meter: Meter, work: (client: PoolClient) => Promise<T>): Promise<T> {
    return withConnection(pool, async (client) => {
      await sql(client, meter, 'BEGIN');
      try {
        const value = await work(client);
        await sql(client, meter, 'COMMIT');
        return value;
      } catch (error) {
        await sql(client, meter, 'ROLLBACK');
        throw error;
      }
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
    db: Pool | PoolClient = pool,
  ) {
    const inserted = await sql(
      db,
      meter,
      `WITH retained AS (INSERT INTO search.public_filter_observation (partition_no,observation,registration,queried,covered,expires_at,state,prepared_rows)
      SELECT r.partition_no,$3,r.id,$4,$5,$6,'open',$7 FROM search.public_filter_registration r JOIN search.public_filter_target t USING (partition_no,physical_target)
      WHERE (r.partition_no,r.id)=($1,$2) AND r.state='active' AND t.incarnation=$8 FOR SHARE OF r FOR UPDATE OF t RETURNING partition_no,observation), owned AS (INSERT INTO search.public_filter_pit SELECT partition_no,observation,$9,$10,'owned' FROM retained WHERE $10::text IS NOT NULL) SELECT observation FROM retained`,
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
      ],
    );
    if (!inserted.rowCount) throw new Failure('binding_mismatch');
    return { status: 'retained' as const, queried: q, cost: meter };
  }
  const api: PublicFilterCustody = {
    register(request, search, context) {
      // Copy before the first await, so concurrent caller mutation never changes persisted identity.
      const input = decode<typeof request>(encode(request));
      validateDefinition(input.definition);
      text(input.consumerGeneration);
      text(input.projectionGeneration);
      const catalogue = canonicalDiscoveryCatalogue(input.catalogue ?? null);
      return run(context, async (meter) => {
        const incarnation = await native(search, meter, context, input.physicalTarget);
        const definition = input.definition;
        const consumer: PublicFilterConsumer = {
          physicalTarget: input.physicalTarget,
          incarnation,
          consumerGeneration: input.consumerGeneration,
          projectionGeneration: input.projectionGeneration,
          meaningDigest: definition.meaning.digest,
          readDefinition: definition.readDefinition,
          catalogue,
        };
        const identity = {
          partition: definition.source.partition,
          id: digest({ consumer, source: definition.source.id }),
        };
        const retained = await retainedDefinition(pool, meter, definition);
        await transaction(meter, async (client) => {
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
            [identity.partition, identity.id, consumer.physicalTarget, encode(consumer), retained],
          );
          if (!result.rowCount) throw new Failure('binding_mismatch');
        });
        return { status: 'registered' as const, registration: identity, consumer, cost: meter };
      });
    },
    openPit(request, search, context) {
      const input = decode<typeof request>(encode(request));
      lifetime(input.keepAliveMs);
      text(input.covered.observation);
      return run(context, async (meter) => {
        const consumer = await registered(input.registration, meter);
        if ((await native(search, meter, context, consumer.physicalTarget)) !== consumer.incarnation)
          throw new Failure('binding_mismatch');
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
          if ((await native(search, meter, context, consumer.physicalTarget)) !== consumer.incarnation)
            throw new Failure('binding_mismatch');
          return await retain(
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
          );
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
    acquire(q, context) {
      const input = decode<typeof q>(encode(q));
      queried(input);
      return run(context, async (meter) => {
        const token = randomUUID();
        const result = await sql(
          pool,
          meter,
          `WITH locked AS (
          SELECT o.partition_no,o.observation FROM search.public_filter_observation o
          JOIN search.public_filter_registration r ON (r.partition_no,r.id)=(o.partition_no,o.registration)
          JOIN search.public_filter_target t ON (t.partition_no,t.physical_target)=(r.partition_no,r.physical_target)
          WHERE (o.partition_no,o.observation)=($1,$2) AND o.queried=$3 AND o.state='open' AND o.expires_at>$4 AND r.state='active' AND t.incarnation=$7 FOR UPDATE OF o FOR SHARE OF r,t)
          INSERT INTO search.public_filter_reference SELECT partition_no,observation,$5,$6 FROM locked RETURNING token`,
          [
            partition(input.snapshot.observation),
            input.snapshot.observation,
            encode(input),
            Date.now(),
            token,
            Math.min(context.deadline, Date.now() + 300_000),
            input.consumer.incarnation,
          ],
        );
        if (!result.rowCount) throw new Failure('observation_lost');
        return { status: 'acquired' as const, use: { observation: input.snapshot.observation, token }, cost: meter };
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
          await sql(
            pool,
            meter,
            'DELETE FROM search.public_filter_reference WHERE (partition_no,observation,token)=($1,$2,$3)',
            [partition(use.observation), use.observation, use.token],
          );
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
      return run(context, async (meter) => {
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
          addCost(meter, (await api.release(acquired.use, context)).cost);
        }
      });
    },
    closeObservation(q, search, context) {
      const input = decode<typeof q>(encode(q));
      queried(input);
      return run(context, async (meter) => {
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
      return run(context, (meter) => read(pool, request, context, meter));
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
  context = { deadline: Math.min(context.deadline, Date.now() + 5000) };
  home(copy.partition);
  requireValue(partition(copy.observation) === copy.partition);
  registration({ partition: copy.partition, id: copy.registration });
  text(copy.incarnation);
  const meter = cost();
  const keys = [copy.partition, copy.observation];
  let q: PublicFilterQueriedObservation | undefined;
  try {
    check(context);
    // The observation lock serializes acquire, renew, execution append and final erasure.
    // Compare against the observation's original UUID; a newer public_filter_target cannot certify it.
    const barrier = await withConnection(pool, async (tx) => {
      await sql(tx, meter, 'BEGIN');
      try {
        await sql(tx, meter, "SET LOCAL statement_timeout='5000ms'");
        const found = await sql(
          tx,
          meter,
          `SELECT registration,queried FROM search.public_filter_observation
           WHERE (partition_no,observation)=($1,$2) FOR UPDATE`,
          keys,
        );
        if (!found.rowCount) {
          await sql(tx, meter, 'COMMIT');
          return 'absent';
        }
        const row = found.rows[0];
        q = decode<PublicFilterQueriedObservation>(row.queried);
        queried(q);
        if (
          row.registration !== copy.registration ||
          q.snapshot.observation !== copy.observation ||
          q.consumer.incarnation !== copy.incarnation
        ) {
          await sql(tx, meter, 'ROLLBACK');
          return 'mismatch';
        }
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
             WHERE (partition_no,registration,build,generation)=($1,$2,$3,$4)`,
            [copy.partition, copy.registration, q.snapshot.build, q.snapshot.generation.toString()],
          );
        }
        await sql(tx, meter, 'COMMIT');
        return 'found';
      } catch (error) {
        await sql(tx, meter, 'ROLLBACK');
        throw error;
      }
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
      await sql(
        pool,
        meter,
        `UPDATE search.public_filter_prepared SET rows=$5
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
  home(target.partition);
  text(target.physicalTarget);
  const meter = cost();
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
      `WITH candidate AS (SELECT partition_no,registration,build,generation
        FROM search.public_filter_prepared WHERE (partition_no,registration)=($1,$2)
          AND (state<>'erasing' OR rows<>$3) ORDER BY build,generation LIMIT 1 FOR UPDATE)
       UPDATE search.public_filter_prepared p SET state='erasing',rows=$3 FROM candidate c
       WHERE (p.partition_no,p.registration,p.build,p.generation)=
             (c.partition_no,c.registration,c.build,c.generation) RETURNING p.build`,
      [target.partition, row.id, encode([])],
    );
    return { state: 'more', after: prepared.rowCount ? target.after : row.id, cost: meter };
  } catch (error) {
    if (error instanceof TypeError) throw error;
    return { state: 'pending', after: target.after, reason: 'native-ambiguous', cost: meter };
  }
}

/** Publication adopts existing immutable custody; it never creates observation readiness.
 * The source home and physical consumer indexes bound both lookups to one native record.
 */
export async function readGenerationPublicationCustody(
  pool: Pool,
  consumer: PublicFilterConsumer,
  sourceHome: number | undefined,
  context: PublicFilterConsumerContext,
  observation?: string,
): Promise<
  | Readonly<{
      definition: CustodyRetainedDefinition;
      registration: CustodyRegistration;
      queried: PublicFilterQueriedObservation | null;
      cost: CustodyCost;
    }>
  | CustodyFailure
> {
  const meter = cost();
  try {
    check(context);
    if (sourceHome !== undefined) home(sourceHome);
    const registered = await sql(
      pool,
      meter,
      `SELECT r.partition_no,r.id,r.definition FROM search.public_filter_registration r
       JOIN search.public_filter_target t USING(partition_no,physical_target)
       WHERE ($1::integer IS NULL OR r.partition_no=$1) AND r.physical_target=$2 AND md5(r.consumer)=md5($3) AND r.consumer=$3 AND r.state='active'
       AND t.incarnation=$4 LIMIT 2`,
      [sourceHome, consumer.physicalTarget, encode(consumer), consumer.incarnation],
    );
    const row = registered.rows[0];
    if (!row || registered.rows.length !== 1) throw new Failure('definition_missing');
    sourceHome = row.partition_no as number;
    const definition = decode<{ digest: string; data: CustodyRetainedDefinition }>(row.definition);
    requireValue(definition.digest === digest(definition.data));
    const found =
      observation === undefined
        ? await sql(
            pool,
            meter,
            `SELECT queried FROM search.public_filter_observation WHERE partition_no=$1 AND registration=$2
         AND state='open' ORDER BY observation DESC LIMIT 1`,
            [sourceHome, row.id],
          )
        : await sql(
            pool,
            meter,
            `SELECT queried FROM search.public_filter_observation WHERE partition_no=$1 AND registration=$2
         AND observation=$3 AND state='open'`,
            [sourceHome, row.id, observation],
          );
    const registration = { partition: row.partition_no as number, id: row.id as string };
    if (!found.rows[0]) return { definition: definition.data, registration, queried: null, cost: meter };
    const q = decode<PublicFilterQueriedObservation>(found.rows[0].queried);
    requireValue(encode(q.consumer) === encode(consumer));
    const native = await read(pool, { queried: q }, context, meter);
    return { definition: native.definition, registration, queried: native.queried, cost: meter };
  } catch (error) {
    return failure(error, meter);
  }
}

/** Native keyed custody probe used by the SAME writer gate after copy admission is fenced.
 * Erasing markers alone are insufficient: the independent prepared payload must actually be empty.
 */
export async function hasRetainedWriterPublicationCopies(
  tx: Pick<import('pg').PoolClient, 'query'>,
  partition: number,
  physicalTarget: string,
): Promise<boolean> {
  const retained = await tx.query(
    `SELECT 1 FROM search.public_filter_observation o
    JOIN search.public_filter_registration r ON (r.partition_no,r.id)=(o.partition_no,o.registration)
    WHERE r.partition_no=$1 AND r.physical_target=$2
    UNION ALL
    SELECT 1 FROM search.public_filter_prepared p
    JOIN search.public_filter_registration r ON (r.partition_no,r.id)=(p.partition_no,p.registration)
    WHERE r.partition_no=$1 AND r.physical_target=$2 AND (p.state<>'erasing' OR p.rows<>$3)
    LIMIT 1`,
    [partition, physicalTarget, encode([])],
  );
  return retained.rowCount !== 0;
}
