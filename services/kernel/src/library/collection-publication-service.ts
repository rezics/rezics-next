import { isDeepStrictEqual } from 'node:util';
import type { Pool, PoolClient } from 'pg';
import { readAccount } from '../access/account-data.ts';
import { deadlineClient } from '../access/authenticate.ts';
import { mintReadTime, releaseOperationalTime, type AuthoritativeTime } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import { accessCheck, type Access, type AccountActor, type Actor } from '../request/access.ts';
import { deadlineFor } from '../request/deadline.ts';
import { routeOf } from '../route/route.ts';
import type { KernelClock } from '../clock.ts';
import { authorizeCollectionRule, prepareCollectionRuleAuthority } from './collection-rules.ts';
import {
  readCollectionPublicationEpisode,
  readCollectionPublicationRule,
  createCollectionPublicationEpisodes,
  type CollectionPublicationBeginResult,
} from './collection-publication-episodes.ts';
import type {
  CollectionPublicationBeginInput,
  CollectionPublicationEpisode,
} from './collection-publication-episode-contract.ts';
import type { CollectionPublicationLocator } from './collection-publication-work-admission.ts';
import type { CollectionPublicationStatus } from './collection-publication-http.ts';
import { collectionPublicationStatus } from './collection-publication-http.ts';
import { readCollection } from './collection-store.ts';
import type { CommandOutcome } from '../command/command.ts';

type Dependencies = Readonly<{ pool: Pool; access: Access; clock?: KernelClock }>;
type StatusSnapshot = Readonly<{
  time: AuthoritativeTime;
  episode: CollectionPublicationEpisode;
  rule: Awaited<ReturnType<typeof readCollectionPublicationRule>>;
  update: Awaited<ReturnType<typeof accessCheck>>;
}>;

