import type { Pool } from 'pg';
import { authoritativeTimeValue, releaseOperationalTime, type AuthoritativeTime } from '../command/command.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { readPartition } from '../partition/partition.ts';
import {
  CONTEXT_GLOBAL_ID,
  contextAccess,
  type ContextAccessPort,
  ContextDirectoryPreparingError,
  type ContextAccessHandle,
  type ContextActor,
  type ContextDirectoryEntry,
  type ContextQueryClient,
} from './context-access-port.ts';

export type NativeContextMetadata = ContextDirectoryEntry & {
  version: string;
  epoch: number;
  owners: string[];
  actorOwner: boolean;
};

/** Each Source snapshot is released before any foreign Account checkout, including pool max=1. */
export async function readNativeContextMetadata(
  pool: Pool,
  ids: readonly string[],
  actor: ContextActor,
  at: string,
  deadline: number,
  accessPort?: ContextAccessPort,
): Promise<NativeContextMetadata[]> {
  if (!ids.length) return [];
  if (ids.length > 100 || new Set(ids).size !== ids.length) throw new RangeError('Context metadata page bound');
  const port = accessPort ?? contextAccess();
  const homes = new Map<number, string[]>();
  for (const id of ids) {
    const route = routeOf(id);
    if (route === null) continue;
    const home = partitionOf(route);
    homes.set(home, [...(homes.get(home) ?? []), id]);
  }
  const rows: NativeContextMetadata[] = [];
  for (const [home, keys] of homes) {
    rows.push(
      ...(await port.withReadTransaction(pool, async (connection) => {
        const tx = port.deadlineClient(connection, deadline);
        const owner = await readPartition(tx, home);
        if (!owner || owner.writeState !== 'active') throw new ContextDirectoryPreparingError();
        const native = await tx.query<Omit<NativeContextMetadata, 'epoch' | 'owners' | 'actorOwner'>>(
          `SELECT context_id::text AS id,kind,labels,state,
           CASE WHEN state='deleted' THEN to_char(deleted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS "deletedAt",
           CASE WHEN state='deleted' THEN to_char(purge_after AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS "purgeAfter",
           security_revision::text AS version
         FROM semantic.context WHERE (route,context_id) IN (SELECT * FROM unnest($1::int[],$2::uuid[]))
           AND (state='active' OR (state='deleted' AND $3::timestamptz<purge_after))`,
          [keys.map((id) => routeOf(id)!), keys, at],
        );
        const grants = await tx.query<{ id: string; account: string }>(
          `SELECT resource_id::text AS id,subject_id::text AS account FROM access.resource_role_grant
         WHERE (route,resource_id) IN (SELECT * FROM unnest($1::int[],$2::uuid[]))
           AND subject_kind='identity' AND subject_role='' AND grant_role='semantic.context.owner'
           AND valid @> $3::timestamptz ORDER BY resource_id,subject_id LIMIT 101`,
          [keys.map((id) => routeOf(id)!), keys, at],
        );
        if (grants.rows.length > 100) throw new ContextDirectoryPreparingError();
        return native.rows.map((row) => ({
          ...row,
          epoch: owner.epoch,
          owners: grants.rows.filter((g) => g.id === row.id).map((g) => g.account),
          actorOwner:
            actor.kind === 'account' && grants.rows.some((g) => g.id === row.id && g.account === actor.accountId),
        }));
      })),
    );
  }
  return rows;
}

async function activeOwners(
  pool: Pool,
  rows: NativeContextMetadata[],
  deadline: number,
  port: ContextAccessPort,
) {
  const groups = new Map<number, string[]>();
  for (const id of new Set(rows.flatMap((row) => row.owners))) {
    const home = partitionOf(routeOf(id)!);
    groups.set(home, [...(groups.get(home) ?? []), id]);
  }
  const active = new Set<string>();
  for (const [home, ids] of groups) {
    for (let offset = 0; offset < ids.length; offset += 100) {
      const keys = ids.slice(offset, offset + 100);
      await port.withReadTransaction(pool, async (connection) => {
        const tx = port.deadlineClient(connection, deadline);
        const owner = await readPartition(tx, home);
        if (!owner || owner.writeState !== 'active') throw new ContextDirectoryPreparingError();
        const accounts = await tx.query<{ id: string }>(
          `SELECT account_id::text AS id FROM access.account
           WHERE (route,account_id) IN (SELECT * FROM unnest($1::int[],$2::uuid[]))
           AND state='active' AND NOT authn_fenced`,
          [keys.map((id) => routeOf(id)!), keys],
        );
        for (const account of accounts.rows) active.add(account.id);
      });
    }
  }
  return active;
}

/** A candidate key is never an allow. Use the mounted Access formula, exact native rows and live owners.
 * Public eligibility is the same existing Context floor, including for an eligible retained tombstone.
 */
