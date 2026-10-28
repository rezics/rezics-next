import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import { deadlineClient } from '../access/authenticate.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { endResourceDenial, recordResourceDenial } from '../access/resource-denials.ts';
import { authoritativeTimeValue, principalCommandIdentity, runCommand } from '../command/command.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import { accessCheck, accessCommandAuthorization, type AccountActor, type Actor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { decodeCursor, encodeCursor } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { WorkClient } from '../work/client.ts';
import { enqueueRealmRemoval } from './join.ts';
import { PublicationCursorError } from './publication.ts';
import type { SpaceDependencies } from './space.ts';
import openBan from './ban-open.sql';
import closeBan from './ban-close.sql';
import readRealm from './ban-realm.sql';
import pageBans from './ban-page.sql';
import readMembership from './membership-current.sql';
import readRole from './ban-role.sql';

export type BanDependencies = SpaceDependencies & { tokens: KeyRing; workClient: () => Promise<WorkClient> };
export type Ban = {
  realmId: string;
  accountId: string;
  reason: string;
  actor: string;
  at: string;
  workflowId: string | null;
};
type Context = { idempotencyKey: string; deadline: number };
type Target = { realmId: string; accountId: string };

export class RealmBanInputError extends Error {
  constructor() {
    super('Invalid Realm ban');
    this.name = 'RealmBanInputError';
  }
}

export class RealmBanRoleError extends Error {
  constructor() {
    super('Remove the Realm owner or moderator role first');
    this.name = 'RealmBanRoleError';
  }
}

function target(input: Target) {
  const route = routeOf(input.realmId);
  if (route === null || routeOf(input.accountId) === null) throw new RealmBanInputError();
  return { route, id: input.realmId };
}
function receipt(actor: AccountActor, kind: string, input: unknown, key: string) {
  return {
    kind,
    key,
    digest: createHash('sha256')
      .update(canonicalize([principalCommandIdentity(actor), kind, input])!)
      .digest(),
  };
}

/** Commit the Realm record and both identity denials at one authoritative T.
 * The receipted reservation lets a retry finish enqueueing after a lost response.
 */
export async function banAccount(
  deps: BanDependencies,
  actor: AccountActor,
  input: Target & { reason: string },
  context: Context,
) {
  const resource = target(input);
  if (typeof input.reason !== 'string' || [...input.reason].length > 1024 || input.reason.includes('\0'))
    throw new RealmBanInputError();
  const authorization = await accessCommandAuthorization(
    deps.access,
    actor,
    'realm:ban',
    resource,
    { pool: deps.pool, deadline: context.deadline },
    () => new GrantDeniedError(),
  );
  const result = await runCommand(
    deps.pool,
    {
      ...principalCommandIdentity(actor),
      partition: partitionOf(resource.route),
      deadline: context.deadline,
      clock: deps.clock,
      receipt: receipt(actor, 'community.realm.ban', input, context.idempotencyKey),
      authorization,
    },
    async (tx, command) => {
      const at = authoritativeTimeValue(command.time);
      const parameters = { route: resource.route, realm_id: input.realmId, account_id: input.accountId, at };
      const realm = await readRealm.run(tx, parameters);
      if (!realm) throw new GrantDeniedError();
      if ((await readRole.run(tx, parameters))?.protected) throw new RealmBanRoleError();
      const record = (
        await openBan.run(tx, {
          ...parameters,
          reason: input.reason,
          actor: actor.accountId,
          transaction_id: command.transactionId,
        })
      )[0];
      if (!record || record.at === null) throw new GrantDeniedError();
      for (const action of ['realm:join', 'realm:participate']) {
        await recordResourceDenial(tx, {
          resource,
          subjectId: input.accountId,
          subjectRole: '',
          action,
          reason: 'realm_ban',
          at: command.time,
        });
      }
      const membership = await readMembership.run(tx, parameters);
      const value = {
        realmId: input.realmId,
        accountId: input.accountId,
        ...record,
        at: record.at,
        spaceId: realm.spaceId,
        reservationId: membership?.reservationId ?? null,
      };
      return {
        value,
        events: [
          {
            type: 'com.rezics.community.realm.ban.v1',
            subject: input.realmId,
            data: {
              realmId: input.realmId,
              accountId: input.accountId,
              reason: record.reason,
              actor: record.actor,
              at,
              transactionId: command.transactionId,
            },
          },
        ],
      };
    },
  );
  const { spaceId, reservationId, transactionId, ...record } = result.value;
  const workflowId =
    reservationId === null
      ? null
      : (
          await enqueueRealmRemoval(
            {
              pool: deps.pool,
              access: deps.access,
              ...(deps.clock === undefined ? {} : { clock: deps.clock }),
              tokens: deps.tokens,
              client: await deps.workClient(),
            },
            {
              actor,
              realmId: input.realmId,
              spaceId,
              memberAccountId: input.accountId,
              reservationId,
              banId: transactionId,
              deadline: context.deadline,
            },
          )
        ).workflowId;
  return { ...result, value: { ...record, workflowId } satisfies Ban };
}

