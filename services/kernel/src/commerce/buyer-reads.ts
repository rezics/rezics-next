import type { Pool } from 'pg';
import { deadlineClient } from '../access/authenticate.ts';
import { CommandUnavailableError, requireAccessDeadline } from '../access/unavailable.ts';
import { withConnection } from '../database/pool.ts';
import { readSubjectSummaries } from '../semantic/summaries.ts';
import { ProblemError } from '../http/problem.ts';
import type { Access, AccessCheck, AccessClient, AccountActor } from '../request/access.ts';
import { readPartition } from '../partition/partition.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { decodeCursor, encodeCursor } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { SessionComponent } from '../tokens/session.ts';
import * as store from './store.ts';

type BuyerReadContext = {
  pool: Pool;
  routeKey: Uint8Array;
  access: Access;
  actor: AccountActor;
  check: AccessCheck;
  deadline: number;
  seen: readonly SessionComponent[];
};

type BuyerListInput = BuyerReadContext & {
  tokens: KeyRing;
  cursor?: string;
  limit?: number;
};

type BuyerPointInput = BuyerReadContext & { id: string };

type Snapshot<T> = { value: T; epoch: number };

/** Run the existing native owner formula and active-home/session fences around a bounded read. */
async function buyerSnapshot<T>(
  input: BuyerReadContext,
  denied: 'forbidden' | 'not_found',
  cursorEpoch: number | undefined,
  read: (client: AccessClient) => Promise<T>,
): Promise<Snapshot<T>> {
  const route = routeOf(input.actor.accountId)!;
  const home = partitionOf(route);
  requireAccessDeadline(input.deadline);
  return withConnection(input.pool, async (connection) => {
    const client = deadlineClient(connection, input.deadline);
    const currentHome = async () => {
      const partition = await readPartition(client, home);
      if (!partition || partition.writeState !== 'active')
        throw new CommandUnavailableError(
          partition?.writeState === 'moved' ? 'moved' : 'fenced',
          home,
          partition?.movedTo,
        );
      if (cursorEpoch !== undefined && cursorEpoch !== partition.epoch) throw new ProblemError('stale_cursor');
      const seen = input.seen.find((entry) => entry.partition === home);
      if (
        seen &&
        (seen.epoch > partition.epoch || (seen.epoch === partition.epoch && seen.position > partition.position))
      )
        throw new CommandUnavailableError('fenced', home);
      return partition;
    };

    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    let committed = false;
    try {
      if (!(await input.check(client))) throw new ProblemError(denied);
      await currentHome();
      const value = await read(client);
      await client.query('COMMIT');
      committed = true;

      // Authorization and the source fence are repeated outside the source snapshot.
      if (!(await input.check(client))) throw new ProblemError(denied);
      const partition = await currentHome();
      requireAccessDeadline(input.deadline);
      return { value, epoch: partition.epoch };
    } catch (error) {
      if (!committed) await connection.query('ROLLBACK');
      throw error;
    }
  });
}

function listCursor(input: BuyerListInput, operation: 'order.list' | 'entitlement.list') {
  const route = routeOf(input.actor.accountId)!;
  const binding = { operation, parameters: { accountId: input.actor.accountId } };
  let after: string | null = null;
  let epoch: number | undefined;
  if (input.cursor !== undefined) {
    const cursor = decodeCursor(input.tokens, binding, input.cursor);
    if (
      !cursor.ok ||
      cursor.after.length !== 1 ||
      typeof cursor.after[0] !== 'string' ||
      routeOf(cursor.after[0]) !== route
    )
      throw new ProblemError('invalid_cursor');
    after = cursor.after[0];
    epoch = cursor.epoch;
  }
  return { binding, after, epoch };
}