export async function authorizedContextMetadata(
  deps: { pool: Pool; access: ContextAccessHandle },
  input: {
    ids: readonly string[];
    actor: ContextActor;
    deadline: number;
    expected?: ReadonlyMap<string, { version: string; epoch: number }>;
  },
  accessPort?: ContextAccessPort,
): Promise<ContextDirectoryEntry[]> {
  if (!input.ids.length) return [];
  const port = accessPort ?? contextAccess();
  const context = { pool: deps.pool, deadline: input.deadline };
  const decisions = await port.prepareReadDecisions(deps.access, {
    actor: input.actor,
    actions: new Set(['context:read', 'context:delete', 'context:restore']),
    context,
  });
  const time = port.viewerActionReadTime(deps.access, context);
  try {
    const at = authoritativeTimeValue(time);
    const first = await readNativeContextMetadata(deps.pool, input.ids, input.actor, at, input.deadline, port);
    for (const row of first) {
      const expected = input.expected?.get(row.id);
      if (expected && (expected.version !== row.version || expected.epoch !== row.epoch))
        throw new ContextDirectoryPreparingError();
    }
    const owners = await activeOwners(deps.pool, first, input.deadline, port);
    const byId = new Map(first.map((row) => [row.id, row]));
    // Final native metadata/grant/current formula revalidation occurs after all foreign anchors are released.
    const final = await readNativeContextMetadata(deps.pool, input.ids, input.actor, at, input.deadline, port);
    const result: ContextDirectoryEntry[] = [];
    const groups = new Map<number, NativeContextMetadata[]>();
    for (const row of final) {
      const before = byId.get(row.id);
      if (
        !before ||
        before.version !== row.version ||
        before.epoch !== row.epoch ||
        JSON.stringify(before.owners) !== JSON.stringify(row.owners)
      )
        continue;
      if (row.kind === 'community' && !row.owners.some((id) => owners.has(id))) continue;
      const home = partitionOf(routeOf(row.id)!);
      groups.set(home, [...(groups.get(home) ?? []), row]);
    }
    for (const [home, rows] of groups) {
      await port.withReadTransaction(deps.pool, async (connection) => {
        const tx = port.deadlineClient(connection, input.deadline);
        const owner = await readPartition(tx, home);
        if (!owner || owner.writeState !== 'active' || rows.some((row) => row.epoch !== owner.epoch))
          throw new ContextDirectoryPreparingError();
        const current = await tx.query<{ id: string; version: string }>(
          `SELECT context_id::text AS id,security_revision::text AS version FROM semantic.context
           WHERE (route,context_id) IN (SELECT * FROM unnest($1::int[],$2::uuid[]))
             AND (state='active' OR (state='deleted' AND $3::timestamptz<purge_after))`,
          [rows.map((row) => routeOf(row.id)!), rows.map((row) => row.id), at],
        );
        const grants = await tx.query<{ id: string; account: string }>(
          `SELECT resource_id::text AS id,subject_id::text AS account FROM access.resource_role_grant
           WHERE (route,resource_id) IN (SELECT * FROM unnest($1::int[],$2::uuid[]))
             AND subject_kind='identity' AND subject_role='' AND grant_role='semantic.context.owner'
             AND valid @> $3::timestamptz ORDER BY resource_id,subject_id LIMIT 101`,
          [rows.map((row) => routeOf(row.id)!), rows.map((row) => row.id), at],
        );
        if (grants.rows.length > 100) throw new ContextDirectoryPreparingError();
        const ids = rows.map((row) => row.id);
        const read = await decisions.decide(
          tx,
          {
            action: 'context:read',
            resourceType: 'semantic.context',
            ids,
            eligibility: async () => Object.fromEntries(ids.map((id) => [id, true])),
          },
          time,
        );
        const deleted = rows.filter((row) => row.state === 'deleted');
        const restore = deleted.length
          ? await decisions.decide(
              tx,
              {
                action: 'context:restore',
                resourceType: 'semantic.context',
                ids: deleted.map((row) => row.id),
              },
              time,
            )
          : {};
        const nativeActions = await contextNativeActions(tx, ids, input.actor, time);
        for (const row of rows) {
          // A grant change after the released Account anchors invalidates this row's prepared evidence.
          const currentOwners = grants.rows.filter((grant) => grant.id === row.id).map((grant) => grant.account);
          if (JSON.stringify(currentOwners) !== JSON.stringify(row.owners)) continue;
          if (!nativeActions[row.id]?.includes('context:read')) continue;
          if (!current.rows.some((r) => r.id === row.id && r.version === row.version) || !read[row.id]?.allowed)
            continue;
          if (row.state === 'deleted' && (!row.actorOwner || row.id === CONTEXT_GLOBAL_ID || !restore[row.id]?.allowed))
            continue;
          const { id, kind, labels, state, deletedAt, purgeAfter } = row;
          result.push({ id, kind, labels, state, deletedAt, purgeAfter });
        }
      });
    }
    port.requireDeadline(input.deadline);
    return result;
  } finally {
    releaseOperationalTime(time);
  }
}

/** Shared native lifecycle constraints for viewerActions. Access still decides every action. */
export async function contextNativeActions(
  client: ContextQueryClient,
  ids: readonly string[],
  actor: ContextActor,
  time: AuthoritativeTime,
): Promise<Readonly<Record<string, readonly string[]>>> {
  const at = authoritativeTimeValue(time);
  const rows = await client.query<{ id: string; kind: string; state: string; restorable: boolean; owner: boolean }>(
    `SELECT context_id::text AS id,kind,state,($3::timestamptz<purge_after) AS restorable,
       EXISTS(SELECT 1 FROM access.resource_role_grant g WHERE g.route=c.route AND g.resource_id=c.context_id
         AND g.subject_kind='identity' AND g.subject_id=$4::uuid AND g.subject_role=''
         AND g.grant_role='semantic.context.owner' AND g.valid @> $3::timestamptz) AS owner
     FROM semantic.context c WHERE (route,context_id) IN (SELECT * FROM unnest($1::int[],$2::uuid[]))`,
    [ids.map((id) => routeOf(id)!), [...ids], at, actor.kind === 'account' ? actor.accountId : null],
  );
  return Object.fromEntries(
    rows.rows.map((row) => [
      row.id,
      row.kind === 'global' && row.id === CONTEXT_GLOBAL_ID && row.state === 'active'
        ? ['context:read', 'context:create']
        : row.state === 'active'
          ? ['context:read', ...(row.owner ? ['context:delete'] : [])]
          : row.state === 'deleted' && row.restorable && row.owner
            ? ['context:read', 'context:restore']
            : [],
    ]),
  );
}
