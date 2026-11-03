import { isDeepStrictEqual } from 'node:util';
import type { Pool, PoolClient } from 'pg';
import { withConnection, discardConnection } from '../database/pool.ts';
import { noEffect, runCommand } from '../command/command.ts';
import { activeRelease } from '../semantic/definitions.ts';
import type { Release } from '@rezics/definitions';
import { readAccountDiscoveryBindings } from '../access/account-discovery-source.ts';
import { redriveAccountDiscovery } from '../access/account-discovery-work.ts';
import { readErasureStatus, recordLateErasureItem, resolveLateErasureItem } from '../access/erasure.ts';
import type { DiscoveryIndexAction, DiscoveryKey, DiscoveryRegistry } from './discovery.ts';
import type { SubjectListingSource } from './source.ts';
import type { OpenSearch } from './opensearch.ts';
import { createNativeDiscoveryRegistry } from './discovery-hydration.ts';
import {
  discoveryDocumentActions,
  discoveryDocumentId,
  parseDiscoveryDocumentId,
  parseDiscoveryDocumentKey,
  secondScopeDiscoveryDocumentActions,
  type AnyDiscoveryIndexAction,
  type SecondScopeDiscoveryIndexAction,
} from './discovery-documents.ts';
import { discoveryIndexName, discoveryIndexUuid } from './indices.ts';
import { writeDiscoveryActions, validateRefreshResponse, validateDiscoveryWriteReceipt } from './write-actions.ts';
import { validateObservation } from './indexer.ts';
import { prepareBoundedSortKeys } from './bounded-sort-keys.ts';
import { PARTITIONS, partitionOf, routeOf } from '../route/route.ts';
import {
  MAX_ACCOUNT_DISCOVERY_BATCH,
  discoveryPartition,
  type AccountDiscoverySource,
  type AccountFrontier,
  type AccountPage,
  type AccountSnapshot,
  type IndexedAccount,
} from './discovery.ts';
import { reviewDiscoveryDocument } from './review-discovery.ts';
import type { ReviewDiscoveryRefresh } from '../content/review-discovery-changes.ts';
import { assertCompleteSearch } from './complete-search.ts';
import { accountDocumentActions } from './document.ts';
import type { SubjectSource } from './source.ts';

const MAX_NATIVE_REVISION = 9_223_372_036_854_775_807n;
const MAX_EXTERNAL_VERSION = MAX_NATIVE_REVISION;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function partitionNumber(partition: number): void {
  if (!Number.isInteger(partition) || partition < 0 || partition >= PARTITIONS)
    throw new RangeError('Invalid discovery partition');
}

function keys(partition: number, ids: readonly string[]): string[] {
  partitionNumber(partition);
  if (ids.length > MAX_ACCOUNT_DISCOVERY_BATCH) throw new RangeError('Account discovery accepts at most 100 ids');
  for (const id of ids) {
    if (discoveryPartition(id) !== partition) throw new RangeError('Account discovery key is outside its partition');
  }
  return [...new Set(ids)];
}

function position(value: unknown, obligation: bigint): bigint {
  if (
    typeof obligation !== 'bigint' ||
    obligation < 0n ||
    obligation > MAX_EXTERNAL_VERSION ||
    typeof value !== 'bigint' ||
    value < obligation ||
    value < 0n ||
    value > MAX_EXTERNAL_VERSION
  )
    throw new TypeError('Account snapshot position must cover the batch within the external version domain');
  return value;
}

function account(value: unknown, partition: number): IndexedAccount {
  if (
    !record(value) ||
    typeof value.id !== 'string' ||
    discoveryPartition(value.id) !== partition ||
    (value.accountKind !== 'actor' && value.accountKind !== 'organization') ||
    (value.handle !== null && (typeof value.handle !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value.handle))) ||
    (value.displayName !== null && typeof value.displayName !== 'string') ||
    typeof value.revision !== 'bigint' ||
    value.revision < 1n ||
    value.revision > MAX_NATIVE_REVISION
  )
    throw new TypeError('Invalid native Account discovery row');
  return {
    id: value.id,
    accountKind: value.accountKind,
    handle: value.handle,
    displayName: value.displayName,
    revision: value.revision,
  };
}