async function readOnly<T>(pool: Pool, read: (client: PoolClient) => Promise<T>): Promise<T> {
  return withConnection(pool, async (client) => {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      const value = await read(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

function concealed(): never {
  throw new ProblemError('not_found');
}

function account(actor: Actor): AccountActor {
  if (actor.kind !== 'account') throw new ProblemError('authentication_required');
  return actor;
}

/** HTTP-facing begin and owner-private status operations; native readers remain the source of truth. */
export function createCollectionPublicationService(dependencies: Dependencies) {
  const { pool, access, clock } = dependencies;
  const episodes = createCollectionPublicationEpisodes({ pool, access, ...(clock ? { clock } : {}) });

  async function locate(publicationId: string, deadline: number): Promise<CollectionPublicationLocator | null> {
    const route = routeOf(publicationId);
    if (route === null) return null;
    const row = await withConnection(
      pool,
      async (connection) =>
        (
          await deadlineClient(connection, deadline).query<{ ownerAccountId: string; collectionId: string }>(
            `SELECT owner_account_id::text AS "ownerAccountId",collection_id::text AS "collectionId"
           FROM library.collection_publication_episode
           WHERE route=$1 AND publication_id=$2`,
            [route, publicationId],
          )
        ).rows[0],
    );
    if (!row) return null;
    if (routeOf(row.ownerAccountId) !== route || routeOf(row.collectionId) !== route) {
      throw new ProblemError('dependency_unavailable');
    }
    return {
      route,
      ownerAccountId: row.ownerAccountId,
      collectionId: row.collectionId,
      publicationId,
    };
  }

  async function snapshot(
    actor: AccountActor,
    locator: CollectionPublicationLocator,
    time: AuthoritativeTime,
    deadline: number,
  ) {
    const accountRoute = routeOf(actor.accountId);
    if (
      accountRoute === null ||
      actor.accountId !== locator.ownerAccountId ||
      accountRoute !== locator.route ||
      !actor.scopes.includes('collection:update')
    )
      concealed();
    const update = await accessCheck(
      access,
      actor,
      'collection:update',
      { route: locator.route, id: locator.collectionId },
      { pool, deadline, time },
    );
    return readOnly(pool, async (connection) => {
      const client = deadlineClient(connection, deadline);
      const currentAccount = await readAccount(client, accountRoute, actor.accountId);
      const collection = await readCollection(client, locator.route, locator.collectionId);
      const episode = await readCollectionPublicationEpisode(client, locator);
      if (
        !currentAccount ||
        currentAccount.kind !== 'actor' ||
        currentAccount.state !== 'active' ||
        currentAccount.fenced ||
        !Number.isSafeInteger(actor.authnEpoch) ||
        actor.authnEpoch < 1 ||
        currentAccount.minimumAuthnEpoch > BigInt(actor.authnEpoch) ||
        !collection ||
        collection.state !== 'active' ||
        collection.curatorAccountId !== actor.accountId ||
        collection.membershipKind !== 'dynamic' ||
        !episode ||
        episode.source.locator.ownerAccountId !== actor.accountId ||
        episode.source.target.collectionId !== collection.id ||
        !(await update(client, time))
      )
        concealed();
      const rule =
        episode.phase === 'staging' || episode.phase === 'awaiting_activation'
          ? await readCollectionPublicationRule(client, locator)
          : null;
      if ((episode.phase === 'staging' || episode.phase === 'awaiting_activation') && !rule)
        throw new ProblemError('dependency_unavailable');
      return { time, episode, rule, update } satisfies StatusSnapshot;
    });
  }

  return {
    begin(
      actor: Actor,
      input: CollectionPublicationBeginInput,
      requestKey: string,
    ): Promise<CommandOutcome<CollectionPublicationBeginResult>> {
      return episodes.begin(actor, input, requestKey);
    },

    async status(actorInput: Actor, publicationId: string): Promise<CollectionPublicationStatus> {
      const actor = account(actorInput);
      const deadline = deadlineFor(30_000);
      const locator = await locate(publicationId, deadline);
      if (!locator) concealed();
      if (actor.accountId !== locator.ownerAccountId) concealed();
      const route = routeOf(actor.accountId);
      if (route === null) concealed();
      const time = await withConnection(pool, (client) => mintReadTime(deadlineClient(client, deadline), clock));
      try {
        const first = await snapshot(actor, locator, time, deadline);
        const checks = first.rule
          ? await prepareCollectionRuleAuthority(
              { pool, access },
              actor,
              first.rule.filter,
              { time, read: true },
              deadline,
            )
          : [];
        const final = await readOnly(pool, async (connection) => {
          const client = deadlineClient(connection, deadline);
          const currentAccount = await readAccount(client, route, actor.accountId);
          const collection = await readCollection(client, locator.route, locator.collectionId);
          const episode = await readCollectionPublicationEpisode(client, locator);
          if (
            !currentAccount ||
            currentAccount.kind !== 'actor' ||
            currentAccount.state !== 'active' ||
            currentAccount.fenced ||
            !Number.isSafeInteger(actor.authnEpoch) ||
            actor.authnEpoch < 1 ||
            currentAccount.minimumAuthnEpoch > BigInt(actor.authnEpoch) ||
            !collection ||
            collection.state !== 'active' ||
            collection.curatorAccountId !== actor.accountId ||
            collection.membershipKind !== 'dynamic' ||
            !episode ||
            !isDeepStrictEqual(episode.source, first.episode.source)
          )
            concealed();
          if (!(await first.update(client, time))) concealed();
          if ((episode.phase === 'staging' || episode.phase === 'awaiting_activation') && first.rule) {
            const currentRule = await readCollectionPublicationRule(client, locator);
            if (!currentRule) throw new ProblemError('dependency_unavailable');
            await authorizeCollectionRule(client, { time }, checks);
            if (!isDeepStrictEqual(currentRule, first.rule)) throw new ProblemError('dependency_unavailable');
          }
          return episode;
        });
        return collectionPublicationStatus(final);
      } finally {
        releaseOperationalTime(time);
      }
    },
  };
}
