import { DBOS } from '@dbos-inc/dbos-sdk';
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { ERASURE_PARTICIPANTS, acknowledgeErasure } from '../access/erasure.ts';
import { readMembershipRouteKey } from '../access/membership-work-config.ts';
import { runCommand } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import type { CloudEvent } from '../events/log.ts';
import type { HistoryBarrier } from '../history/registry.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import {
  createSubjectErasureSource,
  verifySubjectErasureSourcePage,
  readSubjectErasureSourceProof,
  verifySubjectErasureSourceProof,
} from '../semantic/account-erasure-source.ts';
import type { SubjectErasureSourceRecord, SubjectErasureSource } from '../semantic/account-erasure-source-contract.ts';
import type { PublicFilterConsumer, PublicFilterCost } from '../semantic/public-filter-source-contract.ts';
import type { NativeStepWork } from '../semantic/identity-epoch-contract.ts';
import type { WorkContext } from '../work/registry.ts';
import { createOpenSearch, type OpenSearch } from './opensearch.ts';
import { stepRetainedTargetErasure } from './public-filter-custody.ts';
import type { SearchWriterPublicationGuard, SearchWriterPublicationFence } from './writer-guard.ts';
import { validateRefreshResponse } from './write-actions.ts';
import { eraseDiscoveryAccount, nativeDiscoveryRegistry } from './account-discovery.ts';
import { createRatedSubjectSource } from './rated-source.ts';
import type { DiscoveryRegistry } from './discovery.ts';
import type { PublicFilterSourceFactory } from '../semantic/public-filter-source-contract.ts';
import { createSearchWriterGuard } from './writer-guard.ts';
import { subjectConsumer } from './runner.ts';
import { subjectListingSource } from '../library/listing-counts.ts';

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
/** Trusted native composition, never workflow arguments or a callback Boolean certificate. */
export type SearchErasureRuntime = Readonly<{
  search?: OpenSearch;
  prefix?: string;
  source?: SubjectErasureSource | undefined;
  accountRegistry?: () => Promise<DiscoveryRegistry>;
  writerGuard?: (consumer: PublicFilterConsumer) => SearchWriterPublicationGuard | undefined;
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
): Promise<SearchErasureProgress> {
  const runtime: SearchErasureRuntime = typeof configured === 'boolean' ? {} : configured;
  const route = routeOf(accountId);
  if (route === null) throw new TypeError('Invalid Search erasure account');
  const home = partitionOf(route),
    keys = [home, accountId];
  const work = { rows: 0, points: 0, statements: 0, bytes: 0, engineRequests: 0 };
  const cost = emptyCost(),
    context = { deadline: Date.now() + 5000 };
  const meter = (db: Pick<PoolClient, 'query'>) => {
    const nativeQuery = db.query;
    return new Proxy(db, {
      get(target, property, receiver) {
        if (property !== 'query') return Reflect.get(target, property, receiver);
        return async (...args: unknown[]) => {
          work.statements++;
          work.bytes += bytes(args);
          const result: QueryResult = await Reflect.apply(nativeQuery, target, args);
          work.rows += result.rowCount ?? 0;
          work.bytes += bytes(result.rows);
          return result;
        };
      },
    });
  };
  async function query<T extends QueryResultRow>(sql: string, values: unknown[] = []) {
    if (Date.now() >= context.deadline) throw new Error('Search erasure deadline');
    return withConnection(pool, async (db) => {
      const tx = meter(db);
      await tx.query('BEGIN');
      try {
        await tx.query("SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$1,true)", [
          `${Math.max(1, context.deadline - Date.now())}ms`,
        ]);
        const result = await tx.query<T>(sql, values);
        await tx.query('COMMIT');
        return result;
      } catch (error) {
        await tx.query('ROLLBACK');
        throw error;
      }
    });
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
  ): SearchErasureProgress => ({ state, phase, ...(reason ? { reason } : {}), obligation: barrier, work, cost });
  async function pending(reason: SearchErasurePendingReason, phase: SearchErasureProgress['phase']) {
    await query(
      `UPDATE search.erasure_progress SET pending_reason=$3,phase=$4
      WHERE (partition_no,account_id)=($1,$2) AND phase<>'done'`,
      [...keys, reason, phase],
    );
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
      const cleaned = await stepRetainedTargetErasure(
        pool,
        {
          partition: copy.partition_no,
          physicalTarget: copy.physical_target,
          after: copy.registration_after,
        },
        runtime.search,
        context,
      );
      addCost(cost, cleaned.cost);
      work.rows += cleaned.cost.rows;
      work.statements += cleaned.cost.statements;
      work.bytes += cleaned.cost.bytes;
      work.engineRequests += cleaned.cost.engineRequests;
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
    const sourceProof = await readSubjectErasureSourceProof({ pool }, barrier, context);
    if (!sourceProof) return pending('source-unavailable', 'source');
    if (!runtime.search || !runtime.prefix) return pending('configuration-unavailable', 'sealing');
    const accountCopy = await query(
      `SELECT 1 FROM search.discovery_copy WHERE route=$1 AND source_id=$2
      AND kind='account' LIMIT 1`,
      [route, accountId],
    );
    if (accountCopy.rowCount) {
      if (!runtime.accountRegistry) return pending('copies-pending', 'copies');
      // Reuse the Account owner's native per-key guard/purge and Access late-item receiving protocol.
      const timed: OpenSearch = {
        request: (method, path, body, options) => {
          work.engineRequests++;
          work.bytes += bytes([path, body, options]);
          return runtime.search!.request(method, path, body, {
            ...options,
            timeoutMs: Math.max(1, context.deadline - Date.now()),
          });
        },
        bulk: (lines, options) => runtime.search!.bulk(lines, options),
      };
      await eraseDiscoveryAccount(pool, timed, await runtime.accountRegistry(), accountId, 1);
      await query(`UPDATE search.erasure_progress SET ever_applied=true WHERE (partition_no,account_id)=($1,$2)`, keys);
      return progress('more', 'copies');
    }
    if (!runtime.source) return pending('source-unavailable', 'source');
    if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(runtime.prefix)) throw new TypeError('Invalid Search erasure prefix');
    const targets = await population();
    if (!targets) return pending('population-unknown', 'sealing');
    const page = await runtime.source.readPage({ barrier, frontier: header.frontier, inputLimit: 100, context });
    addCost(cost, page.cost);
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
      const guard = runtime.writerGuard?.(consumer);
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
          const drained = await guard.drainPublication(old, context);
          addCost(cost, drained.cost);
          if (drained.status !== 'drained') return progress('pending', 'drain', 'source-changed');
          const released = await guard.releasePublication(old, context);
          addCost(cost, released.cost);
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
          await guard.write(partitionOf(idRoute), [id], 0n);
          await update('key_offset=key_offset+1');
        } else await update("phase='fence'");
        return progress('more', 'repair');
      }
      if (effect.phase === 'fence') {
        const result = await guard.fencePublication(native, context);
        addCost(cost, result.cost);
        if (result.status !== 'fenced') return pending('writer-unavailable', 'drain');
        await update("phase='drain',fence=$9", [result.fence.fence]);
        return progress('more', 'drain');
      }
      if (!effect.fence) return pending('native-ambiguous', 'drain');
      const fence: SearchWriterPublicationFence = { ...native, fence: effect.fence };
      if (effect.phase === 'drain') {
        const result = await guard.drainPublication(fence, context);
        addCost(cost, result.cost);
        if (result.status === 'drained') await update("phase='adopt'");
        else if (result.status !== 'draining') return pending('writer-unavailable', 'drain');
        return progress('more', 'drain');
      }
      if (effect.phase === 'adopt' || effect.phase === 'compact') {
        // Adoption resolves the locator to current native gate/drain/copy custody each time.
        const result = await guard.adoptPublication(fence, context);
        addCost(cost, result.cost);
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
        const released = await guard.releasePublication(fence, context);
        addCost(cost, released.cost);
        if (released.status !== 'released') return pending('writer-unavailable', 'drain');
        await update("phase='released',fence=NULL");
        return progress('more', 'drain');
      }
      throw new TypeError('Invalid native erasure effect phase');
    }
    // The producer validates its native barrier again after effects. A changed source never advances
    // the raw frontier, and no page receipt/record body is stored in DBOS history or Search SQL.
    const advanced = await runCommand(pool, { partition: home, deadline: context.deadline }, async (tx) => {
      const originalQuery = tx.query;
      tx.query = meter(tx).query;
      try {
        const db = tx;
        if (!(await verifySubjectErasureSourcePage(db, barrier, page.receipt))) return { value: false, events: [] };
        const updated = await db.query(
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
        return { value: updated.rowCount === 1, events: [] };
      } finally {
        tx.query = originalQuery;
      }
    });
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
    const finalized = await runCommand(pool, { partition: home, deadline: context.deadline }, async (tx) => {
      if (!(await verifySubjectErasureSourceProof(tx, barrier, sourceProof))) return { value: false, events: [] };
      const updated = await tx.query(
        `UPDATE search.erasure_progress SET phase='done',pending_reason=NULL
        WHERE (partition_no,account_id)=($1,$2) AND source_complete AND personal_complete`,
        keys,
      );
      return { value: updated.rowCount === 1, events: [] };
    });
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
    if (!runtime.search || Date.now() >= context.deadline) throw new Error('Search erasure unavailable');
    work.engineRequests++;
    work.bytes += bytes([path, body, query]);
    const response = await runtime.search.request(method, path, body, {
      timeoutMs: Math.max(1, context.deadline - Date.now()),
      ...(query ? { query } : {}),
    });
    work.bytes += bytes(response.body);
    return response;
  }
  async function exact(target: PublicFilterConsumer) {
    const response = await engine('GET', `/${target.physicalTarget}/_settings`);
    const item = object(response.body) ? response.body[target.physicalTarget] : null;
    const settings = object(item) ? item.settings : null;
    const native = object(settings) ? settings.index : null;
    return response.status === 200 && object(native) && native.uuid === target.incarnation;
  }
  async function population(): Promise<Target[] | null> {
    const prefix = runtime.prefix!;
    const controls = await query<{ prefix: string }>(
      'SELECT prefix FROM search.index_prefix_control WHERE partition_no=0 ORDER BY prefix LIMIT 100',
    );
    // Configuration is a locator, never proof that no other installation has retained copies.
    if (controls.rows.length !== 1 || controls.rows[0]?.prefix !== prefix) return null;
    const rows = await query<{
      index_name: string;
      uuid: string;
      generation: string;
      protocol: string;
      revision: string;
      complete: boolean;
    }>(
      `SELECT index_name,index_uuid AS uuid,generation::text,protocol,
        revision::text,population_complete AS complete FROM search.index_incarnation
        WHERE partition_no=0 AND prefix=$1 ORDER BY generation LIMIT 4`,
      [prefix],
    );
    if (!rows.rowCount || rows.rows.length > 3) return null;
    // The mixed-family owner retains separate native lifecycle/Account receiving custody.
    const mixed = await query<{
      index_name: string;
      uuid: string;
      generation: string;
      protocol: string;
      revision: string;
      complete: boolean;
    }>(
      `SELECT $1||'discovery-g'||generation AS index_name,
      index_uuid AS uuid,generation::text,'discovery-v1' AS protocol,incarnation::text AS revision,
      state IN ('active','retiring') AS complete FROM search.discovery_generation
      WHERE partition_no=0 AND prefix=$1 AND state<>'retired' ORDER BY generation LIMIT 4`,
      [prefix],
    );
    if (mixed.rows.length > 3) return null;
    const targets: Target[] = [...rows.rows, ...mixed.rows].map((row) => ({
      physicalTarget: row.index_name,
      incarnation: row.uuid,
      consumerGeneration: row.generation,
      projectionGeneration: row.protocol,
      meaningDigest: null,
      readDefinition: null,
      revision: row.revision,
      complete: row.complete,
    }));
    // Include unaliased/building/retiring native names; absent lineage is unresolved population.
    const native = await engine('GET', `/${prefix}subjects-g*,${prefix}discovery-g*/_settings`, undefined, {
      expand_wildcards: 'all',
      allow_no_indices: true,
    });
    if (native.status !== 200 || !object(native.body) || Object.keys(native.body).length !== targets.length)
      return null;
    for (const target of targets) {
      const item = native.body[target.physicalTarget];
      const settings = object(item) ? item.settings : null;
      const index = object(settings) ? settings.index : null;
      if (!object(index) || index.uuid !== target.incarnation || !target.complete) return null;
    }
    return targets;
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
export async function markSearchPersonalErasure(pool: Pool, accountId: string) {
  await stepSearchErasure(pool, accountId, false);
  return withConnection(pool, (tx) =>
    tx.query(
      `UPDATE search.erasure_progress SET personal_complete=true
    WHERE (partition_no,account_id)=($1,$2)`,
      [partitionOf(routeOf(accountId)!), accountId],
    ),
  );
}

/** The sole final ACK step consumes persisted Search completion; diagnostics and callers cannot pick it. */
export async function acknowledgeSearchErasure(pool: Pool, accountId: string) {
  const route = routeOf(accountId);
  if (route === null) throw new TypeError('Invalid Search erasure account');
  const record = await withConnection(
    pool,
    async (tx) =>
      (
        await tx.query<{ ever_applied: boolean; version: number; at: string }>(
          `SELECT ever_applied,version,at::text FROM search.erasure_progress WHERE (partition_no,account_id)=($1,$2)
     AND phase='done' AND source_complete AND personal_complete`,
          [partitionOf(route), accountId],
        )
      ).rows[0],
  );
  if (!record) throw new Error('Search erasure is pending');
  const barrier: HistoryBarrier = { accountId, accountRoute: route, version: record.version, at: record.at };
  const deadline = Date.now() + 5000;
  const proof = await readSubjectErasureSourceProof({ pool }, barrier, { deadline });
  if (!proof) throw new Error('Search erasure Source proof is pending');
  const verified = await runCommand(pool, { partition: partitionOf(route), deadline }, async (tx) => ({
    value: await verifySubjectErasureSourceProof(tx, barrier, proof),
    events: [],
  }));
  if (!verified.value) throw new Error('Search erasure Source proof changed');
  await acknowledgeErasure(
    { pool },
    { accountId, participant: 'search', outcome: record.ever_applied ? 'erased' : 'none', retained: [] },
  );
  await withConnection(pool, (tx) =>
    tx.query(
      `UPDATE search.erasure_progress SET acked=true
    WHERE (partition_no,account_id)=($1,$2) AND phase='done'`,
      [partitionOf(route), accountId],
    ),
  );
}

export function registerSearchErasure(context: WorkContext, configuration?: { url: string; prefix: string }) {
  const routeKey = context.env.KERNEL_ROUTE_KEY ? readMembershipRouteKey(context.env) : undefined;
  let source: SubjectErasureSource | undefined;
  const search = configuration ? createOpenSearch(configuration.url) : undefined;
  const nativeSource = routeKey ? createRatedSubjectSource(context.pool, routeKey).source : undefined;
  const listing = subjectListingSource(context.pool);
  const runtime: SearchErasureRuntime = {
    get source() {
      return source;
    },
    ...(routeKey
      ? {
          accountRegistry: () =>
            nativeDiscoveryRegistry(context.pool, routeKey, createRatedSubjectSource(context.pool, routeKey).source),
        }
      : {}),
    ...(search && configuration ? { search, prefix: configuration.prefix } : {}),
    writerGuard(consumer) {
      if (!configuration || !search || !nativeSource) return undefined;
      const match = new RegExp(`^${configuration.prefix}subjects-g([1-9][0-9]*)$`).exec(consumer.physicalTarget);
      const generation = Number(match?.[1]);
      if (!Number.isSafeInteger(generation) || generation < 1) return undefined;
      return createSearchWriterGuard({
        pool: context.pool,
        search,
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
        if (result.state === 'pending') await DBOS.sleep(30_000);
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
