import type { BoardPageResponse } from '@rezics/client';
import { boardCommunitySource } from './board-community-source';

export type BoardOpeningCard = BoardPageResponse['threads'][number];
type AvailableAuthor = Extract<BoardOpeningCard['authors']['thread'], { state: 'available' }>;

/** One supplied response, one replacing page. No identity or media enrichment. */
export function receiveBoardOpeningPage(response: BoardPageResponse, now = new Date().toISOString()) {
  const openingCards: Record<string, BoardOpeningCard> = {};
  const authors: Record<string, AvailableAuthor> = {};
  for (const card of [...response.pinnedThreads, ...response.threads]) {
    // The initial pin observation wins an overlapping ordinary identity.
    if (Object.hasOwn(openingCards, card.thread.id)) continue;
    openingCards[card.thread.id] = card;
    if (card.thread.availability !== 'available') continue;
    for (const author of [card.authors.thread, card.authors.openingPost])
      if (author.state === 'available') authors[author.id] ??= author;
  }
  return {
    board: response.board,
    community: boardCommunitySource(response.board),
    openingCards,
    viewer: response.viewer,
    actions: response.actions,
    threads: {
      pinnedThreads: response.pinnedThreads.map((card) => card.thread),
      threads: response.threads.map((card) => card.thread),
      next: response.next,
      rankRefreshedAt: response.rankRefreshedAt,
    },
    authors,
    now,
  };
}

export type ReceivedBoardOpeningPage = ReturnType<typeof receiveBoardOpeningPage>;

/** Advice never opens a signed-in mutation slot without the reaction owner's reconciliation contract. */
export function boardOpeningReaction(
  card: BoardOpeningCard,
  _signedIn: boolean,
  origin: { key: string; isCurrent(): boolean },
) {
  const counts = card.interaction.counts;
  return {
    target: card.interaction.target,
    counts: counts.state === 'as-of' ? counts.values : {},
    value: card.interaction.viewer.state === 'current' ? card.interaction.viewer.reaction : null,
    personalReady: false,
    signInAllowed: card.actions.react === 'sign-in',
    settleWithRead: false,
    reactionOrigin: { ...origin, reader: null },
    ...(counts.state === 'as-of' ? { sourceWatermark: counts.source } : {}),
  };
}