/** Admit the whole native chunk before sort preparation or engine I/O; omission means keyed deletion. */
export function validateAccountSnapshot(
  value: unknown,
  partition: number,
  ids: readonly string[],
  atLeast: bigint,
): AccountSnapshot {
  const requested = new Set(keys(partition, ids));
  if (
    !record(value) ||
    value.partition !== partition ||
    !Array.isArray(value.accounts) ||
    value.accounts.length > requested.size
  )
    throw new TypeError('Account snapshot must contain unique requested rows in the requested partition');
  const observed = position(value.position, atLeast);
  if (requested.size > 0 && observed === 0n) throw new TypeError('Account write version must be positive');
  const seen = new Set<string>();
  const accounts = value.accounts.map((row) => {
    const current = account(row, partition);
    if (!requested.has(current.id) || seen.has(current.id)) throw new TypeError('Unrequested or duplicate Account row');
    seen.add(current.id);
    return current;
  });
  return { partition, position: observed, accounts };
}

function frontier(value: unknown, partition: number): AccountFrontier {
  if (
    !record(value) ||
    typeof value.id !== 'string' ||
    typeof value.route !== 'number' ||
    routeOf(value.id) !== value.route ||
    discoveryPartition(value.id) !== partition
  )
    throw new TypeError('Invalid Account population frontier');
  return { route: value.route, id: value.id };
}

function compare(a: AccountFrontier, b: AccountFrontier): number {
  return a.route - b.route || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Native keyset order/exhaustion is retained even when the exact claim produces a null handle. */
export function validateAccountPage(
  value: unknown,
  partition: number,
  after: AccountFrontier | null,
  limit: number,
): AccountPage {
  partitionNumber(partition);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ACCOUNT_DISCOVERY_BATCH)
    throw new RangeError('Account population page limit must be from 1 to 100');
  let previous = after === null ? null : frontier(after, partition);
  if (
    !record(value) ||
    value.partition !== partition ||
    !Array.isArray(value.accounts) ||
    value.accounts.length > limit
  )
    throw new TypeError('Invalid Account population page');
  const observed = position(value.position, 0n);
  const accounts = value.accounts.map((row) => {
    const current = account(row, partition);
    const key = frontier({ route: routeOf(current.id), id: current.id }, partition);
    if (previous !== null && compare(previous, key) >= 0) throw new TypeError('Account population keys must advance');
    previous = key;
    return current;
  });
  if (accounts.length > 0 && observed === 0n) throw new TypeError('Account write version must be positive');
  const next = value.next === null ? null : frontier(value.next, partition);
  if (next !== null && (accounts.length !== limit || previous === null || compare(previous, next) !== 0))
    throw new TypeError('Account population continuation must identify the last full-page key');
  return { partition, position: observed, accounts, next };
}

/** One native bootstrap page. Persist next only after the existing writer settles all returned actions. */
export async function prepareAccountPopulationPage(
  source: AccountDiscoverySource,
  partition: number,
  after: AccountFrontier | null,
  limit = MAX_ACCOUNT_DISCOVERY_BATCH,
) {
  // Validate caller input before handing it to the native owner.
  partitionNumber(partition);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ACCOUNT_DISCOVERY_BATCH)
    throw new RangeError('Account population page limit must be from 1 to 100');
  if (after !== null) frontier(after, partition);
  const snapshot = validateAccountPage(await source.page(partition, after, limit), partition, after, limit);
  return {
    snapshot,
    actions: accountDocumentActions(
      snapshot,
      snapshot.accounts.map(({ id }) => id),
    ),
  };
}

/** Event keys only; reread current native rows, retaining every tail within the same checkpoint obligation. */
export async function* prepareAccountCatchup(
  source: AccountDiscoverySource,
  partition: number,
  ids: readonly string[],
  atLeast: bigint,
) {
  partitionNumber(partition);
  const unique = [...new Set(ids)];
  // Reject foreign keys in the entire batch before admitting any prefix.
  for (const id of unique) {
    if (discoveryPartition(id) !== partition) throw new RangeError('Account discovery key is outside its partition');
  }
  position(atLeast, 0n);
  for (let offset = 0; offset < unique.length; offset += MAX_ACCOUNT_DISCOVERY_BATCH) {
    const chunk = unique.slice(offset, offset + MAX_ACCOUNT_DISCOVERY_BATCH);
    const snapshot = validateAccountSnapshot(await source.read(partition, chunk), partition, chunk, atLeast);
    yield { snapshot, actions: accountDocumentActions(snapshot, chunk) };
  }
}

export type DiscoveryCensus = {
  partition: number;
  position: bigint;
  subjects: number;
  accounts: number;
};

