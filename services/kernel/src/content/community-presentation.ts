import type { Pool } from 'pg';
import { deadlineClient, within } from '../access/authenticate.ts';
import { mintReadTime, authoritativeTimeValue } from '../command/command.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { readPartitions } from '../partition/partition.ts';
import { prepareReadDecisions } from '../request/access.ts';
import type { Access } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { realmPresentation } from '../community/presentation.ts';
import { readRealmMemberCount } from '../community/member-count.ts';
import type { CommunityPresentation } from './community-presentation-model.ts';
import type { ReadContext } from './model.ts';
import { readExactPublishedRules } from './reads.ts';
import { rulesKey } from './community-presentation-rules.ts';
import { readRealmPresentationImages } from './realm-media.ts';
import realmRows from './community-presentation-realms.sql';
import spaceRows from './community-presentation-spaces.sql';
import memberships from './community-presentation-membership.sql';
import bans from './ban-current-many-batch.sql';

export type { CommunityPresentation } from './community-presentation-model.ts';
export { CommunityPresentationSchema } from './community-presentation-model.ts';
type Dependencies = Readonly<{ pool: Pool; access: Access; clock?: () => Date }>;
const none = { state: 'none', value: null } as const;
const unavailable = { state: 'unavailable', value: null } as const;
const unknownMembers = { state: 'unknown', count: null, version: null } as const;
const keys = (ids: readonly string[]) => [...new Set(ids)].map((id) => ({ route: routeOf(id), id }));

/** One batch per row kind, one snapshot per round. Source failures fail the
 * container read; optional producer failures carry no cached positive value. */
