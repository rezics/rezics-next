import type { BoardPageResponse } from '@rezics/client';
import { boardCommunitySource } from './board-community-source';
import { validBoardPinRevision } from './board-pins/contract';

export type BoardOpeningCard = BoardPageResponse['threads'][number];
export type BoardOpeningReactionOrigin = Readonly<{
  key: string;
  reader: string | null;
  isCurrent(): boolean;
}>;
type AvailableAuthor = Extract<BoardOpeningCard['authors']['thread'], { state: 'available' }>;

function retainOpeningCard(card: BoardOpeningCard): BoardOpeningCard {
  const counts = card.interaction.counts;
  const comments = card.comments;
  return {
    ...card,
    actions: { ...card.actions },
    interaction: {
      ...card.interaction,
      target: { ...card.interaction.target },
      counts:
        counts.state === 'as-of'
          ? { ...counts, values: { ...counts.values }, source: { ...counts.source } }
          : { ...counts },
      viewer: { ...card.interaction.viewer },
    },
    comments:
      comments.state === 'current'
        ? { ...comments, count: { ...comments.count }, source: { ...comments.source } }
        : { ...comments },
  };
}

/** One supplied response, one replacing page. No identity or media enrichment. */
export function receiveBoardOpeningPage(response: BoardPageResponse, now = new Date().toISOString()) {
  const openingCards: Record<string, BoardOpeningCard> = {};
  const authors: Record<string, AvailableAuthor> = {};
  for (const card of [...response.pinnedThreads, ...response.threads]) {
    // The initial pin observation wins an overlapping ordinary identity.
    if (Object.hasOwn(openingCards, card.thread.id)) continue;
    const selected = retainOpeningCard(card);
    openingCards[selected.thread.id] = selected;
    if (selected.thread.availability !== 'available') continue;
    for (const author of [selected.authors.thread, selected.authors.openingPost])
      if (author.state === 'available') authors[author.id] ??= author;
  }
  const pinRevision =
    response &&
    typeof response === 'object' &&
    !Array.isArray(response) &&
    'pinRevision' in response &&
    validBoardPinRevision(response.pinRevision)
      ? response.pinRevision
      : undefined;
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
      ...(pinRevision === undefined ? {} : { pinRevision }),
    },
    authors,
    now,
  };
}

export type ReceivedBoardOpeningPage = ReturnType<typeof receiveBoardOpeningPage>;

/** Advice never opens a signed-in mutation slot without the reaction owner's reconciliation contract. */
export function boardOpeningReaction(card: BoardOpeningCard, signedIn: boolean, origin: BoardOpeningReactionOrigin) {
  const counts = card.interaction.counts;
  const admitted =
    signedIn &&
    card.actions.react === 'allowed' &&
    card.interaction.viewer.state === 'current' &&
    origin.reader !== null &&
    origin.isCurrent();
  return {
    target: card.interaction.target,
    counts: counts.state === 'as-of' ? { ...counts.values } : {},
    value: card.interaction.viewer.state === 'current' ? card.interaction.viewer.reaction : null,
    personalReady: admitted,
    signInAllowed: card.actions.react === 'sign-in',
    settleWithRead: admitted,
    reactionOrigin: { ...origin },
    ...(counts.state === 'as-of' ? { sourceWatermark: { ...counts.source } } : {}),
  };
}
