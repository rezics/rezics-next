import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { endResourceDenial, recordResourceDenial } from '../access/resource-denials.ts';
import { authoritativeTimeValue, principalCommandIdentity, runCommand } from '../command/command.ts';
import { accessCommandAuthorization, type AccountActor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { WorkClient } from '../work/client.ts';
import { enqueueRealmRemoval } from './join.ts';
import type { SpaceDependencies } from './space.ts';
import openBan from './ban-open.sql';
import closeBan from './ban-close.sql';
import readRealm from './ban-realm.sql';
import readMembership from './membership-current.sql';
import { assertRealmBanTarget } from './ban-protection.ts';
export { RealmBanRoleError } from './ban-protection.ts';

export type BanDependencies = SpaceDependencies & { tokens: KeyRing; workClient: () => Promise<WorkClient> };
export type Ban = {
  realmId: string;
  accountId: string;
  reason: string;
  actor: string | null;
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
      await assertRealmBanTarget(tx, { resource, accountId: input.accountId, at: command.time });
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

// The existing list entry owns the review envelope; commands keep their native authority.
export { readBanReviewPage as listBans } from './ban-review-page.ts';
