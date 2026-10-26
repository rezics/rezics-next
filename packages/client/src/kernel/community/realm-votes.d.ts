import type { PoolClient } from 'pg';
import { REACTION_KINDS } from '../content/events.ts';
type ReactionKind = (typeof REACTION_KINDS)[number];
export type RealmVoteWeight = 1 | -1;
/** Kinds absent from the map count as 0. */
export type RealmVotes = Readonly<Partial<Record<ReactionKind, RealmVoteWeight>>>;
/**
 * Votes stored on each active Realm. One primary-key statement per partition.
 * An unknown or inactive id is absent.
 */
export declare function readRealmVotes(client: Pick<PoolClient, 'query'>, realmIds: readonly string[]): Promise<ReadonlyMap<string, RealmVotes>>;
export {};