export async function listBuyerOrders(input: BuyerListInput) {
  const route = routeOf(input.actor.accountId)!;
  const size = input.limit ?? 20;
  const { binding, after, epoch } = listCursor(input, 'order.list');
  const page = await buyerSnapshot(input, 'forbidden', epoch, (client) =>
    store.listBuyerOrders(client, route, input.actor.accountId, { after, limit: size + 1 }),
  );
  const shown = page.value.slice(0, size);
  const current = await buyerSnapshot(input, 'forbidden', epoch, (client) =>
    store.readBuyerOrdersCurrent(
      client,
      route,
      input.actor.accountId,
      shown.map((order) => order.id),
    ),
  );
  const byId = new Map(current.value.map((order) => [order.id, order]));
  const orders = shown.flatMap((order) => {
    const refreshed = byId.get(order.id);
    return refreshed ? [refreshed] : [];
  });
  const last = shown.at(-1);
  requireAccessDeadline(input.deadline);
  return {
    orders,
    next:
      page.value.length > size && last
        ? encodeCursor(input.tokens, binding, { epoch: current.epoch, after: [last.id] })
        : null,
  };
}

export async function readBuyerOrder(input: BuyerPointInput & { languages?: readonly string[] }) {
  const route = routeOf(input.actor.accountId)!;
  const initial = await buyerSnapshot(input, 'not_found', undefined, (client) =>
    store.readBuyerOrderForAccount(client, route, input.id, input.actor.accountId),
  );
  if (!initial.value) throw new ProblemError('not_found');

  const summaries = await readSubjectSummaries(
    {
      pool: input.pool,
      routeKey: input.routeKey,
      access: input.access,
      actor: input.actor,
      deadline: input.deadline,
    },
    [initial.value.order.targetSubjectId],
    input.languages === undefined ? {} : { languages: input.languages },
  );

  // The summary uses a foreign source. Refresh mutable payment and entitlement presentation afterward.
  const current = await buyerSnapshot(input, 'not_found', undefined, (client) =>
    store.readBuyerOrderForAccount(client, route, input.id, input.actor.accountId),
  );
  if (!current.value) throw new ProblemError('not_found');
  return {
    ...current.value,
    subject: summaries.get(current.value.order.targetSubjectId) ?? null,
  };
}

export async function listBuyerEntitlements(input: BuyerListInput) {
  const route = routeOf(input.actor.accountId)!;
  const size = input.limit ?? 20;
  const { binding, after, epoch } = listCursor(input, 'entitlement.list');
  const page = await buyerSnapshot(input, 'forbidden', epoch, (client) =>
    store.listBuyerEntitlements(client, route, input.actor.accountId, { after, limit: size + 1 }),
  );
  const shown = page.value.slice(0, size);
  const summaries = await readSubjectSummaries(
    {
      pool: input.pool,
      routeKey: input.routeKey,
      access: input.access,
      actor: input.actor,
      deadline: input.deadline,
    },
    shown.map((entitlement) => entitlement.targetSubjectId),
  );
  const current = await buyerSnapshot(input, 'forbidden', epoch, (client) =>
    store.readBuyerEntitlementsCurrent(
      client,
      route,
      input.actor.accountId,
      shown.map((entitlement) => entitlement.id),
    ),
  );
  const byId = new Map(current.value.map((entitlement) => [entitlement.id, entitlement]));
  const entitlements = shown.flatMap((entitlement) => {
    const refreshed = byId.get(entitlement.id);
    return refreshed ? [refreshed] : [];
  });
  const last = shown.at(-1);
  requireAccessDeadline(input.deadline);
  return {
    entitlements,
    summaries,
    next:
      page.value.length > size && last
        ? encodeCursor(input.tokens, binding, { epoch: current.epoch, after: [last.id] })
        : null,
  };
}

export async function readBuyerEntitlement(input: BuyerPointInput) {
  const route = routeOf(input.actor.accountId)!;
  const initial = await buyerSnapshot(input, 'not_found', undefined, (client) =>
    store.readBuyerEntitlementForAccount(client, route, input.id, input.actor.accountId),
  );
  if (!initial.value) throw new ProblemError('not_found');
  const summaries = await readSubjectSummaries(
    {
      pool: input.pool,
      routeKey: input.routeKey,
      access: input.access,
      actor: input.actor,
      deadline: input.deadline,
    },
    [initial.value.targetSubjectId],
  );
  const current = await buyerSnapshot(input, 'not_found', undefined, (client) =>
    store.readBuyerEntitlementForAccount(client, route, input.id, input.actor.accountId),
  );
  if (!current.value) throw new ProblemError('not_found');
  return {
    entitlement: current.value,
    summary: summaries.get(current.value.targetSubjectId) ?? null,
  };
}
