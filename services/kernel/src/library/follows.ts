import type { Pool, PoolClient } from 'pg';
import { commandAccessContext } from '../access/command-admission.ts';
import { readAccountCommandState } from '../access/account-data.ts';
import { deadlineClient } from '../access/authenticate.ts';
import { currentCommandWorkAssociation } from '../command/work-context.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import {
  authoritativeTimeValue,
  mintReadTime,
  type CommandAttempt,
  type CommandEvent,
  type CommandOutcome,
} from '../command/command.ts';
import type { KernelClock } from '../clock.ts';
import { readSpace, spaceReadEligibility } from '../community/space.ts';
import { withConnection } from '../database/pool.ts';
import { accessCheck, type Access, type AccountActor, type Actor } from '../request/access.ts';
import { withRequestDeadline } from '../request/deadline.ts';
import { routeOf } from '../route/route.ts';
import { readCollection } from './collection-store.ts';
import { createLibraryCommandRunner, LibraryNotFoundError, workStepDeadline } from './command-support.ts';
import type { Follow, FollowPageCursor, FollowTargetType } from './follow-model.ts';
import { applyFollow, pageFollows, readFollow as readStoredFollow } from './follow-store.ts';
import { resolveSubject } from './subject-anchor.ts';
import { consumeFollowWork, followAccountWork, withFollowWork } from './follow-operation-bounds.ts';

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
  const runner = createLibraryCommandRunner({ pool, access, ...(clock === undefined ? {} : { clock }) });

  async function admit(actor: Actor, action: string, deadline: number): Promise<AccountActor> {
    const account = requireAccount(actor);
    if (!account.scopes.includes(action)) throw new GrantDeniedError();
    const route = routeOf(account.accountId)!;
    const current = await consumeFollowWork('admit', followAccountWork(account.accountId), () =>
      withConnection(pool, (client) =>
        readAccountCommandState(deadlineClient(client, deadline), route, account.accountId),
      ),
    );
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

  async function readable(
    actor: AccountActor,
    target: FollowTarget,
    deadline: number,
    attempt?: CommandAttempt,
  ): Promise<FollowTarget | null> {
    const work = currentCommandWorkAssociation()?.access;
    const base = { pool, deadline, ...(work ? { work } : {}) };
    const context = attempt ? commandAccessContext(base, attempt) : base;
    const time =
      attempt?.time ?? (await withConnection(pool, (client) => mintReadTime(deadlineClient(client, deadline), clock)));
    const route = routeOf(target.targetId);
    if (route === null) return null;
    if (target.targetType === 'space') {
      const identity = { route, id: target.targetId };
      const check = await accessCheck(
        access,
        actor,
        'space:read',
        {
          ...identity,
          eligibility: spaceReadEligibility(identity),
        },
        context,
      );
      const allowed = await withConnection(pool, async (client) => {
        const db = deadlineClient(client, deadline);
        if (!(await check(db, time))) return false;
        return (await readSpace(db, target.targetId, authoritativeTimeValue(time))) !== null;
      });
      return allowed ? target : null;
    }
    if (target.targetType === 'subject') {
      const resolved = await resolveSubject({ pool, access }, actor, target.targetId, time, context);
      return resolved ? target : null;
    }
    const collection = await withConnection(pool, (client) =>
      readCollection(deadlineClient(client, deadline), route, target.targetId),
    );
    return collection?.state === 'active' &&
      (collection.visibility === 'public' ||
        collection.visibility === 'unlisted' ||
        collection.curatorAccountId === actor.accountId)
      ? target
      : null;
  }

  async function resolveTarget(
    actor: AccountActor,
    input: FollowTarget | string,
    deadline: number,
    attempt?: CommandAttempt,
  ): Promise<FollowTarget> {
    const candidates: FollowTarget[] =
      typeof input === 'string'
        ? (['collection', 'subject', 'space'] as const).map((targetType) => ({ targetId: input, targetType }))
        : [asTarget(input)];
    for (const target of candidates) {
      const resolved = await readable(actor, target, deadline, attempt);
      if (resolved) return resolved;
    }
    throw new LibraryNotFoundError();
  }

  async function load(accountId: string, targetId: string, deadline = workStepDeadline()): Promise<Follow | null> {
    const route = routeOf(accountId);
    if (route === null || routeOf(targetId) === null) return null;
    return withConnection(pool, (client) =>
      readStoredFollow(deadlineClient(client, deadline), route, accountId, targetId),
    );
  }

  async function finish(
    run: () => Promise<CommandOutcome<Follow>>,
    accountId: string,
    targetId: string,
    deadline = workStepDeadline(),
  ): Promise<FollowWrite> {
    try {
      const command = await run();
      return { follow: command.value, changed: !command.replayed, command };
    } catch (error) {
      if (!(error instanceof UnchangedFollow)) throw error;
      const follow = await load(accountId, targetId, deadline);
      if (!follow) throw error;
      return { follow, changed: false, command: null };
    }
  }

  async function write(
    actor: AccountActor,
    input: FollowTarget | string,
    requestKey: string,
    intent: 'follow' | 'unfollow',
    deadline: number,
  ): Promise<FollowWrite> {
    const action = intent === 'follow' ? 'follow:create' : 'follow:delete';
    const kind = intent === 'follow' ? 'library.follow' : 'library.unfollow';
    const targetId = typeof input === 'string' ? input : asTarget(input).targetId;
    if (routeOf(targetId) === null) throw new LibraryNotFoundError();
    // Preserve the existing target-shaped digest. Stored identity is read only in
    // this account's partition; an absent own row conveys no foreign target type.
    const existing = await load(actor.accountId, targetId, deadline);
    const target = existing
      ? { targetId: existing.targetId, targetType: existing.targetType }
      : typeof input === 'string'
        ? await resolveTarget(actor, input, deadline)
        : asTarget(input);
    return finish(
      () =>
        runner.ownAccountPrepared(
          actor,
          {
            action,
            kind,
            requestKey,
            input: target ?? { targetId },
            deadline,
            followOperation: true,
            async prepare(attempt) {
              // Business failure is deferred until AFTER current owner admission and
              // exact receipt replay. A stored removal never visits the target home.
              if (intent === 'unfollow' && existing) return { target, error: null };
              try {
                return { target: await resolveTarget(actor, target ?? input, deadline, attempt), error: null };
              } catch (error) {
                return { target: null, error };
              }
            },
          },
          async (tx, command, prepared) => {
            if (prepared.error) {
              throw prepared.error;
            }
            if (!prepared.target) throw new LibraryNotFoundError();
            const route = routeOf(actor.accountId)!;
            const stored = await readStoredFollow(tx, route, actor.accountId, targetId);
            if (stored && stored.targetType !== prepared.target.targetType) throw new LibraryNotFoundError();
            if (intent === 'unfollow' && existing && !stored) throw new LibraryNotFoundError();
            const changed = await applyFollow(tx, route, {
              accountId: actor.accountId,
              targetId,
              targetType: stored?.targetType ?? prepared.target.targetType,
              intent,
              reason: 'explicit',
              transactionId: command.transactionId,
              time: authoritativeTimeValue(command.time),
            });
            if (!changed) {
              throw new UnchangedFollow();
            }
            const follow = await readStoredFollow(tx, route, actor.accountId, targetId);
            if (!follow) throw new Error('Follow write did not leave a row');
            return { value: follow, events: [followEvent(actor.accountId, targetId)] };
          },
        ),
      actor.accountId,
      targetId,
      deadline,
    );
  }

  async function follow(
    actor: Actor,
    input: FollowTarget | string,
    requestKey: string,
    deadline = workStepDeadline(),
  ): Promise<FollowWrite> {
    const original = typeof input === 'string' ? input : Object.freeze({ ...input });
    return withFollowWork(deadline, () =>
      withRequestDeadline(deadline, async () =>
        write(await admit(actor, 'follow:create', deadline), original, requestKey, 'follow', deadline),
      ),
    );
  }

  async function unfollow(
    actor: Actor,
    input: FollowTarget | string,
    requestKey: string,
    deadline = workStepDeadline(),
  ): Promise<FollowWrite> {
    const original = typeof input === 'string' ? input : Object.freeze({ ...input });
    return withFollowWork(deadline, () =>
      withRequestDeadline(deadline, async () =>
        write(await admit(actor, 'follow:delete', deadline), original, requestKey, 'unfollow', deadline),
      ),
    );
  }

  async function followForMembership(input: {
    accountId: string;
    spaceId: string;
    stepKey: string;
  }): Promise<FollowWrite> {
    const { accountId, spaceId, stepKey } = input;
    const deadline = workStepDeadline();
    return withFollowWork(deadline, () =>
      withRequestDeadline(deadline, () =>
        finish(
          () =>
            runner.trustedAccount(
              accountId,
              {
                kind: 'library.follow.membership',
                stepKey,
                input: { accountId, spaceId },
                followOperation: true,
                deadline,
              },
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
                if (!changed) {
                  throw new UnchangedFollow();
                }
                const follow = await readStoredFollow(tx, route, accountId, spaceId);
                if (!follow) throw new Error('Follow write did not leave a row');
                return { value: follow, events: [followEvent(accountId, spaceId)] };
              },
            ),
          accountId,
          spaceId,
          deadline,
        ),
      ),
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

  async function readFollow(actor: Actor, targetId: string, deadline = workStepDeadline()): Promise<Follow | null> {
    const account = requireAccount(actor);
    return load(account.accountId, targetId, deadline);
  }

  async function listFollows(
    actor: Actor,
    page: { cursor: FollowPageCursor | null; limit: number; targetType?: FollowTargetType },
    deadline = workStepDeadline(),
  ): Promise<Follow[]> {
    const account = requireAccount(actor);
    const route = routeOf(account.accountId)!;
    return withConnection(pool, (client) =>
      pageFollows(deadlineClient(client, deadline), route, account.accountId, {
        after: page.cursor,
        limit: page.limit,
        ...(page.targetType === undefined ? {} : { targetType: page.targetType }),
      }),
    );
  }

  return { follow, unfollow, followForMembership, followFromLibrary, readFollow, listFollows };
}
