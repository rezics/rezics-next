import { DBOS } from '@dbos-inc/dbos-sdk';
import type { Pool, QueryResult, QueryResultRow } from 'pg';
import { ERASURE_PARTICIPANTS, acknowledgeErasure } from '../access/erasure.ts';
import { readMembershipRouteKey } from '../access/membership-work-config.ts';
import { runCommand } from '../command/command.ts';
import { discardConnection, withConnection, withQueryAccounting } from '../database/pool.ts';
import { withBoundedReadLifetime } from '../database/bounded-read-lifetime.ts';
import type { CloudEvent } from '../events/log.ts';
import { deadlineFor, withRequestDeadline } from '../request/deadline.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import {
  createSubjectErasureSource,
  verifySubjectErasureSourcePage,
  readSubjectErasureSourceProof,
  verifySubjectErasureSourceProof,
} from '../semantic/account-erasure-source.ts';
import type { SubjectErasureSourceRecord, SubjectErasureSource } from '../semantic/account-erasure-source-contract.ts';
import type { PublicFilterConsumer, PublicFilterCost } from '../semantic/index.ts';
import type { NativeStepWork } from '../semantic/identity-epoch-contract.ts';
import type { WorkContext } from '../work/registry.ts';
import { createOpenSearch, OpenSearchError, type OpenSearch } from './opensearch.ts';
import { physicalSubjectGenerationsFromSettings } from './generation-inventory.ts';
import { stepRetainedTargetErasure } from './public-filter-custody.ts';
import type { SearchWriterPublicationGuard, SearchWriterPublicationFence } from './writer-guard.ts';
import { validateRefreshResponse } from './write-actions.ts';
import { eraseDiscoveryAccount, nativeDiscoveryRegistry } from './account-discovery.ts';
import { createRatedSubjectSource } from './rated-source.ts';
import type { DiscoveryRegistry } from './discovery.ts';
import type { PublicFilterSourceFactory } from '../semantic/index.ts';
import { createSearchWriterGuard } from './writer-guard.ts';
import { subjectConsumer } from './runner.ts';
import { subjectListingSource } from '../library/listing-counts.ts';
import { type HistoryBarrier } from '../history/contract/index.ts';
import type { SearchNativePorts } from './native-ports.ts';

const eventType = 'com.rezics.access.account-tombstoned.v1';
const workflowName = 'search.erasure';
export type SearchErasurePendingReason =
  | 'source-unavailable'
  | 'configuration-unavailable'
  | 'population-unknown'
  | 'writer-unavailable'
  | 'native-ambiguous'
  | 'copies-pending'
  | 'personal-pending'
  | 'source-changed';
export type SearchErasureProgress = Readonly<{
  state: 'more' | 'pending' | 'complete';
  obligation: HistoryBarrier;
  phase: 'sealing' | 'source' | 'copies' | 'repair' | 'drain' | 'finalize' | 'done';
  reason?: SearchErasurePendingReason;
  work: NativeStepWork;
  cost: PublicFilterCost;
}>;
export type SearchErasureContext = Readonly<{ deadline: number }>;
/** Trusted native composition, never workflow arguments or a callback Boolean certificate. */
export type SearchErasureRuntime = Readonly<{
  search?: OpenSearch;
  prefix?: string;
  source?: SubjectErasureSource | undefined;
  accountRegistry?: (context?: SearchErasureContext) => Promise<DiscoveryRegistry>;
  writerGuard?: (
    consumer: PublicFilterConsumer,
    context?: SearchErasureContext & Readonly<{ search: OpenSearch }>,
  ) => SearchWriterPublicationGuard | undefined;
}>;
type Header = {
  version: number;
  at: string;
  frontier: string | null;
  source_complete: boolean;
  personal_complete: boolean;
  ever_applied: boolean;
  phase: SearchErasureProgress['phase'];
  revision: string;
};
type Target = PublicFilterConsumer & { revision: string; complete: boolean };
type Effect = {
  job: string;
  record_key: string | null;
  source_basis: string;
  native_revision: string;
  key_offset: number;
  fence: string | null;
  phase: string;
};
const bytes = (value: unknown) =>
  Buffer.byteLength(JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v)) ?? '');