/** Both owners must observe the same native cut. These values never supply KindCountEvidence. */
export async function readDiscoveryCensus(
  subjects: SubjectSource,
  accounts: AccountDiscoverySource,
  partition: number,
): Promise<DiscoveryCensus> {
  partitionNumber(partition);
  const subject = await subjects.count(partition);
  const account = await accounts.count(partition);
  const valid = (value: unknown): value is { position: bigint; count: number } =>
    record(value) &&
    typeof value.position === 'bigint' &&
    value.position >= 0n &&
    value.position <= MAX_NATIVE_REVISION &&
    typeof value.count === 'number' &&
    Number.isSafeInteger(value.count) &&
    value.count >= 0;
  if (!valid(subject) || !valid(account) || account.partition !== partition)
    throw new TypeError('Both native discovery censuses are required');
  if (subject.position !== account.position) throw new Error('Discovery census observations moved; reconcile again');
  return { partition, position: subject.position, subjects: subject.count, accounts: account.count };
}

/** The production registry uses each owner's real current-summary reader. No summary is indexed. */
export async function nativeDiscoveryRegistry(
  pool: Pool,
  routeKey: Uint8Array,
  subjects: SubjectSource,
  options?: { release: Release; languages?: readonly string[] },
) {
  const release = options?.release ?? (await activeRelease(pool))?.release;
  if (!release) throw new Error('Discovery requires an active definition release');
  return createNativeDiscoveryRegistry({
    pool,
    routeKey,
    release,
    languages: options?.languages ?? [],
    semantic: {
      source: subjects,
      icons: Object.fromEntries(Object.keys(release.types).map((kind) => [kind, 'file-text'])),
    },
    accounts: {
      labels: { en: 'Accounts' },
      icon: 'user-round',
    },
  });
}

export type DiscoveryTarget = { prefix: string; generation: number; uuid: string; incarnation: string };
export type DiscoveryProjection = ReturnType<typeof createDiscoveryProjection>;

/** Native mixed identity is its allocation incarnation AND engine UUID, never a Subject writer alias. */
export async function readDiscoveryWriterPhysicalTarget(pool: Pick<Pool, 'query'>, search: OpenSearch, index: string) {
  const match = /^(.*)discovery-g([1-9][0-9]*)$/.exec(index);
  if (!match || discoveryIndexName(match[1]!, Number(match[2])) !== index)
    throw new TypeError('Discovery repair requires an actual physical mixed generation');
  const row = (
    await pool.query<{ index_uuid: string; incarnation: string }>(
      `SELECT index_uuid,incarnation::text FROM search.discovery_generation
     WHERE partition_no=0 AND prefix=$1 AND generation=$2 AND state IN ('ready','active','retiring')`,
      [match[1], match[2]],
    )
  ).rows[0];
  const response = await search.request('GET', `/${index}`);
  const native = record(response.body) ? response.body[index] : undefined;
  const settings = record(native) && record(native.settings) ? native.settings.index : undefined;
  const mappings = record(native) && record(native.mappings) ? native.mappings._meta : undefined;
  const alias = record(native) && record(native.aliases) ? native.aliases[`${index}-write`] : undefined;
  if (
    !row?.index_uuid ||
    response.status !== 200 ||
    !record(response.body) ||
    Object.keys(response.body).length !== 1 ||
    !record(settings) ||
    settings.uuid !== row.index_uuid ||
    !record(mappings) ||
    mappings.incarnation !== row.incarnation ||
    mappings.discovery_document_format !== 2 ||
    mappings.comparator !== 'mixed-public-v1' ||
    !record(alias) ||
    alias.is_write_index !== true ||
    Object.keys(alias).length !== 1
  )
    throw new Error('Native discovery repair allocation is unavailable');
  return { incarnation: row.index_uuid, allocation: row.incarnation, writeAlias: `${index}-write` };
}

export type DiscoveryRepairEffect = Readonly<{
  key: DiscoveryKey;
  action: DiscoveryIndexAction;
  winner: unknown;
  evidence: Readonly<{ kind: 'bulk'; bulk: unknown }> | Readonly<{ kind: 'recovered'; refresh: unknown }>;
}>;

/** Search visibility belongs to the exact keyed winner; copy settlement is insufficient. */
export async function readDiscoveryRepairWinner(search: OpenSearch, index: string, action: AnyDiscoveryIndexAction) {
  const response = await search.request(
    'POST',
    `/${index}/_search`,
    {
      size: 1,
      version: true,
      track_total_hits: false,
      query: { ids: { values: [action.id] } },
    },
    { query: { allow_partial_search_results: false } },
  );
  if (response.status !== 200) throw new Error('Native discovery repair winner is unavailable');
  validateDiscoveryRepairWinner(index, action, response.body);
  return response.body;
}

