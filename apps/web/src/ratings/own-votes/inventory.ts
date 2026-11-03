import type { OwnVoteEntry, OwnVotesPage } from './types';

export const OWN_VOTES_OPERATION = 'rating.own_votes_page' as const;
export const OWN_VOTES_SOURCE = 'rating.own_votes_page/v1' as const;
export const OWN_VOTES_PAGE_LIMIT = 20;
export const OWN_VOTES_CURSOR_LIMIT = 4096;

export type VotePair = Pick<OwnVoteEntry, 'questionId' | 'targetId'>;

/** The private key is the original pair. Terminal summaries may be shared by distinct source keys. */
export function votePairKey(pair: VotePair): string {
  return `${pair.questionId}\u0000${pair.targetId}`;
}

/** One bounded O(N) index for a native page; selection thereafter is O(1). */
export function indexOwnVotes(page: OwnVotesPage): Map<string, OwnVoteEntry> {
  const index = new Map<string, OwnVoteEntry>();
  for (const entry of page.votes) {
    const key = votePairKey(entry);
    if (index.has(key)) throw new Error('The native page repeated an original vote key');
    index.set(key, entry);
  }
  return index;
}

export function ownVotesCursor(value: unknown): { valid: true; cursor: string | null } | { valid: false } {
  if (value === undefined || value === null) return { valid: true, cursor: null };
  if (typeof value !== 'string' || value.length === 0 || value.length > OWN_VOTES_CURSOR_LIMIT)
    return { valid: false };
  return { valid: true, cursor: value };
}

export function removeOwnVote(page: OwnVotesPage, pair: VotePair): OwnVotesPage {
  const key = votePairKey(pair);
  return { ...page, votes: page.votes.filter((entry) => votePairKey(entry) !== key) };
}

export function replaceOwnVote(page: OwnVotesPage, next: OwnVoteEntry): OwnVotesPage {
  const key = votePairKey(next);
  return {
    ...page,
    votes: page.votes.map((entry) => (votePairKey(entry) === key ? next : entry)),
  };
}
