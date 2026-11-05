import {
  projectCommunityActivitySelection,
  projectCommunityCommentsBatch,
  type CommunityActivityRead,
  type CommunityComments,
} from './community-projection/index.ts';
import { isDeepStrictEqual } from 'node:util';
import { readPublicIdentities, type PublicIdentity } from '../access/account-data.ts';
import { deadlineClient, within } from '../access/authenticate.ts';
import { routeOf } from '../route/route.ts';
import type { ContentCommandDependencies } from './commands.ts';
import {
  listBoardOpeningThreads,
  readRealmBoard,
  type ContentBoardDependencies,
  type BoardThreadPage,
} from './boards.ts';
import type { DocumentImagePresentation } from './media-presentation.ts';
import { readDocumentMediaPresentations } from './media-presentation.ts';
import { withConnection } from '../database/pool.ts';
import {
  readBoardPageActionEvidence,
  withReactionCountsAndCoverage,
  withViewerReactions,
  ContentNotFoundError,
  type ContentReadDependencies,
  type ReactionCountFreshness,
  type ThreadView,
  type ViewerReactionKind,
} from './reads.ts';
import type { AnchoredPosition, BoardView, ReadContext } from './model.ts';
import type { Actor } from '../request/access.ts';
import type { RealmParticipationReadDecision } from '../community/participation.ts';
import { createConversationActivityBatch, type ConversationActivitySelection } from './conversation-activity.ts';

export type BoardOpeningSort = 'new' | 'active' | 'hot';
export type BoardOpeningInput = Readonly<{ cursor?: string; sort?: BoardOpeningSort }>;
export type BoardAdvice = 'allowed' | 'denied' | 'sign-in' | 'unavailable';
export type BoardOpeningAuthor =
  | Readonly<{
      state: 'available';
      id: string;
      kind: 'actor' | 'organization';
      handle: string | null;
      displayName: string | null;
      automated: boolean;
    }>
  | Readonly<{ state: 'unavailable' }>;
export type BoardOpeningMedia = Readonly<
  | { state: 'none'; images: readonly [] }
  | { state: 'available'; images: readonly DocumentImagePresentation[] }
  | { state: 'unavailable'; images: readonly [] }
>;
type BoardOpeningActivityReader = (
  threadIds: readonly string[],
  context: Readonly<{ actor: Actor; deadline: number }>,
) => Promise<CommunityActivityRead<AnchoredPosition>>;
export type BoardOpeningCard = Readonly<{
  thread: ThreadView;
  target: Readonly<{ kind: 'thread'; id: string; boardId: string }>;
  authors: Readonly<{ thread: BoardOpeningAuthor; openingPost: BoardOpeningAuthor }>;
  media: BoardOpeningMedia;
  interaction: Readonly<{
    target: Readonly<{ kind: 'thread'; id: string }>;
    counts:
      | Readonly<{ state: 'as-of'; values: Readonly<Partial<Record<string, number>>>; source: ReactionCountFreshness }>
      | Readonly<{ state: 'unavailable' }>;
    viewer: Readonly<{ state: 'current'; reaction: string | null }> | Readonly<{ state: 'not-applicable' }>;
  }>;
  comments: CommunityComments;
  actions: Readonly<{ reply: BoardAdvice; react: BoardAdvice; share: 'available' }>;
}>;
export type BoardOpeningPage = Readonly<{
  board: BoardView;
  pinRevision: string;
  pinnedThreads: readonly BoardOpeningCard[];
  threads: readonly BoardOpeningCard[];
  next: string | null;
  rankRefreshedAt: string | null;
  reactionsAsOf: ReactionCountFreshness | null;
  viewer: Readonly<{ participation: BoardAdvice }>;
  actions: Readonly<{ createThread: BoardAdvice }>;
  anchors: readonly AnchoredPosition[];
}>;

export type BoardOpeningDependencies = ContentBoardDependencies &
  Pick<ContentCommandDependencies, 'realmParticipation' | 'routeKey'> & {
    /** Installed by the conversation-activity producer when its current witness reader is delivered. */
    readConversationActivityBatch?: BoardOpeningActivityReader;
  };
type ActiveIdentity = Extract<PublicIdentity, { state: 'active' }>;

export class BoardOpeningChangedError extends Error {
  constructor() {
    super('The Board opening page changed while it was being assembled');
    this.name = 'BoardOpeningChangedError';
  }
}

function nativeSort(sort: BoardOpeningSort | undefined): 'newest' | 'active' | 'hot' {
  return sort === 'active' || sort === 'hot' ? sort : 'newest';
}

function availablePost(thread: ThreadView) {
  return thread.firstPost.availability === 'available' ? thread.firstPost : null;
}