/** The original search-visible winner remains part of the retained native repair provenance. */
export function validateDiscoveryRepairWinner(index: string, action: AnyDiscoveryIndexAction, body: unknown) {
  assertCompleteSearch(body);
  const hits = record(body) && record(body.hits) ? body.hits.hits : undefined;
  if (
    !Array.isArray(hits) ||
    (action.op === 'delete'
      ? hits.length !== 0
      : hits.length !== 1 ||
        !record(hits[0]) ||
        hits[0]._id !== action.id ||
        hits[0]._index !== index ||
        String(hits[0]._version) !== action.version.toString() ||
        !isDeepStrictEqual(hits[0]._source, action.document))
  )
    throw new Error('Native discovery repair winner changed or is not visible');
}

/** Session custody spans the external effect, but no database transaction/row lock does. */
export async function withDiscoveryTarget<T>(
  pool: Pool,
  search: OpenSearch,
  target: DiscoveryTarget,
  work: (client: PoolClient, index: string) => Promise<T>,
  purge = false,
): Promise<T> {
  const index = discoveryIndexName(target.prefix, target.generation);
  return withConnection(pool, async (client) => {
    await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [index]);
    try {
      const {
        rows: [row],
      } = await client.query<{ index_uuid: string; incarnation: string; state: string }>(
        `SELECT index_uuid,incarnation::text,state FROM search.discovery_generation
         WHERE partition_no=0 AND prefix=$1 AND generation=$2`,
        [target.prefix, target.generation],
      );
      if (
        !row ||
        row.index_uuid !== target.uuid ||
        row.incarnation !== target.incarnation ||
        (purge ? ['retired', 'allocated'] : ['retiring', 'retired', 'quarantined', 'allocated']).includes(row.state) ||
        (await discoveryIndexUuid(search, index)) !== target.uuid
      )
        throw new Error('Discovery physical incarnation is no longer writable');
      const value = await work(client, index);
      if ((await discoveryIndexUuid(search, index)) !== target.uuid)
        throw new Error('Discovery physical incarnation changed during write');
      return value;
    } finally {
      try {
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [index]);
      } catch (error) {
        discardConnection(client, error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
    }
  });
}

/** Before the first external copy, persist its locator under the actual Account erasure fence. */
async function locateAccount(pool: Pool, target: DiscoveryTarget, key: DiscoveryKey): Promise<boolean> {
  const result = await runCommand(pool, { partition: discoveryPartition(key.id) }, async (tx) => {
    // The account-home row serializes first registration with terminal deletion. Erasure's record is permanent.
    await tx.query('SELECT account_id FROM access.account WHERE route=$1 AND account_id=$2 FOR UPDATE', [
      key.route,
      key.id,
    ]);
    const erased = await readErasureStatus(tx, key.id);
    const values = [key.route, key.id, target.prefix, target.generation, key.kind];
    if (erased) {
      const copy = await tx.query(
        'SELECT 1 FROM search.discovery_copy WHERE route=$1 AND source_id=$2 AND prefix=$3 AND generation=$4 AND kind=$5',
        values,
      );
      if (!copy.rowCount) return noEffect(false);
      await tx.query('INSERT INTO search.discovery_erasure(route,account_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [
        key.route,
        key.id,
      ]);
      await recordLateErasureItem(tx, { accountId: key.id, participant: 'search', locator: copyLocator(target) });
      return {
        value: false,
        events: [{ type: 'com.rezics.access.account-updated.v1', subject: key.id, data: { accountId: key.id } }],
      };
    }
    const inserted = await tx.query(
      `INSERT INTO search.discovery_copy(route,source_id,prefix,generation,kind)
      VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING source_id`,
      values,
    );
    return inserted.rowCount
      ? {
          value: true,
          events: [{ type: 'com.rezics.access.account-updated.v1', subject: key.id, data: { accountId: key.id } }],
        }
      : noEffect(true);
  });
  return result.value;
}
export const copyLocator = (target: DiscoveryTarget) =>
  `discovery:${target.prefix}:${target.generation}:${target.uuid}`;