export async function readCommunityPresentations(
  deps: Dependencies,
  realmIds: readonly string[],
  context: ReadContext,
): Promise<ReadonlyMap<string, CommunityPresentation>> {
  const ids = [...new Set(realmIds)];
  if (ids.length > 100 || ids.some((id) => routeOf(id) === null)) throw new RangeError('At most 100 routed Realms');
  if (!ids.length) return new Map();
  const decisions = await prepareReadDecisions(deps.access, {
    actor: context.actor,
    actions: new Set(['realm:read', 'space:read', 'realm:join']),
    context: { pool: deps.pool, deadline: context.deadline },
  });
  const round = () =>
    within(context.deadline, () =>
      withConnection(deps.pool, async (connection) => {
        const client = deadlineClient(connection, context.deadline);
        try {
          await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
          const time = await mintReadTime(client, deps.clock);
          const at = authoritativeTimeValue(time);
          const realms = await realmRows.run(client, { keys: keys(ids) });
          const spaces = await spaceRows.run(client, { keys: keys(realms.map((row) => row.space_id)) });
          const partitions = await readPartitions(client, [
            ...new Set([...ids, ...spaces.map((s) => s.space_id)].map((id) => partitionOf(routeOf(id)!))),
          ]);
          if (
            partitions.length !==
              new Set([...ids, ...spaces.map((s) => s.space_id)].map((id) => partitionOf(routeOf(id)!))).size ||
            partitions.some((p) => p.writeState === 'moved')
          )
            throw new Error('Community presentation partition unavailable');
          const principal = context.actor.kind === 'account' ? context.actor.requestedBy?.split(':')[3] : undefined;
          const accounts =
            context.actor.kind === 'account'
              ? [...new Set([context.actor.accountId, ...(principal ? [principal] : [])])]
              : [];
          const denied = accounts.length
            ? await bans.run(client, {
                keys: ids.map((id) => ({ route: routeOf(id), realm_id: id, account_ids: accounts })),
                at,
              })
            : [];
          const isBanned = (id: string) => denied.some((b) => b.realm_id === id);
          const active = (row: { created_at: string; revision_created_at: string }) =>
            Date.parse(row.created_at) <= Date.parse(at) && Date.parse(row.revision_created_at) <= Date.parse(at);
          const visibleRealms = realms.length
            ? await decisions.decide(
                client,
                {
                  action: 'realm:read',
                  resourceType: 'community.realm',
                  ids: realms.map((row) => row.realm_id),
                  eligibility: async () =>
                    Object.fromEntries(realms.map((row) => [row.realm_id, active(row) && row.visibility === 'public'])),
                },
                time,
              )
            : {};
          const visibleSpaces = spaces.length
            ? await decisions.decide(
                client,
                {
                  action: 'space:read',
                  resourceType: 'community.space',
                  ids: spaces.map((row) => row.space_id),
                  eligibility: async () => Object.fromEntries(spaces.map((row) => [row.space_id, active(row)])),
                },
                time,
              )
            : {};
          const currentMemberships =
            context.actor.kind === 'account'
              ? await memberships.run(client, {
                  keys: keys(ids),
                  account_id: context.actor.accountId,
                  at,
                })
              : [];
          // The native join and leave commands both admit self operations with realm:join.
          const admission =
            context.actor.kind === 'account' && realms.length
              ? await decisions.decide(
                  client,
                  {
                    action: 'realm:join',
                    resourceType: 'community.realm',
                    ids: realms.map((row) => row.realm_id),
                  },
                  time,
                )
              : {};
          const result = new Map<
            string,
            {
              value: CommunityPresentation;
              signature: string;
              reference: ReturnType<typeof realmPresentation>['rules'];
              presentation: ReturnType<typeof realmPresentation>;
            }
          >();
          for (const realm of realms) {
            const space = spaces.find((s) => s.space_id === realm.space_id);
            if (
              !space ||
              !active(realm) ||
              !active(space) ||
              !visibleRealms[realm.realm_id]?.allowed ||
              !visibleSpaces[space.space_id]?.allowed ||
              (realm.visibility === 'protected' && isBanned(realm.realm_id))
            )
              continue;
            const presentation = realmPresentation(realm.presentation);
            const member = currentMemberships.some((m) => m.realm_id === realm.realm_id);
            const membership = context.actor.kind === 'account' ? (member ? 'member' : 'nonmember') : 'unknown';
            const action =
              context.actor.kind === 'anonymous'
                ? realm.visibility === 'public'
                  ? 'sign-in'
                  : null
                : admission[realm.realm_id]?.allowed && !isBanned(realm.realm_id)
                  ? member
                    ? 'leave'
                    : realm.visibility === 'public'
                      ? 'join'
                      : null
                  : null;
            let members: CommunityPresentation['members'] = unknownMembers;
            try {
              // This snapshot owns the Realm read time. Other source homes have
              // been released before either round; no per-card remote read occurs.
              const count = await readRealmMemberCount(client, { realmId: realm.realm_id, at: time });
              if (count !== null) members = { state: 'current', count: count.count, version: count.version };
            } catch {
              // An unavailable native source cannot supply a total, including zero.
            }
            result.set(realm.realm_id, {
              signature: JSON.stringify([
                realm,
                space,
                partitions.map((p) => [p.partitionNo, p.epoch]),
                membership,
                action,
              ]),
              reference: presentation.rules,
              presentation,
              value: {
                realmId: realm.realm_id,
                spaceId: realm.space_id,
                contextId: realm.context_id,
                name: realm.title,
                description: realm.summary,
                avatar: presentation.avatarMediaId === null ? none : unavailable,
                banner: presentation.bannerMediaId === null ? none : unavailable,
                members,
                rules: presentation.rules === null ? none : unavailable,
                join: { membership, action },
              },
            });
          }
          await client.query('COMMIT');
          return result;
        } catch (error) {
          try {
            await connection.query('ROLLBACK');
          } catch (rollbackError) {
            discardConnection(connection, rollbackError as Error);
          }
          throw error;
        }
      }),
    );
  const initial = await round();
  const refs = [...initial.values()].flatMap((r) =>
    r.reference ? [{ ...r.reference, realmId: r.value.realmId }] : [],
  );
  let rules: Awaited<ReturnType<typeof readExactPublishedRules>> | null = null;
  try {
    rules = await readExactPublishedRules(deps, refs, context);
  } catch {
    /* Optional native dependency is unavailable. */
  }
  const images = new Map<string, Awaited<ReturnType<typeof readRealmPresentationImages>>>();
  // Source snapshots are released. Each unique Realm contributes at most two
  // exact media keys to the native reader, shared by every board in this page.
  for (const [realmId, prepared] of initial) {
    const { avatarMediaId, bannerMediaId } = prepared.presentation;
    if (avatarMediaId === null && bannerMediaId === null) continue;
    images.set(realmId, await readRealmPresentationImages(deps, { realmId, avatarMediaId, bannerMediaId }, context));
  }
  const final = await round();
  const output = new Map<string, CommunityPresentation>();
  for (const [id, current] of final) {
    const prepared = initial.get(id);
    if (prepared?.signature !== current.signature) continue;
    // A changed or lost native count is withheld under this fixed protocol.
    // Never refill or label a prepared cached value current after a transition.
    const before = prepared.value.members;
    const after = current.value.members;
    const members =
      before.state === 'current' &&
      after.state === 'current' &&
      before.version === after.version &&
      before.count === after.count
        ? after
        : unknownMembers;
    const rule = current.reference && rules?.get(rulesKey(current.reference, current.value.realmId));
    output.set(id, {
      ...current.value,
      ...images.get(id),
      members,
      rules: !current.reference
        ? none
        : rules === null
          ? unavailable
          : rule
            ? { state: 'available', value: rule }
            : none,
    });
  }
  return output;
}
