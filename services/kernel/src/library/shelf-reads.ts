import { createHash } from 'node:crypto';
import { shareAccount } from '../access/account-share.ts';
import { resourceAuthorization } from '../access/resource-authorization.ts';
import { noEffect, principalCommandIdentity, runCommand } from '../command/command.ts';
import { readAccount } from '../access/account-data.ts';
import { deadlineClient } from '../access/authenticate.ts';
import { CommandUnavailableError } from '../access/unavailable.ts';
import { ProblemError } from '../http/problem.ts';
import { readPartition } from '../partition/partition.ts';
import { accessCheck, AuthenticationError, type AccountActor, type Actor } from '../request/access.ts';
import { deadlineFor, withRequestDeadline } from '../request/deadline.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { withReadTransaction } from '../semantic/read.ts';
import { admitShelfRead } from './shelf-admission.ts';
import { WORK_STEP_DEADLINE_MS } from './command-support.ts';
import { shelfNeedsInitialization } from './shelf-reader-generation.ts';
import {
  DEFAULT_SHELF_PAGE_SIZE,
  MAX_SHELF_PAGE_SIZE,
  SHELF_DIRECTIONS,
  SHELF_ORDERS,
  SHELF_TYPE_RESPONSE_BYTES,
  isShelfEntryState,
  normalizeShelfQuery,
  shelfCursorBinding,
  shelfTypeCursorBinding,
  type ShelfCursorBinding,
  type ShelfOrder,
  type ShelfReadDependencies,
  type ShelfReads,
  type ShelfSeek,
} from './shelf-contract.ts';
import { shelfScoreBinding, validShelfScoreKey } from './shelf-score.ts';
import { validShelfPriorityKey } from './entry-priority-page.ts';
import { ShelfReadUnavailableError } from './shelf-reader-unavailable.ts';

function owner(actor: Actor, progress: boolean): AccountActor {
  if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
  if (
    routeOf(actor.accountId) === null ||
    !actor.scopes.includes('library_entry:list') ||
    (progress && !actor.scopes.includes('progress_session:list'))
  )
    throw new ProblemError('forbidden');
  return actor;
}

function input(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    throw new ProblemError('invalid_argument');
  return value as Record<string, unknown>;
}

function page(value: Record<string, unknown>) {
  const limit = value.limit ?? DEFAULT_SHELF_PAGE_SIZE;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_SHELF_PAGE_SIZE)
    throw new ProblemError('invalid_argument');
  if (
    value.cursor !== undefined &&
    (typeof value.cursor !== 'string' || value.cursor.length === 0 || value.cursor.length > 4096)
  )
    throw new ProblemError('invalid_cursor');
  return { limit, ...(value.cursor === undefined ? {} : { cursor: value.cursor as string }) };
}

function publicType(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]*:[\x21-\x7e]+$(?![\s\S])/.test(value))
    throw new ProblemError('invalid_argument');
  return value;
}

// Validate exact timestamp strings without passing them through Date or losing microseconds.
function timestamp(value: string): boolean {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-](\d{2})(?::?(\d{2}))?)$(?![\s\S])/.exec(
      value,
    );
  if (!match) return false;
  const [year, month, day, hour, minute, second, zoneH, zoneM] = match.slice(1).map(Number);
  const leap = year! % 4 === 0 && (year! % 100 !== 0 || year! % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return (
    year! > 0 &&
    month! >= 1 &&
    month! <= 12 &&
    day! >= 1 &&
    day! <= days[month! - 1]! &&
    hour! < 24 &&
    minute! < 60 &&
    second! < 60 &&
    (Number.isNaN(zoneH) || zoneH! < 16) &&
    (Number.isNaN(zoneM) || zoneM! < 60)
  );
}