/** One writer for population, replay and repair, with durable native deletion high water. */
export function createDiscoveryProjection(options: {
  pool: Pool;
  search: OpenSearch;
  registry: DiscoveryRegistry;
  listing: SubjectListingSource;
  target: DiscoveryTarget;
}) {
  const { pool, search, registry, listing, target } = options;
  const accounts = registry.get('account');
  if (accounts.owner !== 'accounts') throw new TypeError('Account source is required');
  const subject = registry.entries.find((entry) => entry.owner === 'semantic');
  async function prepareChunk(
    partition: number,
    owner: DiscoveryKey['owner'],
    chunk: readonly DiscoveryKey[],
    atLeast: bigint,
  ): Promise<DiscoveryIndexAction[]> {
    const ids = [...new Set(chunk.map(({ id }) => id))];
    let actions: DiscoveryIndexAction[];
    if (owner === 'accounts') {
      const snapshot = validateAccountSnapshot(await accounts.source.read(partition, ids), partition, ids, atLeast);
      const bindings = await readAccountDiscoveryBindings(pool, partition, ids);
      for (const row of snapshot.accounts) {
        const binding = bindings.get(row.id);
        if (!binding || binding.revision !== row.revision || (row.handle !== null && binding.claim === null))
          throw new Error('Account discovery revision moved; retry');
        if (binding.claim && binding.consumedClaimRevision < binding.claim.revision) {
          await redriveAccountDiscovery({ pool }, partitionOf(binding.claim.route));
          throw new Error('Account claim consumption advanced; resnapshot before projection');
        }
      }
      actions = discoveryDocumentActions(registry, { owner, snapshot }, chunk, undefined, 'mixed-public-v1');
      for (const key of chunk)
        if (!(await locateAccount(pool, target, key))) {
          await eraseDiscoveryAccount(pool, search, registry, key.id);
          actions = actions.filter((action) => action.id !== discoveryDocumentId(registry, key));
        }
    } else {
      if (!subject || subject.owner !== 'semantic') throw new Error('Subject source is required');
      const snapshot = await subject.source.read(partition, ids);
      validateObservation(snapshot, partition, ids, atLeast, true);
      const counts = await listing.read(
        partition,
        snapshot.subjects.filter((row) => row.visibility === 'visible' && row.redirect === null).map(({ id }) => id),
      );
      const kinds = new Map<string, Set<string>>();
      for (const key of chunk) {
        const requested = kinds.get(key.id) ?? new Set();
        requested.add(key.kind);
        kinds.set(key.id, requested);
      }
      const keyedSnapshot = {
        ...snapshot,
        subjects: snapshot.subjects.filter((row) => kinds.get(row.id)?.has(row.type)),
      };
      actions = discoveryDocumentActions(
        registry,
        { owner, snapshot: keyedSnapshot },
        chunk,
        counts,
        'mixed-public-v1',
      );
    }
    // Both owner families use the same native ICU normalizer and normalized512/missing-last rule.
    return prepareBoundedSortKeys(search, discoveryIndexName(target.prefix, target.generation), actions);
  }
  async function applyActions(
    actions: readonly AnyDiscoveryIndexAction[],
    repair: boolean,
    capture: boolean,
    held?: { client: PoolClient; index: string; acknowledge(): Promise<void> },
  ) {
    const effects: DiscoveryRepairEffect[] = [];
    const apply = async (client: PoolClient, index: string) => {
      const pending: AnyDiscoveryIndexAction[] = [];
      for (const action of actions) {
        const key = parseDiscoveryDocumentKey(registry, action.id),
          values = [key.route, key.id, target.prefix, target.generation, key.kind];
        // Erasure can commit after source/locator reads; session custody excludes its physical purge.
        if (key.owner === 'accounts' && (await readErasureStatus(client, key.id)))
          throw new Error('Account erasure requires physical cleanup');
        const {
          rows: [old],
        } = await client.query<{ position: string; revision: string; settled: boolean; deleted: boolean }>(
          'SELECT position::text,revision::text,settled,deleted FROM search.discovery_copy WHERE route=$1 AND source_id=$2 AND prefix=$3 AND generation=$4 AND kind=$5',
          values,
        );
        const revision =
          action.op === 'index' && action.document.owner === 'accounts' ? BigInt(action.document.revision) : 0n;
        if (old && revision > 0n && BigInt(old.revision) > revision)
          throw new Error('Account native revision rewound; new incarnation required');
        if (old?.deleted && BigInt(old.position) === action.version && action.op === 'index')
          throw new Error('Discovery native position cannot resurrect its keyed deletion');
        if (
          old &&
          (BigInt(old.position) > action.version || (BigInt(old.position) === action.version && old.settled && !repair))
        )
          if (capture || held) throw new Error('Discovery source version is behind its permanent copy high water');
          else continue;
        await client.query(
          `INSERT INTO search.discovery_copy(route,source_id,prefix,generation,kind,position,revision,deleted,settled)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,false) ON CONFLICT(route,source_id,prefix,generation,kind)
          DO UPDATE SET position=EXCLUDED.position,revision=GREATEST(search.discovery_copy.revision,EXCLUDED.revision),deleted=EXCLUDED.deleted,settled=false`,
          [...values, action.version.toString(), revision.toString(), action.op === 'delete'],
        );
        pending.push(action);
      }
      let bulk: unknown;
      const transport: OpenSearch = capture
        ? {
            ...search,
            async bulkRaw<T>(body: string, options?: Parameters<NonNullable<OpenSearch['bulkRaw']>>[1]) {
              if (!search.bulkRaw) throw new TypeError('Discovery requires the native exact-version transport');
              const response = await search.bulkRaw<T>(body, options);
              bulk = response;
              return response;
            },
          }
        : search;
      await writeDiscoveryActions(transport, registry, index, pending);
      if (capture) {
        if (!record(bulk) || !Array.isArray(bulk.items) || bulk.items.length !== pending.length)
          throw new Error('Discovery repair has no exact native response');
        for (const [offset, action] of pending.entries()) {
          const item = bulk.items[offset];
          const result = record(item) ? item[action.op] : undefined;
          let evidence: DiscoveryRepairEffect['evidence'];
          if (record(result) && result.status === 409 && action.op === 'index') {
            // The original mixed writer verified the identical winner. Retain fresh visibility
            // and recheck the whole keyed body; the conflict itself never certifies settlement.
            const refresh = await search.request('POST', `/${index}/_refresh`);
            validateRefreshResponse(refresh.status, refresh.body);
            evidence = { kind: 'recovered', refresh: refresh.body };
          } else {
            const response = { errors: false, items: [item] };
            validateDiscoveryWriteReceipt(response, index, [action]);
            evidence = { kind: 'bulk', bulk: response };
          }
          const winner = await readDiscoveryRepairWinner(search, index, action);
          effects.push({
            key: parseDiscoveryDocumentId(registry, action.id),
            action: action as DiscoveryIndexAction,
            evidence,
            winner,
          });
        }
      }
      if (held) {
        for (const action of pending) await readDiscoveryRepairWinner(search, index, action);
        if ((await discoveryIndexUuid(search, index)) !== target.uuid)
          throw new Error('Discovery physical incarnation changed during receiving');
        await client.query('BEGIN');
      }
      try {
        for (const action of pending) {
          const key = parseDiscoveryDocumentKey(registry, action.id);
          await client.query(
            `UPDATE search.discovery_copy SET settled=true WHERE route=$1 AND source_id=$2 AND prefix=$3 AND generation=$4 AND kind=$5 AND position=$6`,
            [key.route, key.id, target.prefix, target.generation, key.kind, action.version.toString()],
          );
        }
        if (held) {
          await held.acknowledge();
          await client.query('COMMIT');
        }
      } catch (error) {
        if (held) await client.query('ROLLBACK');
        throw error;
      }
    };
    if (held) await apply(held.client, held.index);
    else await withDiscoveryTarget(pool, search, target, apply);
    return effects;
  }
  async function project(partition: number, input: readonly DiscoveryKey[], atLeast = 0n, repair = false) {
    const unique = new Map(
      input.map((input) => {
        const key = registry.key(input);
        if (discoveryPartition(key.id) !== partition) throw new RangeError('Foreign discovery key');
        return [discoveryDocumentId(registry, key), key];
      }),
    );
    const keys = [...unique.values()];
    for (const owner of ['semantic', 'accounts'] as const) {
      const owned = keys.filter((key) => key.owner === owner);
      const limit = owner === 'accounts' ? 100 : 256;
      for (let offset = 0; offset < owned.length; offset += limit) {
        const actions = await prepareChunk(partition, owner, owned.slice(offset, offset + limit), atLeast);
        await applyActions(actions, repair, false);
      }
    }
  }
  async function prepareRepair(
    id: string,
    obligation: bigint,
    owner: DiscoveryKey['owner'] = 'semantic',
  ): Promise<DiscoveryIndexAction[]> {
    const route = routeOf(id);
    if (route === null) throw new TypeError('Invalid discovery repair anchor');
    const partition = discoveryPartition(id);
    // One keyed inventory page, not registry/kind or population fanout. Retain old kinds for deletion.
    const copies = (
      await pool.query<{ kind: string }>(
        `SELECT kind FROM search.discovery_copy WHERE route=$1 AND source_id=$2 AND prefix=$3 AND generation=$4
       ORDER BY kind LIMIT 101`,
        [route, id, target.prefix, target.generation],
      )
    ).rows;
    if (copies.length > 100) throw new Error('Discovery repair exceeds its bounded keyed copy window');
    const selected = new Map<string, DiscoveryKey>();
    for (const { kind } of copies) {
      const entry = registry.get(kind);
      // An ID can name rows in both native owners. Their positions and deletion
      // obligations are independent, including when their UUID happens to agree.
      if (entry.owner !== owner) continue;
      const key: DiscoveryKey =
        entry.owner === 'accounts'
          ? { owner: 'accounts', kind: 'account', route, id }
          : { owner: 'semantic', kind, route, id };
      selected.set(kind, registry.key(key));
    }
    if (owner === 'semantic' && subject?.owner === 'semantic') {
      const snapshot = await subject.source.read(partition, [id]);
      validateObservation(snapshot, partition, [id], obligation, true);
      for (const row of snapshot.subjects)
        selected.set(row.type, registry.key({ owner: 'semantic', kind: row.type, route, id }));
    }
    if (owner === 'accounts') {
      const snapshot = validateAccountSnapshot(
        await accounts.source.read(partition, [id]),
        partition,
        [id],
        obligation,
      );
      if (snapshot.accounts.length)
        selected.set('account', registry.key({ owner: 'accounts', kind: 'account', route, id }));
    }
    if (!selected.size) throw new Error('Native repair anchor has no owner key or retained physical copy');
    if (selected.size > 100) throw new Error('Discovery repair exceeds its bounded keyed action window');
    const actions: DiscoveryIndexAction[] = [];
    // A native row has one current kind. Each retained old kind is a separate keyed delete,
    // never an invented second native row or a registry-wide kind traversal.
    for (const key of selected.values()) actions.push(...(await prepareChunk(partition, key.owner, [key], obligation)));
    if (actions.length !== selected.size) throw new Error('Native repair could not retain every keyed action');
    return actions;
  }
  async function applyRepair(actions: readonly DiscoveryIndexAction[]) {
    if (actions.length < 1 || actions.length > 100) throw new RangeError('Invalid retained mixed repair window');
    return applyActions(actions, true, true);
  }
  /** Translate the existing Content refresh; no alternate native read or eligibility owner. */
  async function prepareReviews(refresh: ReviewDiscoveryRefresh, ids: readonly string[]) {
    if (ids.length > 100 || new Set(ids).size !== ids.length) throw new RangeError('Invalid review receiving batch');
    const requested = new Set(ids);
    const seen = new Set<string>();
    const records = refresh.reviews.map((row) => {
      if (!requested.has(row.id) || seen.has(row.id)) throw new TypeError('Unrequested review receiving row');
      seen.add(row.id);
      const route = routeOf(row.id);
      if (route === null || discoveryPartition(row.id) !== refresh.partition || routeOf(row.subjectId) === null)
        throw new TypeError('Foreign review receiving row');
      // Reuse the leaf's native field validation and excerpt cap.
      const doc = reviewDiscoveryDocument(refresh.partition, refresh.nativePosition, {
        id: row.id,
        route,
        sourceVersion: row.sourceVersion,
        openingRevisionId: row.revisionId,
        title: row.title,
        text: row.excerpt ?? '',
      });
      return {
        key: { owner: 'content' as const, kind: 'review' as const, id: row.id, route },
        revision: refresh.nativePosition,
        names: doc.title === null ? [] : [doc.title],
        descriptions: [doc.text],
        nameSort: doc.title,
      };
    });
    for (const id of refresh.removed) {
      if (!requested.has(id) || seen.has(id)) throw new TypeError('Invalid review receiving removal');
      seen.add(id);
    }
    if (seen.size !== requested.size) throw new TypeError('Review receiving refresh is incomplete');
    const actions = secondScopeDiscoveryDocumentActions(
      registry,
      {
        owner: 'content',
        snapshot: {
          partition: refresh.partition,
          position: refresh.nativePosition,
          complete: true,
          records,
        },
      },
      ids.map((id) => ({ owner: 'content', kind: 'review', id, route: routeOf(id)! })),
    );
    return prepareBoundedSortKeys(search, discoveryIndexName(target.prefix, target.generation), actions);
  }
  async function applyReviews(
    actions: readonly SecondScopeDiscoveryIndexAction[],
    held: { client: PoolClient; index: string; acknowledge(): Promise<void> },
  ) {
    if (
      actions.length > 100 ||
      actions.some((action) => {
        const key = parseDiscoveryDocumentKey(registry, action.id);
        return key.owner !== 'content' || key.kind !== 'review';
      })
    )
      throw new TypeError('Invalid review receiving actions');
    await applyActions(actions, true, false, held);
  }
  return { project, prepareRepair, applyRepair, prepareReviews, applyReviews, registry, target, listing };
}

