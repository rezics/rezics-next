import type { Pool, PoolClient } from 'pg';
import { withConnection, discardConnection } from '../database/pool.ts';
import { noEffect, runCommand } from '../command/command.ts';
import { activeRelease } from '../semantic/definitions.ts';
import type { FilterRelease } from '@rezics/filter';
import {
  accountDiscoverySource,
  readAccountDiscoveryBindings,
} from '../access/account-discovery-source.ts';
import { redriveAccountDiscovery } from '../access/account-discovery-work.ts';
import { readErasureStatus, recordLateErasureItem, resolveLateErasureItem } from '../access/erasure.ts';
import type { DiscoveryIndexAction, DiscoveryKey, DiscoveryRegistry } from './discovery.ts';
import type { SubjectListingSource } from './source.ts';
import type { OpenSearch } from './opensearch.ts';
import { createNativeDiscoveryRegistry } from './discovery-hydration.ts';
import { discoveryDocumentActions, discoveryDocumentId, parseDiscoveryDocumentId } from './discovery-documents.ts';
import { discoveryIndexName, discoveryIndexUuid } from './indices.ts';
import { writeDiscoveryActions, validateRefreshResponse } from './write-actions.ts';
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
  options?: { release: FilterRelease; languages?: readonly string[] },
) {
  const release = options?.release ?? (await activeRelease(pool))?.release;
  if (!release) throw new Error('Discovery requires an active definition release');
  return createNativeDiscoveryRegistry({
    pool,
    routeKey,
    release,
    languages: options?.languages,
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
  async function project(
    partition: number,
    input: readonly DiscoveryKey[],
    atLeast = 0n,
    repair = false,
  ): Promise<void> {
    const unique = new Map(
      input.map((key) => {
        const checked = registry.key(key);
        return [discoveryDocumentId(registry, checked), checked];
      }),
    );
    const keys = [...unique.values()];
    if (keys.some((key) => discoveryPartition(key.id) !== partition)) throw new RangeError('Foreign discovery key');
    for (const owner of ['semantic', 'accounts'] as const) {
      const owned = keys.filter((key) => key.owner === owner);
      const limit = owner === 'accounts' ? 100 : 256;
      for (let offset = 0; offset < owned.length; offset += limit) {
        const chunk = owned.slice(offset, offset + limit),
          ids = chunk.map(({ id }) => id);
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
            snapshot.subjects
              .filter((row) => row.visibility === 'visible' && row.redirect === null)
              .map(({ id }) => id),
          );
          const kinds = new Map(chunk.map((key) => [key.id, key.kind]));
          const keyedSnapshot = {
            ...snapshot,
            subjects: snapshot.subjects.filter((row) => kinds.get(row.id) === row.type),
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
        actions = await prepareBoundedSortKeys(search, discoveryIndexName(target.prefix, target.generation), actions);
        await withDiscoveryTarget(pool, search, target, async (client, index) => {
          const pending: DiscoveryIndexAction[] = [];
          for (const action of actions) {
            const key = parseDiscoveryDocumentId(registry, action.id),
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
              (BigInt(old.position) > action.version ||
                (BigInt(old.position) === action.version && old.settled && !repair))
            )
              continue;
            await client.query(
              `INSERT INTO search.discovery_copy(route,source_id,prefix,generation,kind,position,revision,deleted,settled)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,false) ON CONFLICT(route,source_id,prefix,generation,kind)
              DO UPDATE SET position=EXCLUDED.position,revision=GREATEST(search.discovery_copy.revision,EXCLUDED.revision),deleted=EXCLUDED.deleted,settled=false`,
              [...values, action.version.toString(), revision.toString(), action.op === 'delete'],
            );
            pending.push(action);
          }
          await writeDiscoveryActions(search, registry, index, pending);
          for (const action of pending) {
            const key = parseDiscoveryDocumentId(registry, action.id);
            await client.query(
              `UPDATE search.discovery_copy SET settled=true WHERE route=$1 AND source_id=$2 AND prefix=$3 AND generation=$4 AND kind=$5 AND position=$6`,
              [key.route, key.id, target.prefix, target.generation, key.kind, action.version.toString()],
            );
          }
        });
      }
    }
  }
  return { project, registry, target, listing };
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