function emptyCost(): { -readonly [K in keyof PublicFilterCost]: number } {
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
function addCost(total: ReturnType<typeof emptyCost>, cost: PublicFilterCost) {
  for (const key of Object.keys(total) as (keyof PublicFilterCost)[]) total[key] += cost[key];
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
type ErasureWork = { -readonly [K in keyof NativeStepWork]: NativeStepWork[K] };
type ErasureTurn = Readonly<{
  context: SearchErasureContext;
  signal: AbortSignal;
  check(): void;
}>;
class SearchErasureDeadlineError extends Error {
  constructor() {
    super('Search erasure deadline expired');
    this.name = 'SearchErasureDeadlineError';
  }
}

async function withErasureTurn<T>(
  input: SearchErasureContext | undefined,
  run: (turn: ErasureTurn) => Promise<T>,
): Promise<T> {
  const now = Date.now();
  if (input && !Number.isFinite(input.deadline)) throw new TypeError('Invalid Search erasure deadline');
  const context = Object.freeze({
    deadline: Math.min(now + 5000, deadlineFor(5000, () => now), input?.deadline ?? Infinity),
  });
  if (!Number.isFinite(context.deadline)) throw new TypeError('Invalid Search erasure deadline');
  const controller = new AbortController();
  const check = () => {
    if (controller.signal.aborted || Date.now() >= context.deadline) throw new SearchErasureDeadlineError();
  };
  check();
  let timer: ReturnType<typeof setTimeout>;
  const expire = () => {
    const remaining = context.deadline - Date.now();
    if (remaining > 0) timer = setTimeout(expire, Math.ceil(remaining));
    else controller.abort(new SearchErasureDeadlineError());
  };
  timer = setTimeout(expire, Math.ceil(context.deadline - Date.now()));
  try {
    // Native producers retain physical cancellation custody. Keep their original scope until settlement.
    return await withRequestDeadline(context.deadline, () => run({ context, signal: controller.signal, check }));
  } finally {
    clearTimeout(timer);
    controller.abort(new SearchErasureDeadlineError());
  }
}

/** The raw Pool retains checkout/release ownership, including a checkout arriving after expiry. */
function erasureQuery<T extends QueryResultRow>(
  pool: Pool,
  turn: ErasureTurn,
  sql: string,
  values: unknown[] = [],
): Promise<QueryResult<T>> {
  turn.check();
  let unfinished = false;
  return withBoundedReadLifetime(
    (bounded) =>
      withConnection(pool, async (raw) => {
        try {
          return await bounded(raw);
        } finally {
          if (unfinished) discardConnection(raw, new SearchErasureDeadlineError());
        }
      }),
    discardConnection,
    turn.context.deadline,
    async (tx) => {
      try {
        unfinished = true;
        await tx.query('BEGIN');
        turn.check();
        await tx.query("SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$1,true)", [
          `${Math.max(1, Math.floor(turn.context.deadline - Date.now()))}ms`,
        ]);
        turn.check();
        const result = await tx.query<T>(sql, values);
        turn.check();
        await tx.query('COMMIT');
        unfinished = false;
        turn.check();
        return result;
      } catch (error) {
        // Cleanup uses the original deadline. A retired or uncertain client refuses further SQL.
        if (unfinished && Date.now() < turn.context.deadline) {
          try {
            await tx.query('ROLLBACK');
            unfinished = false;
          } catch {
            // The checkout owner discards any transaction whose completion is uncertain.
          }
        }
        throw error;
      }
    },
    { deadlineError: () => new SearchErasureDeadlineError(), isUncertainSettledQueryError: () => true },
  );
}

function erasureSearch(search: OpenSearch, turn: ErasureTurn, work: ErasureWork): OpenSearch {
  async function send<T>(
    input: unknown,
    options: { timeoutMs?: number; signal?: AbortSignal } | undefined,
    dispatch: (options: { timeoutMs: number; signal: AbortSignal }) => Promise<T>,
  ): Promise<T> {
    turn.check();
    const signal = options?.signal ? AbortSignal.any([turn.signal, options.signal]) : turn.signal;
    if (signal.aborted) throw signal.reason;
    const timeoutMs = Math.min(options?.timeoutMs ?? Infinity, turn.context.deadline - Date.now());
    work.engineRequests++;
    work.bytes += bytes(input);
    // Await native cancellation/settlement; a detached timeout cannot certify physical absence.
    try {
      const result = await dispatch({ timeoutMs: Math.max(1, timeoutMs), signal });
      work.bytes += bytes(result);
      turn.check();
      if (signal.aborted) throw signal.reason;
      return result;
    } catch (error) {
      if (error instanceof OpenSearchError) work.bytes += bytes(error.body);
      throw error;
    }
  }
  const bounded: OpenSearch = {
    request<T = unknown>(...args: Parameters<OpenSearch['request']>) {
      const [method, path, body, options] = args;
      return send([path, body, options?.query], options, (limits) =>
        search.request<T>(method, path, body, { ...options, ...limits }),
      );
    },
    bulk<T = unknown>(...args: Parameters<OpenSearch['bulk']>) {
      const [lines, options] = args;
      return send([lines, options?.query], options, (limits) => search.bulk<T>(lines, { ...options, ...limits }));
    },
  };
  if (search.bulkRaw) {
    bounded.bulkRaw = <T = unknown>(...args: Parameters<NonNullable<OpenSearch['bulkRaw']>>) => {
      const [body, options] = args;
      return send([body, options?.query], options, (limits) => search.bulkRaw!<T>(body, { ...options, ...limits }));
    };
  }
  return bounded;
}
/** A native envelope is a wakeup, never inventory, a receipt, or completion authority. */
export function searchErasureAccount(event: CloudEvent): string {
  const data = event.data;
  if (event.type !== eventType || data === null || typeof data !== 'object' || !('accountId' in data))
    throw new TypeError('Invalid Search erasure event');
  const accountId = data.accountId;
  const route = typeof accountId === 'string' ? routeOf(accountId) : null;
  if (
    typeof accountId !== 'string' ||
    route === null ||
    event.subject !== accountId ||
    event.specversion !== '1.0' ||
    event.datacontenttype !== 'application/json' ||
    routeOf(event.id) === null ||
    !new RegExp(`^urn:rezics:log:${partitionOf(route)}\\.[1-9][0-9]*$`).test(event.source) ||
    !/^[0-9]{19}$/.test(event.sequence) ||
    BigInt(event.sequence) === 0n ||
    !Number.isFinite(Date.parse(event.time))
  )
    throw new TypeError('Invalid Search erasure envelope');
  return accountId;
}

/** Bounded native work. A Source page is redelivered until every exact physical effect settles;
 * its opaque receipt is passed unchanged to the producer's verifier inside the real receiving command.
 */
export async function stepSearchErasure(
  pool: Pool,
  accountId: string,
  configured: boolean | SearchErasureRuntime,
  context?: SearchErasureContext,
): Promise<SearchErasureProgress> {
  return withErasureTurn(context, (turn) => stepSearchErasureTurn(pool, accountId, configured, turn));
}

function stepSearchErasureTurn(
  pool: Pool,
  accountId: string,
  configured: boolean | SearchErasureRuntime,
  turn: ErasureTurn,
): Promise<SearchErasureProgress> {
  const work: ErasureWork = { rows: 0, points: 0, statements: 0, bytes: 0, engineRequests: 0 };
  // Observe native SQL without substituting a Pool or taking another owner's cleanup custody.
  return withQueryAccounting(
    {
      async query(sql, operands, dispatch) {
        work.statements++;
        work.bytes += bytes([sql, operands]);
        const result = await dispatch();
        for (const reply of Array.isArray(result) ? result : [result]) {
          if (!object(reply) || !Array.isArray(reply.rows)) continue;
          work.rows += typeof reply.rowCount === 'number' ? reply.rowCount : 0;
          work.bytes += bytes(reply.rows);
        }
        return result;
      },
      connection: (dispatch) => dispatch(),
    },
    () => advanceSearchErasure(pool, accountId, configured, turn, work),
  );
}

async function advanceSearchErasure(
  pool: Pool,
  accountId: string,
  configured: boolean | SearchErasureRuntime,
  turn: ErasureTurn,
  work: ErasureWork,
): Promise<SearchErasureProgress> {
  const runtime: SearchErasureRuntime = typeof configured === 'boolean' ? {} : configured;
  const { context } = turn;
  const search = runtime.search ? erasureSearch(runtime.search, turn, work) : undefined;
  const route = routeOf(accountId);
  if (route === null) throw new TypeError('Invalid Search erasure account');
  const home = partitionOf(route),
    keys = [home, accountId];
  const cost = emptyCost();
  const query = <T extends QueryResultRow>(sql: string, values: unknown[] = []) =>
    erasureQuery<T>(pool, turn, sql, values);
  async function receive<T extends { cost: PublicFilterCost }>(read: () => Promise<T>): Promise<T> {
    turn.check();
    const result = await read();
    addCost(cost, result.cost);
    turn.check();
    return result;
  }
  const root = await query<{ version: number; at: string }>(
    'SELECT version,at::text FROM access.erasure WHERE route=$1 AND account_id=$2',
    [route, accountId],
  );
  const obligation = root.rows[0];
  if (!obligation || obligation.version !== 1 || !ERASURE_PARTICIPANTS[1].includes('search'))
    throw new TypeError('Missing supported Search erasure obligation');
  const barrier: HistoryBarrier = { accountId, accountRoute: route, version: obligation.version, at: obligation.at };
  await query(
    `INSERT INTO search.erasure_progress(partition_no,account_id,version,at,protocol,phase)
    VALUES($1,$2,$3,$4,1,'sealing') ON CONFLICT DO NOTHING`,
    [...keys, barrier.version, barrier.at],
  );
  const header = (
    await query<Header>(
      `SELECT version,at::text,frontier,source_complete,personal_complete,
    ever_applied,phase,revision::text FROM search.erasure_progress WHERE (partition_no,account_id)=($1,$2)`,
      keys,
    )
  ).rows[0];
  if (!header || header.version !== barrier.version || header.at !== barrier.at)
    throw new TypeError('Conflicting Search erasure obligation');
  const progress = (
    state: SearchErasureProgress['state'],
    phase: SearchErasureProgress['phase'],
    reason?: SearchErasurePendingReason,
  ): SearchErasureProgress => {
    if (Date.now() >= context.deadline) {
      return { state: 'pending', phase: header.phase, reason: 'native-ambiguous', obligation: barrier, work, cost };
    }
    return { state, phase, ...(reason ? { reason } : {}), obligation: barrier, work, cost };
  };
  async function pending(reason: SearchErasurePendingReason, phase: SearchErasureProgress['phase']) {
    if (Date.now() >= context.deadline) return progress('pending', phase, reason);
    try {
      await query(
        `UPDATE search.erasure_progress SET pending_reason=$3,phase=$4
      WHERE (partition_no,account_id)=($1,$2) AND phase<>'done'`,
        [...keys, reason, phase],
      );
    } catch (error) {
      if (Date.now() < context.deadline) throw error;
    }
    return progress('pending', phase, reason);
  }
  try {
    // Independently enumerate retained custody before optional configuration or owner availability.
    // Existing target homes are the native directory; no Subject/history payload scans are involved.
    const copy = (
      await query<{
        partition_no: number;
        physical_target: string;
        incarnation: string;
        copy_revision: string;
        registration_after: string | null;
      }>(
        `SELECT t.partition_no,t.physical_target,t.incarnation,t.copy_revision::text,
       CASE WHEN e.copy_revision=t.copy_revision THEN e.registration_after END AS registration_after
      FROM search.public_filter_target t LEFT JOIN search.erasure_target e
        ON e.partition_no=$1 AND e.account_id=$2 AND e.copy_home=t.partition_no
        AND e.physical_target=t.physical_target AND e.incarnation=t.incarnation
      WHERE e.copies_complete IS DISTINCT FROM true OR e.copy_revision<>t.copy_revision
      ORDER BY t.partition_no,t.physical_target LIMIT 1`,
        keys,
      )
    ).rows[0];
    if (copy) {
      const cleaned = await receive(() =>
        stepRetainedTargetErasure(
          pool,
          {
            partition: copy.partition_no,
            physicalTarget: copy.physical_target,
            after: copy.registration_after,
          },
          search,
          context,
        ),
      );
      await query(
        `INSERT INTO search.erasure_target(partition_no,account_id,copy_home,physical_target,
        incarnation,copy_revision,registration_after,copies_complete) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT(partition_no,account_id,copy_home,physical_target,incarnation) DO UPDATE SET
        copy_revision=EXCLUDED.copy_revision,registration_after=EXCLUDED.registration_after,
        copies_complete=EXCLUDED.copies_complete`,
        [
          ...keys,
          copy.partition_no,
          copy.physical_target,
          copy.incarnation,
          copy.copy_revision,
          cleaned.after,
          cleaned.state === 'complete',
        ],
      );
      if (cleaned.state === 'pending')
        return pending(
          cleaned.reason === 'configuration-unavailable' ? 'configuration-unavailable' : 'copies-pending',
          'copies',
        );
      return progress('more', 'copies');
    }
    // Terminal Source custody is a separate all-home native chain. Advance it even when
    // Search is disabled; no configuration, local EOF or page receipt supplies this proof.
    turn.check();
    const sourceProof = await readSubjectErasureSourceProof({ pool }, barrier, context);
    turn.check();
    if (!sourceProof) return pending('source-unavailable', 'source');
    if (!search || !runtime.prefix) return pending('configuration-unavailable', 'sealing');
    const accountCopy = await query(
      `SELECT 1 FROM search.discovery_copy WHERE route=$1 AND source_id=$2
      AND kind='account' LIMIT 1`,
      [route, accountId],
    );
    if (accountCopy.rowCount) {
      if (!runtime.accountRegistry) return pending('copies-pending', 'copies');
      // Reuse the Account owner's native per-key guard/purge and Access late-item receiving protocol.
      // The original ambient deadline reaches owners whose existing API has no context argument.
      // They must settle their own SQL custody; racing them would leave physical work detached.
      turn.check();
      const registry = await runtime.accountRegistry(context);
      turn.check();
      await eraseDiscoveryAccount(pool, search, registry, accountId, 1);
      turn.check();
      await query(`UPDATE search.erasure_progress SET ever_applied=true WHERE (partition_no,account_id)=($1,$2)`, keys);
      return progress('more', 'copies');
    }
    const source = runtime.source;
    if (!source) return pending('source-unavailable', 'source');
    if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(runtime.prefix)) throw new TypeError('Invalid Search erasure prefix');
    const targets = await population();
    if (!targets) return pending('population-unknown', 'sealing');
    const page = await receive(() => source.readPage({ barrier, frontier: header.frontier, inputLimit: 100, context }));
    if (page.status !== 'progress' && page.status !== 'complete') return pending('source-unavailable', 'source');
    if (
      page.records.length > 1 ||
      (page.frontier !== null && (Buffer.byteLength(page.frontier) > 2048 || page.frontier === header.frontier))
    )
      throw new TypeError('Invalid bounded Subject erasure page');
    const record = page.records[0];
    if (
      record &&
      (record.disposition === 'pending' ||
        ((record.disposition === 'replace' || record.disposition === 'retain_deidentified') && !record.source))
    )
      return pending('source-changed', 'source');
    // Verification transfers the producer's page custody. Defer that transfer until every
    // effect settles, so its native unconsumed page remains replayable after interruption.
    // Physical repair reads fresh Source through the ordinary writer; it never treats a null
    // projection, record disposition or opaque receipt as deletion/absence authority.
    const recordKey = record?.key ?? '';
    if (Buffer.byteLength(recordKey) > 4096) throw new TypeError('Invalid Subject erasure record key');
    const sourceBasis = JSON.stringify(
      [
        recordKey,
        record?.original,
        record?.previousTerminal,
        record?.currentTerminal,
        record?.disposition,
        record?.source,
      ],
      (_, value) => (typeof value === 'bigint' ? value.toString() : value),
    );
    if (Buffer.byteLength(sourceBasis) > 4096) throw new TypeError('Unbounded Source erasure basis');
    for (const target of targets) {
      const effect =
        (
          await query<Effect>(
            `INSERT INTO search.erasure_effect(partition_no,account_id,
        physical_target,incarnation,record_key,source_basis,native_revision,consumer,barrier) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT(partition_no,account_id,physical_target,incarnation) DO UPDATE SET
        record_key=EXCLUDED.record_key,source_basis=EXCLUDED.source_basis,native_revision=EXCLUDED.native_revision,
        key_offset=0,phase='repair',fence=NULL
        WHERE erasure_effect.phase='released' AND (erasure_effect.source_basis<>EXCLUDED.source_basis
          OR erasure_effect.native_revision<>EXCLUDED.native_revision)
        RETURNING job::text,record_key,source_basis,native_revision,key_offset,fence,phase`,
            [
              0,
              accountId,
              target.physicalTarget,
              target.incarnation,
              recordKey,
              sourceBasis,
              target.revision,
              {
                physicalTarget: target.physicalTarget,
                incarnation: target.incarnation,
                consumerGeneration: target.consumerGeneration,
                projectionGeneration: target.projectionGeneration,
                meaningDigest: target.meaningDigest,
                readDefinition: target.readDefinition,
              },
              barrier,
            ],
          )
        ).rows[0] ??
        (
          await query<Effect>(
            `SELECT job::text,record_key,source_basis,native_revision,key_offset,fence,phase FROM search.erasure_effect
          WHERE (partition_no,account_id,physical_target,incarnation)=($1,$2,$3,$4)`,
            [0, accountId, target.physicalTarget, target.incarnation],
          )
        ).rows[0];
      if (!effect) return pending('source-changed', 'repair');
      if (
        effect.phase === 'released' &&
        effect.source_basis === sourceBasis &&
        effect.native_revision === target.revision
      )
        continue;
      const consumer: PublicFilterConsumer = {
        physicalTarget: target.physicalTarget,
        incarnation: target.incarnation,
        consumerGeneration: target.consumerGeneration,
        projectionGeneration: target.projectionGeneration,
        meaningDigest: target.meaningDigest,
        readDefinition: target.readDefinition,
      };
      turn.check();
      const guard = runtime.writerGuard?.(consumer, { ...context, search });
      if (!guard) return pending('writer-unavailable', 'repair');
      const native = { consumer, job: effect.job };
      const binding = [
        0,
        accountId,
        target.physicalTarget,
        target.incarnation,
        effect.job,
        effect.phase,
        effect.key_offset,
        effect.source_basis,
      ];
      const update = (assign: string, values: unknown[] = []) =>
        query(
          `UPDATE search.erasure_effect SET ${assign} WHERE
         (partition_no,account_id,physical_target,incarnation,job)=($1,$2,$3,$4,$5)
         AND phase=$6 AND key_offset=$7 AND source_basis=$8`,
          [...binding, ...values],
        );
      if (effect.source_basis !== sourceBasis || effect.native_revision !== target.revision) {
        if (effect.fence) {
          const old: SearchWriterPublicationFence = { ...native, fence: effect.fence };
          const drained = await receive(() => guard.drainPublication(old, context));
          if (drained.status !== 'drained') return progress('pending', 'drain', 'source-changed');
          const released = await receive(() => guard.releasePublication(old, context));
          if (released.status !== 'released') return pending('writer-unavailable', 'drain');
        }
        await update("phase='repair',record_key=$9,source_basis=$10,native_revision=$11,key_offset=0,fence=NULL", [
          recordKey,
          sourceBasis,
          target.revision,
        ]);
        return progress('more', 'repair');
      }
      if (effect.phase === 'repair') {
        const ids = affected(record);
        const id = ids[effect.key_offset];
        if (id) {
          const idRoute = routeOf(id);
          if (idRoute === null) throw new TypeError('Invalid Source erasure locator');
          // This is the ordinary native guard. It obtains fresh actual Source versions; privacy
          // positions and the Access erasure root are never used as external engine versions.
          turn.check();
          await guard.write(partitionOf(idRoute), [id], 0n);
          turn.check();
          await update('key_offset=key_offset+1');
        } else await update("phase='fence'");
        return progress('more', 'repair');
      }
      if (effect.phase === 'fence') {
        const result = await receive(() => guard.fencePublication(native, context));
        if (result.status !== 'fenced') return pending('writer-unavailable', 'drain');
        await update("phase='drain',fence=$9", [result.fence.fence]);
        return progress('more', 'drain');
      }
      if (!effect.fence) return pending('native-ambiguous', 'drain');
      const fence: SearchWriterPublicationFence = { ...native, fence: effect.fence };
      if (effect.phase === 'drain') {
        const result = await receive(() => guard.drainPublication(fence, context));
        if (result.status === 'drained') await update("phase='adopt'");
        else if (result.status !== 'draining') return pending('writer-unavailable', 'drain');
        return progress('more', 'drain');
      }
      if (effect.phase === 'adopt' || effect.phase === 'compact') {
        // Adoption resolves the locator to current native gate/drain/copy custody each time.
        const result = await receive(() => guard.adoptPublication(fence, context));
        if (result.status !== 'held') return pending('writer-unavailable', 'drain');
        await update("phase='compact'");
        const merge = await engine('POST', `/${target.physicalTarget}/_forcemerge`, undefined, {
          only_expunge_deletes: true,
        });
        validateRefreshResponse(merge.status, merge.body);
        const clear = await engine('POST', `/${target.physicalTarget}/_cache/clear`);
        validateRefreshResponse(clear.status, clear.body);
        if (!(await exact(target))) return pending('population-unknown', 'drain');
        await update("phase='settled'");
        return progress('more', 'drain');
      }
      if (effect.phase === 'settled') {
        const released = await receive(() => guard.releasePublication(fence, context));
        if (released.status !== 'released') return pending('writer-unavailable', 'drain');
        await update("phase='released',fence=NULL");
        return progress('more', 'drain');
      }
      throw new TypeError('Invalid native erasure effect phase');
    }
    // The producer validates its native barrier again after effects. A changed source never advances
    // the raw frontier, and no page receipt/record body is stored in DBOS history or Search SQL.
    turn.check();
    const advanced = await runCommand(pool, { partition: home, deadline: context.deadline }, async (tx) => {
      turn.check();
      if (!(await verifySubjectErasureSourcePage(tx, barrier, page.receipt))) return { value: false, events: [] };
      turn.check();
      const updated = await tx.query(
        `UPDATE search.erasure_progress SET frontier=$4,source_complete=$5,
        ever_applied=ever_applied OR $6,revision=revision+1,phase=$7,pending_reason=NULL
        WHERE (partition_no,account_id)=($1,$2) AND revision=$3`,
        [
          ...keys,
          header.revision,
          page.status === 'complete' ? page.receipt.id : page.frontier,
          page.status === 'complete',
          !!record,
          page.status === 'complete' ? 'finalize' : 'source',
        ],
      );
      turn.check();
      return { value: updated.rowCount === 1, events: [] };
    });
    turn.check();
    if (!advanced.value) return pending('source-changed', 'source');
    if (page.status !== 'complete') return progress('more', 'source');
    if (!header.personal_complete) return pending('personal-pending', 'finalize');
    // The Account discovery owner has separate native late-item/physical cleanup. Its current witness
    // is not Subject role coverage. Every located Account generation must have completed its own purge.
    const accountCopies = await query(
      `SELECT 1 FROM search.discovery_copy WHERE route=$1 AND source_id=$2
      AND kind='account' LIMIT 1`,
      [route, accountId],
    );
    if (accountCopies.rowCount) return pending('copies-pending', 'finalize');
    // Check native copy admission once more after Source validation and every release.
    const dirty = await query(
      `SELECT 1 FROM search.public_filter_target t LEFT JOIN search.erasure_target e
      ON e.partition_no=$1 AND e.account_id=$2 AND e.copy_home=t.partition_no
      AND e.physical_target=t.physical_target AND e.incarnation=t.incarnation
      WHERE e.copies_complete IS DISTINCT FROM true OR e.copy_revision<>t.copy_revision LIMIT 1`,
      keys,
    );
    const currentTargets = await population();
    if (
      dirty.rowCount ||
      !currentTargets ||
      currentTargets.length !== targets.length ||
      currentTargets.some(
        (current, i) =>
          current.physicalTarget !== targets[i]?.physicalTarget ||
          current.incarnation !== targets[i]?.incarnation ||
          current.revision !== targets[i]?.revision,
      )
    )
      return pending('copies-pending', 'finalize');
    turn.check();
    const finalized = await runCommand(pool, { partition: home, deadline: context.deadline }, async (tx) => {
      turn.check();
      if (!(await verifySubjectErasureSourceProof(tx, barrier, sourceProof))) return { value: false, events: [] };
      turn.check();
      const updated = await tx.query(
        `UPDATE search.erasure_progress SET phase='done',pending_reason=NULL
        WHERE (partition_no,account_id)=($1,$2) AND source_complete AND personal_complete`,
        keys,
      );
      turn.check();
      return { value: updated.rowCount === 1, events: [] };
    });
    turn.check();
    return finalized.value ? progress('complete', 'done') : pending('source-changed', 'finalize');
  } catch (error) {
    if (error instanceof TypeError) throw error;
    // A lost effect/response retains its exact native intent. No timeout or engine count can settle it.
    if (Date.now() >= context.deadline) return progress('pending', header.phase, 'native-ambiguous');
    return pending('native-ambiguous', header.phase);
  }

  async function engine(
    method: Parameters<OpenSearch['request']>[0],
    path: string,
    body?: unknown,
    query?: Record<string, string | number | boolean>,
  ) {
    turn.check();
    if (!search) throw new Error('Search erasure unavailable');
    return search.request(method, path, body, query ? { query } : undefined);
  }
  async function exact(target: PublicFilterConsumer) {
    const response = await engine('GET', `/${target.physicalTarget}/_settings`);
    const item = object(response.body) ? response.body[target.physicalTarget] : null;
    const settings = object(item) ? item.settings : null;
    const native = object(settings) ? settings.index : null;
    return response.status === 200 && object(native) && native.uuid === target.incarnation;
  }
  async function population(): Promise<Target[] | null> {
    // Live OpenSearch subject generations are the copy inventory. Coverage-store completeness
    // and discovery indices are not subject-writer targets; Account discovery has its own purge.
    const prefix = runtime.prefix!;
    let native: { status: number; body: unknown };
    try {
      native = await engine('GET', `/${prefix}subjects-g*/_settings`, undefined, {
        expand_wildcards: 'all',
        allow_no_indices: true,
        ignore_unavailable: true,
      });
    } catch (error) {
      if (error instanceof OpenSearchError && error.status === 404) return [];
      throw error;
    }
    const listed = physicalSubjectGenerationsFromSettings(prefix, native.body);
    if (native.status !== 200 || !listed) return null;
    return listed.map((row) => ({
      physicalTarget: row.physicalTarget,
      incarnation: row.incarnation,
      consumerGeneration: row.consumerGeneration,
      projectionGeneration: 'subjects-v1',
      meaningDigest: null,
      readDefinition: null,
      revision: row.incarnation,
      complete: true,
    }));
  }
}

function affected(record: SubjectErasureSourceRecord | undefined): string[] {
  if (!record) return [];
  const ids = new Set([record.original]);
  if (record.previousTerminal) ids.add(record.previousTerminal);
  if (record.currentTerminal) ids.add(record.currentTerminal);
  for (const locator of record.repairLocators) ids.add(locator.subject);
  // The owner page's admitted native input bound includes these repair locators.
  if (ids.size > 100) throw new TypeError('Unbounded Subject erasure repair page');
  return [...ids];
}

/** Personal PostgreSQL custody supplies only its own completion, never the participant ACK. */
export async function markSearchPersonalErasure(pool: Pool, accountId: string, context?: SearchErasureContext) {
  return withErasureTurn(context, async (turn) => {
    await stepSearchErasureTurn(pool, accountId, false, turn);
    return erasureQuery(
      pool,
      turn,
      `UPDATE search.erasure_progress SET personal_complete=true
    WHERE (partition_no,account_id)=($1,$2)`,
      [partitionOf(routeOf(accountId)!), accountId],
    );
  });
}

/** The sole final ACK step consumes persisted Search completion; diagnostics and callers cannot pick it. */
export async function acknowledgeSearchErasure(pool: Pool, accountId: string, context?: SearchErasureContext) {
  return withErasureTurn(context, (turn) => acknowledgeSearchErasureTurn(pool, accountId, turn));
}

async function acknowledgeSearchErasureTurn(pool: Pool, accountId: string, turn: ErasureTurn) {
  const route = routeOf(accountId);
  if (route === null) throw new TypeError('Invalid Search erasure account');
  const record = (
    await erasureQuery<{ ever_applied: boolean; version: number; at: string }>(
      pool,
      turn,
      `SELECT ever_applied,version,at::text FROM search.erasure_progress WHERE (partition_no,account_id)=($1,$2)
     AND phase='done' AND source_complete AND personal_complete`,
      [partitionOf(route), accountId],
    )
  ).rows[0];
  if (!record) throw new Error('Search erasure is pending');
  const barrier: HistoryBarrier = { accountId, accountRoute: route, version: record.version, at: record.at };
  const { deadline } = turn.context;
  turn.check();
  const proof = await readSubjectErasureSourceProof({ pool }, barrier, turn.context);
  turn.check();
  if (!proof) throw new Error('Search erasure Source proof is pending');
  const verified = await runCommand(pool, { partition: partitionOf(route), deadline }, async (tx) => {
    turn.check();
    const value = await verifySubjectErasureSourceProof(tx, barrier, proof);
    turn.check();
    return { value, events: [] };
  });
  turn.check();
  if (!verified.value) throw new Error('Search erasure Source proof changed');
  await acknowledgeErasure(
    { pool },
    { accountId, participant: 'search', outcome: record.ever_applied ? 'erased' : 'none', retained: [] },
  );
  turn.check();
  await erasureQuery(
    pool,
    turn,
    `UPDATE search.erasure_progress SET acked=true
    WHERE (partition_no,account_id)=($1,$2) AND phase='done'`,
    [partitionOf(route), accountId],
  );
}

export function registerSearchErasure(
  context: WorkContext,
  configuration?: { url: string; prefix: string },
  composeCreditSearch?: (pool: Pool, routeKey: Uint8Array) => import('./credit-search.ts').CreditSearchSource,
  nativePorts?: SearchNativePorts,
) {
  const routeKey = context.env.KERNEL_ROUTE_KEY ? readMembershipRouteKey(context.env) : undefined;
  let source: SubjectErasureSource | undefined;
  const search = configuration ? createOpenSearch(configuration.url) : undefined;
  const creditSearch = routeKey ? composeCreditSearch?.(context.pool, routeKey) : undefined;
  const nativeSource = routeKey
    ? createRatedSubjectSource(context.pool, routeKey, creditSearch, nativePorts).source
    : undefined;
  const listing = subjectListingSource(context.pool);
  const runtime: SearchErasureRuntime = {
    get source() {
      return source;
    },
    ...(routeKey
      ? {
          accountRegistry: () =>
            nativeDiscoveryRegistry(
              context.pool,
              routeKey,
              createRatedSubjectSource(context.pool, routeKey, creditSearch, nativePorts).source,
            ),
        }
      : {}),
    ...(search && configuration ? { search, prefix: configuration.prefix } : {}),
    writerGuard(consumer, turn) {
      if (!configuration || !search || !nativeSource) return undefined;
      const match = new RegExp(`^${configuration.prefix}subjects-g([1-9][0-9]*)$`).exec(consumer.physicalTarget);
      const generation = Number(match?.[1]);
      if (!Number.isSafeInteger(generation) || generation < 1) return undefined;
      return createSearchWriterGuard({
        pool: context.pool,
        search: turn?.search ?? search,
        source: nativeSource,
        listing,
        index: consumer.physicalTarget,
        consumer: subjectConsumer(configuration.prefix, generation),
      });
    },
  };
  const step = DBOS.registerStep((accountId: string) => stepSearchErasure(context.pool, accountId, runtime), {
    name: 'search.erasure.step',
    retriesAllowed: true,
    maxAttempts: 10,
  });
  const acknowledge = DBOS.registerStep((accountId: string) => acknowledgeSearchErasure(context.pool, accountId), {
    name: 'search.erasure.acknowledge',
    retriesAllowed: true,
    maxAttempts: 10,
  });
  const enqueue = async (accountId: string, segment: number) =>
    context.client.enqueue(
      {
        workflowName,
        workflowID: `search:erasure:1:${accountId}:${segment}`,
        workflowIDReusePolicy: 'return-existing',
        queueName: 'maintenance',
      },
      accountId,
      segment,
    );
  const continuation = DBOS.registerStep(enqueue, {
    name: 'search.erasure.continue',
    retriesAllowed: true,
    maxAttempts: 10,
  });
  DBOS.registerWorkflow(
    async (accountId: string, segment: number) => {
      for (let n = 0; n < 16; n++) {
        const result = await step(accountId);
        if (result.state === 'complete') {
          await acknowledge(accountId);
          return;
        }
        if (result.state === 'pending') {
          const wait =
            result.reason === 'source-unavailable' ||
            result.reason === 'population-unknown' ||
            result.reason === 'configuration-unavailable' ||
            result.reason === 'copies-pending' ||
            result.reason === 'personal-pending'
              ? 1_000
              : 30_000;
          await DBOS.sleep(wait);
        }
      }
      await continuation(accountId, segment + 1);
    },
    { name: workflowName },
  );
  context.addEffects([
    {
      name: 'search_erasure',
      types: [eventType],
      async run(event) {
        const accountId = searchErasureAccount(event);
        await stepSearchErasure(context.pool, accountId, runtime);
        await enqueue(accountId, 0);
      },
    },
  ]);
  return (access: Parameters<PublicFilterSourceFactory>[0]['access']) => {
    if (routeKey) source = createSubjectErasureSource({ pool: context.pool, routeKey, access, clock: context.clock });
  };
}