function accountIdsFor(threads: readonly ThreadView[]): string[] {
  const ids = new Set<string>();
  for (const thread of threads) {
    ids.add(thread.authorId);
    const post = availablePost(thread);
    if (post) ids.add(post.authorId);
  }
  return [...ids];
}

async function readAuthors(
  dependencies: BoardOpeningDependencies,
  ids: readonly string[],
  deadline: number,
): Promise<ReadonlyMap<string, BoardOpeningAuthor>> {
  if (ids.length > 50) throw new RangeError('Board opening author projection exceeds fifty identities');
  if (ids.length === 0) return new Map();
  const routes = ids.map((id) => routeOf(id));
  if (routes.some((route) => route === null)) throw new TypeError('Invalid Board opening author identity');
  const identities = await within(deadline, () =>
    withConnection(dependencies.pool, (client) => readPublicIdentities(client, routes as number[], ids)),
  );
  const found = new Map<string, ActiveIdentity>(
    identities
      .filter((identity): identity is ActiveIdentity => identity.state === 'active')
      .map((identity) => [identity.id, identity]),
  );
  return new Map(
    ids.map((id) => {
      const identity = found.get(id);
      return [
        id,
        identity
          ? {
              state: 'available' as const,
              id: identity.id,
              kind: identity.kind,
              handle: identity.handle,
              displayName: identity.displayName,
              automated: identity.automated,
            }
          : { state: 'unavailable' as const },
      ];
    }),
  );
}

async function readMedia(
  dependencies: BoardOpeningDependencies,
  actor: Actor,
  threads: readonly ThreadView[],
  deadline: number,
): Promise<ReadonlyMap<string, DocumentImagePresentation>> {
  const ids = [...new Set(threads.flatMap((thread) => availablePost(thread)?.mediaIds ?? []))];
  if (ids.length === 0) return new Map();
  const mediaDependencies = {
    pool: dependencies.pool,
    access: dependencies.access,
    ...(dependencies.realmParticipation ? { realmParticipation: dependencies.realmParticipation } : {}),
    ...(dependencies.clock ? { clock: dependencies.clock } : {}),
  };
  const images = new Map<string, DocumentImagePresentation>();
  for (let offset = 0; offset < ids.length; offset += 32) {
    const batch = ids.slice(offset, offset + 32);
    const page = await readDocumentMediaPresentations(mediaDependencies, actor, batch, {
      deadline,
      routeKey: dependencies.routeKey,
    });
    for (const image of page.images) images.set(image.id, image);
  }
  return images;
}

async function participationAdvice(
  dependencies: BoardOpeningDependencies,
  actor: Actor,
  board: BoardView,
  deadline: number,
): Promise<Readonly<{ status: BoardAdvice; allowed: boolean }>> {
  if (actor.kind === 'anonymous') return { status: 'sign-in', allowed: false };
  if (board.realmId === null) return { status: 'allowed', allowed: true };
  if (!dependencies.realmParticipation) return { status: 'unavailable', allowed: false };
  const readDecision: RealmParticipationReadDecision = {};
  const allowed = await within(deadline, () =>
    dependencies.realmParticipation!(deadlineClient(dependencies.pool, deadline), {
      realmId: board.realmId!,
      actor,
      readDecision,
    }),
  );
  if (readDecision.readable === false) throw new ContentNotFoundError();
  return { status: allowed ? 'allowed' : 'denied', allowed };
}

function advice(actor: Actor, participation: BoardAdvice, allowed: boolean): BoardAdvice {
  if (actor.kind === 'anonymous') return 'sign-in';
  if (participation === 'unavailable') return 'unavailable';
  if (participation !== 'allowed') return 'denied';
  return allowed ? 'allowed' : 'denied';
}

function imageProjection(
  thread: ThreadView,
  images: ReadonlyMap<string, DocumentImagePresentation>,
): BoardOpeningMedia {
  const post = availablePost(thread);
  if (!post || post.mediaIds.length === 0) return { state: 'none', images: [] };
  const selected = post.mediaIds.map((id) => images.get(id));
  if (selected.some((image) => !image || image.containerId !== post.id)) return { state: 'unavailable', images: [] };
  return { state: 'available', images: selected as DocumentImagePresentation[] };
}

const unavailableComments: CommunityComments = { state: 'unavailable' };

/** Binds one selected producer cohort to the Board page's initial and final observations. */
function createConversationActivityReader(dependencies: BoardOpeningDependencies): BoardOpeningActivityReader {
  const activity = createConversationActivityBatch(dependencies.pool);
  let observed = false;
  let selectedIds: readonly string[] = [];
  let selected: readonly ConversationActivitySelection[] = [];
  return async (threadIds, { deadline }) => {
    if (!observed) {
      observed = true;
      selectedIds = [...threadIds];
      selected = await activity.select(threadIds, deadline);
      return projectCommunityActivitySelection(selected);
    }
    if (!isDeepStrictEqual(selectedIds, threadIds)) throw new BoardOpeningChangedError();
    return projectCommunityActivitySelection(await activity.confirm(selected, deadline));
  };
}

