import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { isDeepStrictEqual } from 'node:util';
import { readSearchWriterPhysicalTarget } from './identity-epoch-participant-physical.ts';
import { verifySearchRepairWriterReceipt, validateSearchRepairWriterEvidence, type SearchRepairWriterReceipt } from './writer-guard.ts';
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
const repairStateSql = readFileSync(new URL('./public-filter-custody-repair-state.sql', import.meta.url), 'utf8');
const repairPagesSql = readFileSync(new URL('./public-filter-custody-repair-pages.sql', import.meta.url), 'utf8');
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
    error instanceof Failure
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
async function sql(db: Pool | PoolClient, meter: Meter, query: string, values: unknown[] = []): Promise<QueryResult> {
  meter.statements++;
  meter.inputKeys += values.length;
  meter.bytes += Buffer.byteLength(query) + Buffer.byteLength(encode(values));
  const result = await db.query(query, values);
  meter.rows += result.rowCount ?? 0;
  meter.bytes += Buffer.byteLength(encode(result.rows));
  if (/\b(INSERT|UPDATE|DELETE)\b/.test(query)) meter.resultWrites += result.rowCount ?? 0;
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
    overflowProperties: filter
      ? [...new Set(filter.leaves.flatMap((leaf) => (leaf.facet === 'statement' ? [leaf.property] : [])))]
      : undefined,
  })) {
    if (Object.hasOwn(input, key)) requireValue(encode(input[key as keyof typeof input]) === encode(derived));
  }
}
async function read(
  pool: Pool,
  request: CustodyRead,
  context: PublicFilterConsumerContext,
  meter: Meter,
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
    await requireReleaseAuthority(pool, meter, definition.data.meaning.digest);
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

/**
 * Native command-boundary guard over the durable execution and its actual engine effects.
 * Source must separately verify its own retained window/receipts; this never advances a Source ACK.
 */
export async function readPublicFilterRepairSettlement(
  pool: Pool,
  request: Readonly<{ queried: PublicFilterQueriedObservation; execution: string }>,
  context: PublicFilterConsumerContext,
): Promise<PublicFilterRepairSettlementResult> {
  const meter: Meter = cost();
  const input = structuredClone(request);
  try {
    check(context);
    queried(input.queried);
    text(input.execution);
    const url = process.env.OPENSEARCH_URL;
    if (!url) throw new Failure('owner_unavailable');
    const transport = createOpenSearch(url);
    const admit = () => {
      check(context);
      // The existing consumer allowance also covers settlement; no free verification phase.
      if (meter.inputKeys > 1000 || meter.bytes > 4 * 1024 * 1024 ||
        meter.rows > 64 + 16 * Math.max(meter.candidates, 1) ||
        meter.accessPoints + meter.dependencyPoints > 16 + 8 * Math.max(meter.candidates, 1))
        throw new Failure('owner_unavailable');
    };
    const search: OpenSearch = { async request(method, path, body, options) {
      admit();
      meter.engineRequests++;
      meter.bytes += Buffer.byteLength(path) + Buffer.byteLength(encode(body));
      const result = await transport.request(method, path, body, { ...options,
        timeoutMs: Math.max(1, context.deadline - Date.now()) });
      meter.bytes += Buffer.byteLength(encode(result.body));
      if (path.endsWith('/_search')) {
        meter.engineSearches++;
        const shards = (result.body as { _shards?: { total?: number } })._shards?.total;
        if (Number.isSafeInteger(shards) && shards! > 0) meter.engineIteratorSteps += shards!;
      }
      admit();
      return result as never;
    }, bulk() { throw new TypeError('Settlement reader never dispatches writes'); } };
    return await withConnection(pool, async (client) => {
      const query = async (statement: string, values: unknown[] = []) => {
        admit();
        const result = await sql({ query: (text: string, parameters: unknown[]) => {
          const request: import('pg').QueryConfig & { query_timeout: number } = {
            text, values: parameters, query_timeout: Math.max(1, context.deadline - Date.now()),
          };
          return client.query(request);
        } } as Pool, meter, statement, values);
        admit();
        return result;
      };
      const db = { query } as Pool;
      await query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      try {
        const q = input.queried;
        const home = partition(q.snapshot.observation);
        const keys = [home, q.snapshot.observation, input.execution];
        const stateRow = (await query(repairStateSql, keys)).rows[0];
        if (!stateRow?.repair_settlement || !stateRow.consumer_work) throw new Failure('execution_missing');
        const state = decode<RetainedRepairSettlement>(stateRow.repair_settlement);
        const retained = await read(db, input, context, meter);
        if (!retained.execution || !state.closed || state.pages < 1 || state.frontier !== null)
          throw new Failure('owner_unavailable');
        if (!isDeepStrictEqual(state.execution, retained.execution) ||
          !isDeepStrictEqual(state.covered, retained.covered) || state.bootstrap !== retained.covered.observation ||
          stateRow.consumer_bootstrap !== state.bootstrap) throw new Failure('binding_mismatch');
        const work = decode<{ bootstrap: { id: string; covered: unknown }; execution: string;
          queried: PublicFilterQueriedObservation; repairPage: unknown; records: unknown[];
          projectionSource: unknown; repair: unknown; dispatch: unknown }>(stateRow.consumer_work);
        if (work.bootstrap.id !== state.bootstrap || !isDeepStrictEqual(work.bootstrap.covered, retained.covered) ||
          !isDeepStrictEqual(work.queried, q) || work.execution !== input.execution)
          throw new Failure('binding_mismatch');
        if (work.repairPage || work.records.length || work.projectionSource || work.repair || work.dispatch)
          throw new Failure('owner_unavailable');
        // Hold native registration/physical binding as well as the execution until the final boundary.
        const registration = (await query(`SELECT consumer FROM search.public_filter_registration
          WHERE (partition_no,id)=($1,$2) AND state='active' FOR SHARE`, [home, stateRow.registration])).rows[0];
        if (!registration || !isDeepStrictEqual(decode(registration.consumer), q.consumer))
          throw new Failure('binding_mismatch');
        const custodyOwner = (await query(`SELECT epoch,write_state FROM core.partition
          WHERE partition_no=$1`, [home])).rows[0];
        if (custodyOwner?.write_state !== 'active') throw new Failure('owner_unavailable');
        const target = (await query(`SELECT incarnation FROM search.public_filter_target
          WHERE partition_no=$1 AND physical_target=$2 FOR SHARE`, [home, q.consumer.physicalTarget])).rows[0];
        if (target?.incarnation !== q.consumer.incarnation) throw new Failure('binding_mismatch');
        const definition = retained.definition;
        // Recheck native Source registration and immutable definition only; Source business settlement stays FAA-owned.
        const source = (await query(`SELECT source_id::text,configuration::text,owner_epoch FROM semantic.public_filter_source
          WHERE partition_no=$1 AND source_id=$2 FOR SHARE`, [definition.source.partition, definition.source.id])).rows[0];
        if (!source || source.configuration !== definition.source.configuration || source.owner_epoch !== definition.source.epoch)
          throw new Failure('configuration_changed');
        const owner = (await query(`SELECT epoch,write_state FROM core.partition WHERE partition_no=$1`,
          [definition.source.partition])).rows[0];
        if (owner?.epoch !== definition.source.epoch || owner.write_state !== 'active') throw new Failure('owner_unavailable');
        const readDefinition = (await query(`SELECT source_id::text,configuration::text,release_digest,subject_type,capture,dependency_keys
          FROM semantic.public_filter_read_definition WHERE partition_no=$1 AND read_definition=$2 FOR SHARE`,
          [definition.source.partition, definition.readDefinition])).rows[0];
        if (!readDefinition || readDefinition.source_id !== definition.source.id ||
          readDefinition.configuration !== definition.source.configuration ||
          readDefinition.release_digest !== definition.meaning.digest || readDefinition.subject_type !== definition.meaning.type ||
          !isDeepStrictEqual(decode(readDefinition.capture), definition.capture) ||
          !isDeepStrictEqual(readDefinition.dependency_keys, definition.dependencyKeys)) throw new Failure('definition_missing');
        if (!/^0:[0-9a-f-]{36}$/.test(state.bootstrap)) throw new Failure('binding_mismatch');
        const bootstrap = (await query(`SELECT read_definition::text,consumer,snapshot_kind,owner_epoch,state,queried
          FROM semantic.public_filter_bootstrap WHERE partition_no=0 AND bootstrap=$1 FOR SHARE`,
          [state.bootstrap.slice(2)])).rows[0];
        if (!bootstrap || bootstrap.read_definition !== definition.readDefinition ||
          bootstrap.owner_epoch !== definition.source.epoch || bootstrap.state !== 'adopted' ||
          bootstrap.queried !== q.snapshot.observation || bootstrap.snapshot_kind !== q.snapshot.kind ||
          !isDeepStrictEqual(decode(bootstrap.consumer), q.consumer)) throw new Failure('binding_mismatch');
        const last = (await query(`SELECT intent FROM search.public_filter_repair_page
          WHERE (partition_no,observation,execution,ordinal)=($1,$2,$3,$4)`, [...keys, state.pages - 1])).rows[0];
        if (!last) throw new Failure('owner_unavailable');
        const finalPage = decode<RetainedRepairPage>(last.intent);
        if (!finalPage.complete || finalPage.frontier !== null) throw new Failure('owner_unavailable');
        const pages = (await query(repairPagesSql, keys)).rows;
        if (pages.length > 1000) throw new Failure('owner_unavailable');
        const copies = new Map<string, string>();
        const latest = new Map<string, SearchRepairWriterReceipt>();
        for (const row of pages) {
          if (row.ordinal >= state.pages) throw new Failure('owner_unavailable');
          const page = decode<RetainedRepairPage>(row.intent);
          if (page.repairs.length > 256) throw new Failure('binding_mismatch');
          for (const [item, repair] of page.repairs.entries()) {
            meter.candidates++;
            meter.inputKeys++;
            meter.accessPoints++;
            meter.dependencyPoints++;
            admit();
            if (repair.projection.status !== 'progress' && repair.projection.status !== 'complete')
              throw new Failure('binding_mismatch');
            if (!isDeepStrictEqual(repair.source, repair.projection.source) ||
              repair.source.partition !== subjectPartition(repair.source.subject) ||
              repair.source.subject !== repair.locator.subject) throw new Failure('binding_mismatch');
            const sourceKey = encode(repair.source);
            const prior = copies.get(repair.source.subject);
            if (prior && prior !== sourceKey) throw new Failure('binding_mismatch');
            if (repair.projection.status === 'progress') {
              copies.set(repair.source.subject, sourceKey);
              continue;
            }
            if (repair.projection.status !== 'complete') throw new Failure('binding_mismatch');
            const effect = (await query(`SELECT receipt FROM search.public_filter_repair_effect
              WHERE (partition_no,observation,execution,page,item)=($1,$2,$3,$4,$5)`, [...keys, row.ordinal, item])).rows[0];
            if (!effect) throw new Failure('owner_unavailable');
            const receipt = decode<SearchRepairWriterReceipt>(effect.receipt);
            const locator = encode({ observation: q.snapshot.observation, execution: input.execution, page: row.ordinal, item });
            if (receipt.locator !== locator || receipt.subject !== repair.source.subject ||
              receipt.partition !== repair.source.partition || receipt.epoch !== repair.source.epoch ||
              receipt.action.version < repair.source.position || receipt.incarnation !== q.consumer.incarnation)
              throw new Failure('binding_mismatch');
            validateSearchRepairWriterEvidence(q.consumer.physicalTarget, receipt);
            const previous = latest.get(receipt.subject);
            if (previous && (receipt.action.version < previous.action.version ||
              receipt.enrollment.position <= previous.completion.position)) throw new Failure('binding_mismatch');
            latest.set(receipt.subject, receipt);
            copies.delete(receipt.subject);
          }
        }
        if (copies.size) throw new Failure('owner_unavailable');
        const physical = await readSearchWriterPhysicalTarget(search, q.consumer.physicalTarget);
        if (physical.incarnation !== q.consumer.incarnation) throw new Failure('binding_mismatch');
        // Final writer-key locks include original/terminal rows even when the retained window had no repair effects.
        const own = [...new Set(retained.execution.ownRows.flatMap((row) => [row.original, row.terminal]))].sort();
        for (const original of own) {
          meter.inputKeys++;
          meter.candidates++;
          const partition = subjectPartition(original);
          const current = (await query(`SELECT writer_token,dispatch_state,closed_job,incarnation,owner_epoch
            FROM search.identity_writer WHERE partition_no=$1 AND physical_target=$2 AND original_id=$3 FOR SHARE`,
            [partition, q.consumer.physicalTarget, original])).rows[0];
          const homeOwner = (await query(`SELECT epoch,write_state FROM core.partition WHERE partition_no=$1 FOR SHARE`, [partition])).rows[0];
          if (homeOwner?.write_state !== 'active' || (current && (current.writer_token || current.closed_job ||
            current.dispatch_state !== 'settled' || current.incarnation !== physical.incarnation ||
            current.owner_epoch !== homeOwner.epoch))) throw new Failure('identity_pending');
        }
        for (const receipt of [...latest.values()].sort((a, b) => a.partition - b.partition || a.subject.localeCompare(b.subject)))
          await verifySearchRepairWriterReceipt(db, search, q.consumer.physicalTarget, receipt);
        for (const partition of [...new Set([home, definition.source.partition])].sort((a, b) => a - b)) {
          const finalOwner = (await query(`SELECT epoch,write_state FROM core.partition
            WHERE partition_no=$1 FOR SHARE`, [partition])).rows[0];
          if (finalOwner?.write_state !== 'active' || (partition === definition.source.partition &&
            finalOwner.epoch !== definition.source.epoch)) throw new Failure('owner_unavailable');
        }
        const refreshed = await search.request('POST', `/${q.consumer.physicalTarget}/_refresh`);
        validateRefreshResponse(refreshed.status, refreshed.body);
        if (!isDeepStrictEqual(await readSearchWriterPhysicalTarget(search, q.consumer.physicalTarget), physical))
          throw new Failure('binding_mismatch');
        const final = await read(db, input, context, meter);
        if (!isDeepStrictEqual(final.execution, retained.execution) || !isDeepStrictEqual(final.covered, state.covered))
          throw new Failure('binding_mismatch');
        const transaction = (await query('SELECT txid_current()::text AS id')).rows[0]!.id as string;
        const fenced: RetainedRepairSettlement = { ...state, fence: { transaction,
          incarnation: physical.incarnation, writeAlias: physical.writeAlias,
          sourceEpoch: definition.source.epoch, refresh: refreshed.body } };
        const stored = await query(`UPDATE search.public_filter_execution SET repair_settlement=$4
          WHERE (partition_no,observation,id)=($1,$2,$3) AND repair_settlement=$5 RETURNING id`,
          [...keys, encode(fenced), stateRow.repair_settlement]);
        if (stored.rowCount !== 1) throw new Failure('binding_mismatch');
        admit();
        await query('COMMIT');
        return { status: 'settled', definition: retained.definition, queried: retained.queried,
          execution: retained.execution,
          settlement: Object.freeze({ id: state.id }) as NativePublicFilterRepairSettlement, cost: meter };
      } catch (error) {
        // Rollback must release every held writer/owner lock even after allowance/deadline failure.
        await client.query('ROLLBACK');
        meter.statements++;
        throw error;
      }
    });
  } catch (error) {
    return failure(error, meter);
  }
}

/** No Source authority, ACK, permission or population completion is minted by this storage boundary. */
export function createPublicFilterCustody(pool: Pool): PublicFilterCustody {
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
    return decode<PublicFilterConsumer>(result.rows[0].consumer);
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
            `INSERT INTO search.public_filter_prepared VALUES ($1,$2,$3,$4,$5)
            ON CONFLICT (partition_no,registration,build,generation) DO UPDATE SET build=EXCLUDED.build WHERE public_filter_prepared.rows=EXCLUDED.rows RETURNING build`,
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
        await sql(
          pool,
          meter,
          'DELETE FROM search.public_filter_reference WHERE (partition_no,observation)=($1,$2) AND expires_at<=$3',
          [...values, Date.now()],
        );
        for (;;) {
          const owned = await sql(
            pool,
            meter,
            "SELECT id,locator FROM search.public_filter_pit WHERE (partition_no,observation)=($1,$2) AND state='owned' ORDER BY id LIMIT 32",
            values,
          );
          if (!owned.rowCount) break;
          for (const pit of owned.rows) await deletePit(pit.locator, search, context, meter);
          await sql(
            pool,
            meter,
            "UPDATE search.public_filter_pit SET state='released' WHERE (partition_no,observation)=($1,$2) AND id=ANY($3::text[])",
            [...values, owned.rows.map((row) => row.id)],
          );
        }
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
  try {
    await engine(search, meter, context, 'DELETE', '/_search/point_in_time', { pit_id: [pit] });
  } catch (error) {
    if (!(error instanceof OpenSearchError && error.status === 404)) throw error;
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
    if (!found.rows[0]) return { definition: definition.data, queried: null, cost: meter };
    const q = decode<PublicFilterQueriedObservation>(found.rows[0].queried);
    requireValue(encode(q.consumer) === encode(consumer));
    const native = await read(pool, { queried: q }, context, meter);
    return { definition: native.definition, queried: native.queried, cost: meter };
  } catch (error) {
    return failure(error, meter);
  }
}
