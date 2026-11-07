import { REACTION_KINDS } from '../content/events.ts';
import { realmContinuityView } from './realm-governance.ts';
import { realmPresentation } from './presentation.ts';
import type { RealmView } from './realm.ts';
import type { RealmVotes } from './realm-votes.ts';
import read from './realm-read.sql';

type RealmRow = NonNullable<Awaited<ReturnType<typeof read.run>>>;

export function voteMap(value: unknown, invalid: new () => Error): RealmVotes {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new invalid();
  const source = value as Record<string, unknown>;
  const present = Object.keys(source);
  if (present.length > 7) throw new invalid();
  const votes: Partial<Record<(typeof REACTION_KINDS)[number], 1 | -1>> = {};
  for (const kind of REACTION_KINDS) {
    if (!Object.hasOwn(source, kind)) continue;
    const weight = source[kind];
    if (weight !== 1 && weight !== -1) throw new invalid();
    votes[kind] = weight;
  }
  if (Object.keys(votes).length !== present.length) throw new invalid();
  return Object.freeze(votes);
}
export function realmRecord(row: RealmRow): RealmView {
  return {
    ...realmContinuityView(row),
    realmId: row.realm_id,
    spaceId: row.space_id,
    state: row.state,
    visibility: row.visibility,
    contextId: row.context_id,
    boardSchemeId: row.board_scheme_id,
    headRevisionId: row.head_revision_id,
    createdAt: new Date(row.created_at).toISOString(),
    creator: row.creator,
    predecessor: row.predecessor,
    title: row.title,
    summary: row.summary,
    revisionCreatedAt: new Date(row.revision_created_at).toISOString(),
    author: row.author,
    votes: voteMap(row.votes, TypeError),
    presentation: realmPresentation(row.presentation),
  };
}
