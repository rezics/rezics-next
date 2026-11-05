import type { PoolClient } from 'pg';
import { REACTION_KINDS } from '../events/contracts/content.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import read from './realm-votes.sql';

type ReactionKind = (typeof REACTION_KINDS)[number];
export type RealmVoteWeight = 1 | -1;
/** Kinds absent from the map count as 0. */
export type RealmVotes = Readonly<Partial<Record<ReactionKind, RealmVoteWeight>>>;

const reactionKinds = new Set<string>(REACTION_KINDS);
type VoteRow = { realm_id: string; votes: unknown };

function votesOf(value: unknown): RealmVotes {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('Invalid Realm votes');
  const votes: Partial<Record<ReactionKind, RealmVoteWeight>> = {};
  for (const [key, weight] of Object.entries(value)) {
    if (!reactionKinds.has(key) || (weight !== 1 && weight !== -1)) throw new TypeError('Invalid Realm votes');
    votes[key as ReactionKind] = weight;
  }
  if (Object.keys(votes).length > 7) throw new TypeError('Invalid Realm votes');
  return Object.freeze(votes);
}

/**
 * Votes stored on each active Realm. One primary-key statement per partition.
 * An unknown or inactive id is absent.
 */
export async function readRealmVotes(
  client: Pick<PoolClient, 'query'>,
  realmIds: readonly string[],
): Promise<ReadonlyMap<string, RealmVotes>> {
  if (!Array.isArray(realmIds)) throw new TypeError('Realm ids must be an array');
  const groups = new Map<number, Map<string, number>>();
  for (const id of realmIds) {
    const route = routeOf(id);
    if (route === null) continue;
    const partition = partitionOf(route);
    const group = groups.get(partition) ?? new Map<string, number>();
    group.set(id, route);
    groups.set(partition, group);
  }

  const votes = new Map<string, RealmVotes>();
  for (const [partition, group] of groups) {
    const realms = [...group].map(([realmId, route]) => ({ route, realm_id: realmId }));
    const parameters: Record<string, unknown> = { partition, realms };
    const values = read.params.map((name) => {
      if (!Object.hasOwn(parameters, name)) throw new TypeError(`Unexpected Realm votes parameter ${name}`);
      return name === 'realms' ? JSON.stringify(parameters[name]) : parameters[name];
    });
    const result = await client.query<VoteRow>(read.sql, values);
    for (const row of result.rows) votes.set(row.realm_id, votesOf(row.votes));
  }
  return votes;
}