export function createShelfReads(deps: ShelfReadDependencies): ShelfReads {
  async function snapshot<T>(
    actor: Actor,
    progress: boolean,
    read: (
      client: Parameters<ShelfReadDependencies['typeKeys']['lookup']>[0],
      route: number,
      accountId: string,
      epoch: number,
      generationBinding: { generationId: string; ownerEpoch: string },
    ) => Promise<T>,
  ): Promise<T> {
    const account = owner(actor, progress);
    const route = routeOf(account.accountId)!;
    const deadline = deadlineFor(WORK_STEP_DEADLINE_MS);
    return withRequestDeadline(deadline, async () => {
      if (progress) await admitShelfRead(deps, actor, deadline);
      const resource = { route, id: account.accountId };
      // Actual installed Access evidence is prepared before checkout; a caller-constructed Actor cannot pass it.
      const check = await accessCheck(deps.access, actor, 'library_entry:list', resource, {
        pool: deps.pool,
        deadline,
      });
      async function admitted(client: Parameters<typeof readAccount>[0]) {
        const current = await readAccount(client, route, account.accountId);
        if (
          !current ||
          current.kind !== 'actor' ||
          current.state !== 'active' ||
          current.fenced ||
          !Number.isSafeInteger(account.authnEpoch) ||
          account.authnEpoch < 1 ||
          current.minimumAuthnEpoch > BigInt(account.authnEpoch) ||
          !(await check(client))
        )
          throw new ProblemError('forbidden');
        const partitionNo = partitionOf(route);
        const partition = await readPartition(client, partitionNo);
        if (!partition) throw new CommandUnavailableError('deadline', partitionNo);
        if (partition.writeState === 'moved')
          throw new CommandUnavailableError('moved', partitionNo, partition.movedTo);
        return partition;
      }
      const shelfOwner = { route, accountId: account.accountId };
      // Release the bounded probe before an owner command and before the final RR checkout. No readiness cache.
      if (
        deps.maintenance &&
        (await withReadTransaction(deps.pool, async (connection) => {
          const client = deadlineClient(connection, deadline);
          await admitted(client);
          return shelfNeedsInitialization(client, shelfOwner);
        }))
      ) {
        const maintenance = deps.maintenance;
        const authorization = resourceAuthorization({
          access: deps.access,
          actor,
          action: 'library_entry:list',
          anchor: {
            resource,
            async validate(client) {
              await shareAccount(client, account.accountId);
              const current = await readAccount(client, route, account.accountId);
              return (
                !!current &&
                current.kind === 'actor' &&
                current.state === 'active' &&
                !current.fenced &&
                Number.isSafeInteger(account.authnEpoch) &&
                account.authnEpoch >= 1 &&
                current.minimumAuthnEpoch <= BigInt(account.authnEpoch)
              );
            },
          },
          context: { pool: deps.pool, deadline, partition: partitionOf(route) },
        });
        await runCommand(
          deps.pool,
          {
            ...principalCommandIdentity(account),
            partition: partitionOf(route),
            deadline,
            clock: deps.clock,
            authorization,
            receipt: {
              kind: 'library.shelf.initialize',
              key: account.accountId,
              digest: createHash('sha256').update(account.accountId).digest(),
            },
          },
          async (tx) => {
            const result = await maintenance.initialize(tx, shelfOwner);
            // initialize atomically rechecks after the gate lock, including a concurrent first reader/writer.
            if (!result.initializedNow) return noEffect(null);
            return {
              value: null,
              events: [
                {
                  type: 'com.rezics.library.shelf-maintenance.advanced.v1',
                  subject: account.accountId,
                  data: { accountId: account.accountId },
                },
              ],
            };
          },
        );
      }
      return withReadTransaction(deps.pool, async (connection) => {
        const client = deadlineClient(connection, deadline);
        const partition = await admitted(client);
        if (!deps.generation)
          throw new ShelfReadUnavailableError(
            'ShelfMaintenanceOps.initialize and native RR gate/current-generation reader',
          );
        const state = await deps.generation(client, { route, accountId: account.accountId });
        if (state.readiness !== 'ready' || state.activeGeneration === null || state.epoch < 0n)
          throw new ShelfReadUnavailableError('native complete shelf generation');
        return read(client, route, account.accountId, partition.epoch, {
          generationId: state.activeGeneration,
          ownerEpoch: state.epoch.toString(10),
        });
      });
    });
  }

  async function resolve(
    client: Parameters<ShelfReadDependencies['typeKeys']['lookup']>[0],
    route: number,
    accountId: string,
    type?: string,
  ) {
    if (type === undefined) return null;
    const typeId = await deps.typeKeys.lookup(client, route, accountId, type);
    if (typeId === null) throw new ProblemError('invalid_argument');
    return typeId;
  }

  async function decode(binding: ShelfCursorBinding, token: string | undefined, epoch: number) {
    if (token === undefined) return null;
    const position = await deps.cursors.decode(deps.tokens, binding, token, deps.clock());
    if (!position.ok) throw new ProblemError('invalid_cursor');
    if (position.epoch !== epoch) throw new ProblemError('stale_cursor');
    return position.after;
  }

  return {
    async listShelf(actor, raw) {
      owner(actor, true);
      const value = input(raw, ['state', 'type', 'orderBy', 'direction', 'limit', 'cursor']);
      if (
        !SHELF_ORDERS.includes(value.orderBy as ShelfOrder) ||
        (value.direction !== undefined && !SHELF_DIRECTIONS.includes(value.direction as 'asc' | 'desc')) ||
        (value.state !== undefined && (typeof value.state !== 'string' || !isShelfEntryState(value.state)))
      )
        throw new ProblemError('invalid_argument');
      if (value.orderBy === 'personalScore' && (actor.kind !== 'account' || !actor.scopes.includes('rating:vote')))
        throw new ProblemError('forbidden');
      const selected = page(value);
      const type = publicType(value.type);
      return snapshot(actor, true, async (client, route, accountId, epoch, generation) => {
        const typeId = await resolve(client, route, accountId, type);
        const query = normalizeShelfQuery({
          ...selected,
          state: (value.state as string | undefined) ?? null,
          typeId,
          orderBy: value.orderBy as ShelfOrder,
          direction: (value.direction as 'asc' | 'desc' | undefined) ?? 'desc',
        });
        const base = shelfCursorBinding(accountId, query);
        const score =
          query.orderBy === 'personalScore'
            ? await shelfScoreBinding(client, route, accountId, deps.scoreCurrentness)
            : null;
        const binding = { ...base, query: { ...base.query, ...generation, ...score?.binding } };
        const keys = await decode(binding, selected.cursor, epoch);
        let after: ShelfSeek | null = null;
        if (keys !== null) {
          if (
            keys.length !== 2 ||
            typeof keys[0] !== 'string' ||
            typeof keys[1] !== 'string' ||
            routeOf(keys[1]) === null ||
            !(query.orderBy === 'personalScore'
              ? validShelfScoreKey(keys[0])
              : query.orderBy === 'priority'
                ? validShelfPriorityKey(keys[0])
                : timestamp(keys[0]) || (query.orderBy === 'finishedAt' && keys[0] === ''))
          )
            throw new ProblemError('invalid_cursor');
          after = { key: keys[0], subjectId: keys[1] };
        }
        const result = await deps.pageReader.page(client, route, accountId, query, after);
        const last = result.entries.at(-1);
        const key =
          last &&
          (query.orderBy === 'personalScore'
            ? last.personalScore === null
              ? ''
              : String(last.personalScore)
            : query.orderBy === 'priority'
              ? last.priority === null
                ? ''
                : String(last.priority)
              : query.orderBy === 'lastActivity'
                ? last.lastActivityAt
                : query.orderBy === 'createdAt'
                  ? last.createdAt
                  : (last.finishedAt ?? ''));
        return {
          entries: result.entries,
          ...(score ? { scoreQuestion: score.question } : {}),
          next:
            result.more && last && key !== undefined
              ? await deps.cursors.encode(deps.tokens, binding, { epoch, after: [key, last.subjectId] }, deps.clock())
              : null,
        };
      });
    },
    async summary(actor, raw) {
      owner(actor, false);
      const value = input(raw, ['type']);
      const type = publicType(value.type);
      return snapshot(actor, false, async (client, route, accountId) =>
        deps.summaryReader.summary(client, route, accountId, await resolve(client, route, accountId, type)),
      );
    },
    async listTypes(actor, raw) {
      owner(actor, false);
      const selected = page(input(raw, ['cursor', 'limit']));
      return snapshot(actor, false, async (client, route, accountId, epoch, generation) => {
        const base = shelfTypeCursorBinding(accountId, selected.limit);
        const binding = { ...base, query: { ...base.query, ...generation } };
        const keys = await decode(binding, selected.cursor, epoch);
        if (keys !== null && (keys.length !== 1 || typeof keys[0] !== 'string' || routeOf(keys[0]) !== route))
          throw new ProblemError('invalid_cursor');
        const rows = await deps.facetReader.types(
          client,
          route,
          accountId,
          (keys?.[0] as string | undefined) ?? null,
          selected.limit,
          SHELF_TYPE_RESPONSE_BYTES,
        );
        return {
          types: rows.types,
          next:
            rows.more && rows.after
              ? await deps.cursors.encode(deps.tokens, binding, { epoch, after: [rows.after] }, deps.clock())
              : null,
        };
      });
    },
  };
}