export function projectBoardOpeningReactionCounts(
  interactionReady: boolean,
  values: Readonly<Partial<Record<ViewerReactionKind, number>>> | undefined,
  source: ReactionCountFreshness | undefined,
): BoardOpeningCard['interaction']['counts'] {
  if (!interactionReady || !values || !source) return { state: 'unavailable' };
  return { state: 'as-of', values: { ...values }, source: { ...source } };
}

type BoardActivityProjection = Readonly<{
  comments: ReadonlyMap<string, CommunityComments>;
  anchors: readonly AnchoredPosition[];
}>;

async function readBoardActivity(
  dependencies: BoardOpeningDependencies,
  actor: Actor,
  threads: readonly ThreadView[],
  deadline: number,
): Promise<BoardActivityProjection> {
  const threadIds = threads
    .filter((thread) => thread.availability === 'available' && availablePost(thread) !== null)
    .map((thread) => thread.id);
  if (threadIds.length > 25) throw new RangeError('Board opening activity accepts at most twenty-five threads');
  const comments = new Map<string, CommunityComments>(threadIds.map((id) => [id, unavailableComments]));
  if (threadIds.length === 0 || !dependencies.readConversationActivityBatch) return { comments, anchors: [] };

  const result = await within(deadline, () =>
    dependencies.readConversationActivityBatch!(threadIds, { actor, deadline }),
  );
  return {
    comments: projectCommunityCommentsBatch(threadIds, result.items, actor),
    anchors: result.anchors,
  };
}

function reactionProjectionView(projection: Awaited<ReturnType<typeof withReactionCountsAndCoverage>>) {
  return {
    items: projection.items.map((item) => ({ id: item.id, reactions: 'reactions' in item ? item.reactions : null })),
    targetFreshness: [...projection.targetFreshness].sort((left, right) => left.id.localeCompare(right.id)),
    reactionsAsOf: projection.reactionsAsOf,
  };
}

function viewerReactionView<T extends { readonly id: string; readonly viewerReaction?: string | null }>(
  items: readonly T[],
) {
  return items.map((item) => [item.id, item.viewerReaction ?? null] as const);
}

function assertSamePage(
  board: BoardView,
  first: BoardThreadPage,
  currentBoard: BoardView | null,
  current: BoardThreadPage,
): void {
  if (!currentBoard || !isDeepStrictEqual(board, currentBoard)) throw new BoardOpeningChangedError();
  if (
    first.pinRevision !== current.pinRevision ||
    !isDeepStrictEqual(first.pinnedThreads, current.pinnedThreads) ||
    !isDeepStrictEqual(first.entries, current.entries) ||
    (first.nextCursor === null) !== (current.nextCursor === null) ||
    first.rankRefreshedAt !== current.rankRefreshedAt
  )
    throw new BoardOpeningChangedError();
}

