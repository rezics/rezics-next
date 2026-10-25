import type { Pool, PoolClient } from 'pg';
import { readAccount } from '../access/account-data.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { authoritativeTimeValue, type CommandEvent, type CommandOutcome } from '../command/command.ts';
import type { KernelClock } from '../clock.ts';
import { withConnection } from '../database/pool.ts';
import type { Access, AccountActor, Actor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { readCollection } from './collection-store.ts';
import { createLibraryCommandRunner, LibraryNotFoundError } from './command-support.ts';
import type { Follow, FollowPageCursor, FollowTargetType } from './follow-model.ts';
import { applyFollow, pageFollows, readFollow as readStoredFollow } from './follow-store.ts';
import { resolveSubject } from './subject-anchor.ts';

const FOLLOW_EVENT = 'com.rezics.library.follow.updated.v1';

export type FollowTarget = { targetId: string; targetType: FollowTargetType };

/** A committed follow command, or the current row when the follow did not change. */
export type FollowWrite = {
  follow: Follow;
  changed: boolean;
  command: CommandOutcome<Follow> | null;
};

export type LibraryFollow = {
  accountId: string;
  subjectId: string;
  transactionId: string;
  time: string;
};

type QueryClient = Pick<PoolClient, 'query'>;
type FollowDeps = { pool: Pool; access: Access; clock?: KernelClock };

class UnchangedFollow extends Error {
  constructor() {
    super('Follow row is unchanged');
    this.name = 'UnchangedFollow';
  }
}

function followEvent(accountId: string, targetId: string): CommandEvent {
  return { type: FOLLOW_EVENT, subject: accountId, data: { targetId } };
}

function requireAccount(actor: Actor): AccountActor {
  if (actor.kind !== 'account' || routeOf(actor.accountId) === null) throw new GrantDeniedError();
  return actor;
}

function asTarget(value: FollowTarget): FollowTarget {
  if (
    !value ||
    typeof value.targetId !== 'string' ||
    (value.targetType !== 'subject' && value.targetType !== 'collection' && value.targetType !== 'space')
  ) {
    throw new LibraryNotFoundError();
  }
  return { targetId: value.targetId, targetType: value.targetType };
}

/** Library follow commands. Follows stay in the follower's partition and are never counted in public. */
export function createFollowCommands(config: FollowDeps) {
  const { pool, access, clock } = config;
  const runner = createLibraryCommandRunner({ pool, ...(clock === undefined ? {} : { clock }) });

  async function admit(actor: Actor, action: string): Promise<AccountActor> {
    const account = requireAccount(actor);
    if (!account.scopes.includes(action)) throw new GrantDeniedError();
    const route = routeOf(account.accountId)!;
    const current = await withConnection(pool, (client) => readAccount(client, route, account.accountId));
    if (
      !current ||
      current.kind !== 'actor' ||
      current.state !== 'active' ||
      current.fenced ||
      !Number.isSafeInteger(account.authnEpoch) ||
      account.authnEpoch <= 0 ||
      current.minimumAuthnEpoch > BigInt(account.authnEpoch)
    ) {
      throw new GrantDeniedError();
    }
    return account;
  }

  // One anchored read of the target, then the follower command upserts. A Space has no read here yet.
  async function assertReadable(actor: AccountActor, target: FollowTarget): Promise<void> {
    if (target.targetType === 'space') {
      // Explicit space follows wait until the community module provides a space read.
      throw new LibraryNotFoundError();
    }
    if (target.targetType === 'subject') {
      // Wall time bounds the access check. The command clock belongs to the follow row.
      const resolved = await resolveSubject({ pool, access }, actor, target.targetId);
      if (!resolved) throw new LibraryNotFoundError();
      return;
    }
    if (target.targetType === 'collection') {
      const route = routeOf(target.targetId);
      if (route === null) throw new LibraryNotFoundError();
      const collection = await withConnection(pool, (client) => readCollection(client, route, target.targetId));
      const active = collection?.state === 'active';
      const visible = collection?.visibility === 'public' || collection?.visibility === 'unlisted';
      const curator = collection?.curatorAccountId === actor.accountId;
      if (!active || (!visible && !curator)) throw new LibraryNotFoundError();
      return;
    }
    throw new LibraryNotFoundError();
  }

  async function load(accountId: string, targetId: string): Promise<Follow | null> {
    const route = routeOf(accountId);
    if (route === null || routeOf(targetId) === null) return null;
    return withConnection(pool, (client) => readStoredFollow(client, route, accountId, targetId));
  }

  async function finish(
    run: () => Promise<CommandOutcome<Follow>>,
    accountId: string,
    targetId: string,
  ): Promise<FollowWrite> {
    try {
      const command = await run();
      return { follow: command.value, changed: !command.replayed, command };
    } catch (error) {
      if (!(error instanceof UnchangedFollow)) throw error;
      const follow = await load(accountId, targetId);
      if (!follow) throw error;
      return { follow, changed: false, command: null };
    }
  }

  async function write(
    actor: AccountActor,
    target: FollowTarget,
    requestKey: string,
    intent: 'follow' | 'unfollow',
  ): Promise<FollowWrite> {
    const action = intent === 'follow' ? 'follow:create' : 'follow:delete';
    const kind = intent === 'follow' ? 'library.follow' : 'library.unfollow';
    return finish(
      () =>
        runner.ownAccount(actor, { action, kind, requestKey, input: target }, async (tx, command) => {
          const route = routeOf(actor.accountId)!;
          // The command log requires an event, so an unchanged row aborts before the receipt.
          const changed = await applyFollow(tx, route, {
            accountId: actor.accountId,
            targetId: target.targetId,
            targetType: target.targetType,
            intent,
            reason: 'explicit',
            transactionId: command.transactionId,
            time: authoritativeTimeValue(command.time),
          });
          if (!changed) throw new UnchangedFollow();
          const follow = await readStoredFollow(tx, route, actor.accountId, target.targetId);
          if (!follow) throw new Error('Follow write did not leave a row');
          return { value: follow, events: [followEvent(actor.accountId, target.targetId)] };
        }),
      actor.accountId,
      target.targetId,
    );
  }

  async function follow(actor: Actor, input: FollowTarget, requestKey: string): Promise<FollowWrite> {
    const account = await admit(actor, 'follow:create');
    const target = asTarget(input);
    await assertReadable(account, target);
    return write(account, target, requestKey, 'follow');
  }

  async function unfollow(actor: Actor, input: FollowTarget, requestKey: string): Promise<FollowWrite> {
    const account = await admit(actor, 'follow:delete');
    const target = asTarget(input);
    await assertReadable(account, target);
    return write(account, target, requestKey, 'unfollow');
  }

  async function followForMembership(input: {
    accountId: string;
    spaceId: string;
    stepKey: string;
  }): Promise<FollowWrite> {
    const { accountId, spaceId, stepKey } = input;
    return finish(
      () =>
        runner.trustedAccount(
          accountId,
          { kind: 'library.follow.membership', stepKey, input: { accountId, spaceId } },
          async (tx, command) => {
            const route = routeOf(accountId)!;
            const changed = await applyFollow(tx, route, {
              accountId,
              targetId: spaceId,
              targetType: 'space',
              intent: 'implied',
              reason: 'membership',
              transactionId: command.transactionId,
              time: authoritativeTimeValue(command.time),
            });
            if (!changed) throw new UnchangedFollow();
            const follow = await readStoredFollow(tx, route, accountId, spaceId);
            if (!follow) throw new Error('Follow write did not leave a row');
            return { value: follow, events: [followEvent(accountId, spaceId)] };
          },
        ),
      accountId,
      spaceId,
    );
  }

  /** Implied library follow inside an entry command already open on the follower's partition. */
  async function followFromLibrary(tx: QueryClient, route: number, input: LibraryFollow): Promise<CommandEvent | null> {
    const changed = await applyFollow(tx, route, {
      accountId: input.accountId,
      targetId: input.subjectId,
      targetType: 'subject',
      intent: 'implied',
      reason: 'library',
      transactionId: input.transactionId,
      time: input.time,
    });
    return changed ? followEvent(input.accountId, input.subjectId) : null;
  }

  async function readFollow(actor: Actor, targetId: string): Promise<Follow | null> {
    const account = requireAccount(actor);
    return load(account.accountId, targetId);
  }

  async function listFollows(
    actor: Actor,
    page: { cursor: FollowPageCursor | null; limit: number },
  ): Promise<Follow[]> {
    const account = requireAccount(actor);
    const route = routeOf(account.accountId)!;
    return withConnection(pool, (client) =>
      pageFollows(client, route, account.accountId, { after: page.cursor, limit: page.limit }),
    );
  }

  return { follow, unfollow, followForMembership, followFromLibrary, readFollow, listFollows };
}