/** Terminal work is located from Search's own copy inventory, never inferred from a missing source. */
export async function eraseDiscoveryAccount(
  pool: Pool,
  search: OpenSearch,
  registry: DiscoveryRegistry,
  accountId: string,
  inputLimit = 100,
) {
  const route = routeOf(accountId);
  if (route === null) throw new TypeError('Invalid erasure Account key');
  if (!Number.isInteger(inputLimit) || inputLimit < 1 || inputLimit > 100)
    throw new RangeError('Invalid erasure copy limit');
  const copies = await withConnection(pool, async (client) => {
    if (!(await readErasureStatus(client, accountId))) return null;
    return (
      await client.query<DiscoveryTarget & { position: string; state: string }>(
        `SELECT c.prefix,c.generation::float8 AS generation,
      g.index_uuid AS uuid,g.incarnation::text,c.position::text,g.state FROM search.discovery_copy c
      JOIN search.discovery_generation g ON g.partition_no=0 AND g.prefix=c.prefix AND g.generation=c.generation
      WHERE c.route=$1 AND c.source_id=$2 AND c.kind='account' ORDER BY c.prefix,c.generation LIMIT $3`,
        [route, accountId, inputLimit],
      )
    ).rows;
  });
  if (copies === null) return;
  for (const target of copies) {
    await locateAccount(pool, target, { owner: 'accounts', kind: 'account', route, id: accountId });
    await withDiscoveryTarget(
      pool,
      search,
      target,
      async (client, index) => {
        const {
          rows: [head],
        } = await client.query<{ position: string }>(
          'SELECT position::text FROM core.partition WHERE partition_no=$1',
          [partitionOf(route)],
        );
        if (!head || BigInt(head.position) < BigInt(target.position))
          throw new Error('Erasure source position rewound');
        await writeDiscoveryActions(search, registry, index, [
          {
            op: 'delete',
            id: discoveryDocumentId(registry, { owner: 'accounts', kind: 'account', route, id: accountId }),
            version: BigInt(head.position),
          },
        ]);
        const merged = await search.request<{ _shards?: { failed?: number } }>(
          'POST',
          `/${index}/_forcemerge`,
          undefined,
          { query: { only_expunge_deletes: true } },
        );
        validateRefreshResponse(merged.status, merged.body);
        const cleared = await search.request('POST', `/${index}/_cache/clear`);
        validateRefreshResponse(cleared.status, cleared.body);
      },
      true,
    );
    await withConnection(pool, (client) =>
      client.query(
        "DELETE FROM search.discovery_copy WHERE route=$1 AND source_id=$2 AND prefix=$3 AND generation=$4 AND kind='account'",
        [route, accountId, target.prefix, target.generation],
      ),
    );
    await resolveLateErasureItem({ pool }, { accountId, participant: 'search', locator: copyLocator(target) });
  }
  if (copies.length === inputLimit) return; // A bounded page is never an all-copy acknowledgement.
  // All-copy Search participation owns the final ACK, including Source and retained snapshots.
}

/** A physically deleted generation may still own an open erasure locator. */
export async function registerRetiredErasure(pool: Pool, target: DiscoveryTarget, accountId: string) {
  return runCommand(pool, { partition: discoveryPartition(accountId) }, async (tx) => {
    await tx.query('INSERT INTO search.discovery_erasure(route,account_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [
      routeOf(accountId),
      accountId,
    ]);
    await recordLateErasureItem(tx, { accountId, participant: 'search', locator: copyLocator(target) });
    return {
      value: true,
      events: [{ type: 'com.rezics.access.account-updated.v1', subject: accountId, data: { accountId } }],
    };
  });
}