/** Ending a ban ends only its two denials; membership is never recreated. */
export async function unbanAccount(deps: BanDependencies, actor: AccountActor, input: Target, context: Context) {
  const resource = target(input);
  const authorization = await accessCommandAuthorization(
    deps.access,
    actor,
    'realm:ban',
    resource,
    { pool: deps.pool, deadline: context.deadline },
    () => new GrantDeniedError(),
  );
  return runCommand(
    deps.pool,
    {
      ...principalCommandIdentity(actor),
      partition: partitionOf(resource.route),
      deadline: context.deadline,
      clock: deps.clock,
      receipt: receipt(actor, 'community.realm.unban', input, context.idempotencyKey),
      authorization,
    },
    async (tx, command) => {
      const at = authoritativeTimeValue(command.time);
      const parameters = { route: resource.route, realm_id: input.realmId, account_id: input.accountId, at };
      if (!(await readRealm.run(tx, parameters))) throw new GrantDeniedError();
      await closeBan.run(tx, parameters);
      for (const action of ['realm:join', 'realm:participate']) {
        await endResourceDenial(tx, {
          resource,
          subjectId: input.accountId,
          subjectRole: '',
          action,
          reason: 'realm_ban',
          at: command.time,
        });
      }
      const value = { realmId: input.realmId, accountId: input.accountId, at, transactionId: command.transactionId };
      return {
        value,
        events: [{ type: 'com.rezics.community.realm.unban.v1', subject: input.realmId, data: value }],
      };
    },
  );
}

/** A single current-row keyset seek. History and other Realms cannot widen it. */
export async function listBans(
  deps: BanDependencies,
  actor: Actor,
  realmId: string,
  context: { deadline: number },
  query: { limit?: number; cursor?: string } = {},
) {
  const route = routeOf(realmId);
  if (route === null) throw new RealmBanInputError();
  const limit = query.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RealmBanInputError();
  const binding = {
    operation: 'community.realm.bans',
    parameters: { realmId, limit, viewer: actor.kind === 'account' ? actor.accountId : 'anonymous' },
  };
  let after = '00000000-0000-0000-0000-000000000000';
  let epoch: number | undefined;
  if (query.cursor !== undefined) {
    const decoded = decodeCursor(deps.tokens, binding, query.cursor);
    if (!decoded.ok) throw new PublicationCursorError(decoded.reason);
    if (decoded.after.length !== 1 || typeof decoded.after[0] !== 'string' || routeOf(decoded.after[0]) === null)
      throw new PublicationCursorError('invalid');
    after = decoded.after[0];
    epoch = decoded.epoch;
  }
  const check = await accessCheck(
    deps.access,
    actor,
    'realm:ban',
    { route, id: realmId },
    { pool: deps.pool, deadline: context.deadline },
  );
  return withConnection(deps.pool, async (client) => {
    const bounded = deadlineClient(client, context.deadline);
    await bounded.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      if (!(await check(bounded))) throw new GrantDeniedError();
      const partition = await readPartition(bounded, partitionOf(route));
      if (!partition) throw new GrantDeniedError();
      if (epoch !== undefined && epoch !== partition.epoch) throw new PublicationCursorError('stale');
      const fetched = await pageBans.run(bounded, { route, realm_id: realmId, after, limit: limit + 1 });
      const items = fetched.slice(0, limit).map((row) => {
        if (row.at === null) throw new RealmBanInputError();
        return { ...row, at: row.at };
      });
      const last = items.at(-1);
      const next =
        fetched.length > limit && last
          ? encodeCursor(deps.tokens, binding, { epoch: partition.epoch, after: [last.accountId] })
          : null;
      await bounded.query('COMMIT');
      return { items, next };
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        discardConnection(client, rollbackError as Error);
      }
      throw error;
    }
  });
}