/** Native one-call opening envelope for the existing Web Board reader. */
export function createBoardPageReader(dependencies: BoardOpeningDependencies) {
  const readDependencies = (): ContentReadDependencies => ({
    pool: dependencies.pool,
    get access() {
      return dependencies.access;
    },
    tokens: dependencies.tokens,
    ...(dependencies.clock ? { clock: dependencies.clock } : {}),
  });
  return async function readBoardOpeningPage(
    boardId: string,
    context: ReadContext,
    input: BoardOpeningInput = {},
  ): Promise<BoardOpeningPage> {
    if (input.sort !== undefined && input.sort !== 'new' && input.sort !== 'active' && input.sort !== 'hot')
      throw new TypeError('Invalid content cursor');
    if (input.cursor !== undefined && (input.cursor.length < 1 || input.cursor.length > 4096))
      throw new TypeError('Invalid content cursor');
    const sort = nativeSort(input.sort);
    const activityDependencies = dependencies.readConversationActivityBatch
      ? dependencies
      : { ...dependencies, readConversationActivityBatch: createConversationActivityReader(dependencies) };
    const selectedBoard = await readRealmBoard(dependencies, boardId, context);
    if (!selectedBoard.value) throw new ContentNotFoundError();
    const selectedPage = await listBoardOpeningThreads(dependencies, boardId, context, {
      ...(input.cursor ? { cursor: input.cursor } : {}),
      sort,
    });
    const selectedThreads = [...selectedPage.pinnedThreads, ...selectedPage.entries];
    const uniqueThreads = [...new Map(selectedThreads.map((thread) => [thread.id, thread])).values()];
    const actionThreads = uniqueThreads.filter(
      (thread) => thread.availability === 'available' && thread.firstPost.availability === 'available',
    );
    const targets = actionThreads.map((thread) => ({ id: thread.id }));
    const reads = readDependencies();
    const initialCounts = await withReactionCountsAndCoverage(reads, targets, context.deadline);
    const initialViewers = await withViewerReactions(reads, context.actor, targets, context.deadline);
    const initialActivity = await readBoardActivity(
      activityDependencies,
      context.actor,
      uniqueThreads,
      context.deadline,
    );
    const authorIds = accountIdsFor(uniqueThreads);
    const authors = await readAuthors(dependencies, authorIds, context.deadline);
    const images = await readMedia(dependencies, context.actor, uniqueThreads, context.deadline);
    const currentAuthors = await readAuthors(dependencies, authorIds, context.deadline);
    if (!isDeepStrictEqual(authors, currentAuthors)) throw new BoardOpeningChangedError();
    const currentImages = await readMedia(dependencies, context.actor, uniqueThreads, context.deadline);
    if (!isDeepStrictEqual(images, currentImages)) throw new BoardOpeningChangedError();

    const participation = await participationAdvice(dependencies, context.actor, selectedBoard.value, context.deadline);
    const actionEvidence = await readBoardPageActionEvidence(
      reads,
      boardId,
      selectedBoard.value,
      actionThreads.map((thread) => thread.id),
      context,
    );
    const counted = await withReactionCountsAndCoverage(reads, targets, context.deadline);
    const viewers = await withViewerReactions(reads, context.actor, targets, context.deadline);
    const finalActivity = await readBoardActivity(activityDependencies, context.actor, uniqueThreads, context.deadline);
    if (
      !isDeepStrictEqual(reactionProjectionView(initialCounts), reactionProjectionView(counted)) ||
      !isDeepStrictEqual(viewerReactionView(initialViewers), viewerReactionView(viewers)) ||
      !isDeepStrictEqual(initialActivity.comments, finalActivity.comments)
    )
      throw new BoardOpeningChangedError();
    const countedById = new Map(counted.items.map((item) => [item.id, item]));
    const viewerById = new Map(viewers.map((item) => [item.id, item]));
    const targetFreshness = new Map(counted.targetFreshness.map((item) => [item.id, item.source]));

    const finalBoard = await readRealmBoard(dependencies, boardId, context);
    const finalPage = await listBoardOpeningThreads(dependencies, boardId, context, {
      ...(input.cursor ? { cursor: input.cursor } : {}),
      sort,
    });
    assertSamePage(selectedBoard.value, selectedPage, finalBoard.value, finalPage);

    const card = (thread: ThreadView): BoardOpeningCard => {
      const post = availablePost(thread);
      const interactionReady = thread.availability === 'available' && post !== null;
      const countedThread = countedById.get(thread.id);
      const viewerThread = viewerById.get(thread.id);
      const aggregate = countedThread && 'reactions' in countedThread ? countedThread.reactions : undefined;
      const source = interactionReady && aggregate ? targetFreshness.get(thread.id) : undefined;
      return {
        thread,
        target: { kind: 'thread', id: thread.id, boardId: thread.boardId },
        authors: {
          thread: authors.get(thread.authorId) ?? { state: 'unavailable' },
          openingPost: post ? (authors.get(post.authorId) ?? { state: 'unavailable' }) : { state: 'unavailable' },
        },
        media: imageProjection(thread, currentImages),
        interaction: {
          target: { kind: 'thread', id: thread.id },
          counts: projectBoardOpeningReactionCounts(interactionReady, aggregate, source),
          viewer:
            context.actor.kind === 'account' && interactionReady
              ? { state: 'current', reaction: viewerThread?.viewerReaction ?? null }
              : { state: 'not-applicable' },
        },
        comments: finalActivity.comments.get(thread.id) ?? unavailableComments,
        actions: {
          reply: advice(
            context.actor,
            participation.status,
            interactionReady && actionEvidence.threads.get(thread.id)?.reply === true,
          ),
          react: advice(
            context.actor,
            participation.status,
            interactionReady && actionEvidence.threads.get(thread.id)?.react === true,
          ),
          share: 'available',
        },
      };
    };

    return {
      board: finalBoard.value!,
      pinRevision: finalPage.pinRevision,
      pinnedThreads: finalPage.pinnedThreads.map(card),
      threads: finalPage.entries.map(card),
      next: finalPage.nextCursor,
      rankRefreshedAt: finalPage.rankRefreshedAt,
      reactionsAsOf: counted.reactionsAsOf,
      viewer: { participation: participation.status },
      actions: {
        createThread: advice(context.actor, participation.status, actionEvidence.createThread),
      },
      anchors: [
        selectedBoard.anchor,
        ...selectedPage.anchors,
        finalBoard.anchor,
        ...finalPage.anchors,
        ...finalActivity.anchors,
        ...actionEvidence.anchors,
      ],
    };
  };
}
