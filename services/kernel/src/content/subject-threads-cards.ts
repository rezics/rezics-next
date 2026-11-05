import { projectPublicConversationActivity } from './community-projection/index.ts';
import { requireAccessDeadline } from '../access/unavailable.ts';
import { ProblemError } from '../http/problem.ts';
import type { ConversationActivitySelection } from './conversation-activity.ts';
import type { FeedAuthor } from './feed-contract.ts';
import { prepareFeedContentContext } from './feed-context.ts';
import type { AnchoredPosition, FeedParentContext, FeedReviewContext, ReadContext } from './model.ts';
import { readDocumentMediaPresentations, type DocumentImagePresentation } from './media-presentation.ts';
import type { MediaDependencies } from './media.ts';
import {
  createContentReadingCardBatch,
  type ReadingPageDependencies,
  type SelectedReadingCardBatchResult,
  type SelectedReadingCardReference,
} from './reading-page.ts';
import { readSubjectThread } from './reads.ts';
import type { ReactionCountFreshness, ThreadView } from './reads.ts';
import type { SubjectThreadWithReactions } from './subject-threads-reactions.ts';
import {
  staleSubjectThreadActivity,
  type SubjectThreadConversationActivity,
} from './subject-threads-conversation-activity.ts';

export type SubjectThreadCardDependencies = ReadingPageDependencies & MediaDependencies;

type CardAuthor =
  | Readonly<{ state: 'current'; identity: FeedAuthor }>
  | Readonly<{ state: 'unavailable' }>
  | Readonly<{ state: 'withheld' }>;

type CardMedia = Readonly<{
  state: 'none' | 'available' | 'unavailable' | 'withheld';
  images: readonly DocumentImagePresentation[];
}>;

type CardComments =
  | Readonly<{
      state: 'current';
      cohort: 'public';
      count: Readonly<{ kind: 'exact' | 'lower-bound'; value: number }>;
      lastActivityAt: string | null;
      source: Readonly<{ epoch: number; position: string }>;
    }>
  | Readonly<{ state: 'unavailable' | 'withheld' }>;

export type SubjectThreadCard = Readonly<{
  state: 'current' | 'erased';
  authors: Readonly<{ thread: CardAuthor; openingPost: CardAuthor }>;
  presentation:
    | Readonly<{ state: 'current'; language: string | null; spoiler: boolean }>
    | Readonly<{ state: 'withheld' }>;
  media: CardMedia;
  comments: CardComments;
  actions: Readonly<{
    state: 'current' | 'unavailable' | 'not_applicable';
    retryable: boolean;
    references: SelectedReadingCardBatchResult['actions']['references'];
  }>;
  reply: Readonly<{ state: 'available' | 'sign_in_required' | 'denied' | 'withheld' | 'unavailable' }>;
  watch:
    | Readonly<{ state: 'current'; watching: boolean }>
    | Readonly<{ state: 'sign_in_required' }>
    | Readonly<{ state: 'unavailable'; retryable: true }>
    | Readonly<{ state: 'withheld' }>;
  parentContext?: FeedParentContext;
  currentness: Readonly<{
    source: 'current';
    place: 'current';
    authors: 'current' | 'unavailable' | 'not_applicable';
    reactions: 'current' | 'unavailable' | 'not_applicable';
    actions: 'current' | 'unavailable' | 'not_applicable';
    watch: 'current' | 'sign_in_required' | 'unavailable' | 'not_applicable';
    media: 'current' | 'unavailable' | 'not_applicable';
    comments: 'current' | 'unavailable' | 'not_applicable';
  }>;
}>;

export type SubjectThreadCardEntry = Omit<SubjectThreadWithReactions, 'reactions' | 'viewerReaction'> &
  Partial<Pick<SubjectThreadWithReactions, 'reactions' | 'viewerReaction'>> &
  Readonly<{ card: SubjectThreadCard; reviewContext?: FeedReviewContext }>;

export type SubjectThreadCardProjection = Readonly<{
  entries: readonly SubjectThreadCardEntry[];
  anchors: readonly AnchoredPosition[];
  reactionsAsOf: ReactionCountFreshness | null;
}>;

type DocumentNode = Readonly<{
  attrs?: Readonly<Record<string, unknown>>;
  marks?: readonly Readonly<{ type?: string }>[];
  content?: readonly DocumentNode[];
}>;
type CurrentCardSelection = Omit<SelectedReadingCardBatchResult['selected'][number], 'state'> & {
  state: 'current' | 'erased';
};

function presentationOf(body: unknown): Readonly<{ language: string | null; spoiler: boolean }> {
  if (!body || typeof body !== 'object') return { language: null, spoiler: false };
  const pending: DocumentNode[] = [body as DocumentNode];
  let language: string | null = null;
  let spoiler = false;
  while (pending.length) {
    const node = pending.pop()!;
    if (!language && typeof node.attrs?.lang === 'string') language = node.attrs.lang;
    if (node.marks?.some((mark) => mark.type === 'spoiler')) spoiler = true;
    pending.push(...(node.content ?? []));
  }
  return { language, spoiler };
}

function revisionId(thread: SubjectThreadWithReactions): string | null {
  return 'revisionId' in thread.firstPost ? thread.firstPost.revisionId : null;
}

function cardReference(thread: SubjectThreadWithReactions, subjectId: string): SelectedReadingCardReference {
  return {
    type: 'content.thread',
    id: thread.id,
    placeId: thread.boardId,
    sourceRevisionId: revisionId(thread),
    subjectId,
  };
}

function contentReference(thread: SubjectThreadWithReactions) {
  const { reactions: _reactions, viewerReaction: _viewerReaction, ...initialThread } = thread;
  return {
    key: thread.id,
    threadId: thread.id,
    postId: thread.firstPost.id,
    initialThread,
    initialPost: thread.firstPost,
  } as const;
}

function reactionRecord(value: Readonly<Partial<Record<string, number>>> | undefined) {
  return Object.fromEntries(
    Object.entries(value ?? {}).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
}

function assertReactionCurrent(
  thread: SubjectThreadWithReactions,
  reaction: SelectedReadingCardBatchResult['reactions']['items'][number] | undefined,
): boolean {
  if (!reaction || reaction.state !== 'current') return false;
  if (JSON.stringify(reactionRecord(thread.reactions)) !== JSON.stringify(reactionRecord(reaction.counts)))
    throw new ProblemError('dependency_unavailable');
  if (thread.viewerReaction !== reaction.viewerSelection) throw new ProblemError('dependency_unavailable');
  return true;
}

function author(
  state: CurrentCardSelection['state'],
  id: string | undefined,
  authors: SelectedReadingCardBatchResult['authors'],
): CardAuthor {
  if (state === 'erased' || !id) return { state: 'withheld' };
  if (authors.state !== 'current') return { state: 'unavailable' };
  const item = authors.items.find((candidate) => candidate.id === id);
  return item
    ? {
        state: 'current',
        identity: { displayName: item.displayName, handle: item.handle, avatar: item.avatar },
      }
    : { state: 'unavailable' };
}

function comments(
  selection: ConversationActivitySelection | undefined,
  selectedState: CurrentCardSelection['state'],
  postAvailability: SubjectThreadWithReactions['firstPost']['availability'],
): CardComments {
  if (selectedState === 'erased' || postAvailability !== 'available') return { state: 'withheld' };
  if (!selection) throw new ProblemError('dependency_unavailable');
  const activity = projectPublicConversationActivity(selection);
  if (selection.status !== 'current' || activity.state !== 'current') return { state: 'withheld' };
  return {
    ...activity,
    source: {
      epoch: selection.witness.source.epoch,
      position: selection.witness.source.position.toString(),
    },
  };
}

function mediaFor(
  post: SubjectThreadWithReactions['firstPost'],
  selectedState: CurrentCardSelection['state'],
  images: ReadonlyMap<string, DocumentImagePresentation>,
): CardMedia {
  if (selectedState === 'erased') return { state: 'withheld', images: [] };
  if (post.availability !== 'available') return { state: 'unavailable', images: [] };
  if (post.mediaIds.length === 0) return { state: 'none', images: [] };
  const selected = post.mediaIds.map((id) => images.get(id));
  if (selected.some((image) => !image || image.containerId !== post.id)) return { state: 'unavailable', images: [] };
  return { state: 'available', images: selected as DocumentImagePresentation[] };
}

async function readMedia(
  dependencies: SubjectThreadCardDependencies,
  context: ReadContext,
  posts: readonly SubjectThreadWithReactions['firstPost'][],
): Promise<ReadonlyMap<string, DocumentImagePresentation>> {
  requireAccessDeadline(context.deadline);
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const post of posts) {
    if (post.availability !== 'available') continue;
    if (post.mediaIds.length > 32 || new Set(post.mediaIds).size !== post.mediaIds.length)
      throw new ProblemError('dependency_unavailable');
    for (const id of post.mediaIds) {
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
  }
  const images = new Map<string, DocumentImagePresentation>();
  for (let offset = 0; offset < ids.length; offset += 32) {
    requireAccessDeadline(context.deadline);
    const page = await readDocumentMediaPresentations(dependencies, context.actor, ids.slice(offset, offset + 32), {
      deadline: context.deadline,
      routeKey: dependencies.routeKey,
    });
    requireAccessDeadline(context.deadline);
    for (const image of page.images) images.set(image.id, image);
  }
  requireAccessDeadline(context.deadline);
  return images;
}

function watch(
  result: SelectedReadingCardBatchResult,
  threadId: string,
  selectedState: CurrentCardSelection['state'],
): SubjectThreadCard['watch'] {
  if (selectedState === 'erased') return { state: 'withheld' };
  if (result.watch.state === 'sign_in_required') return { state: 'sign_in_required' };
  if (result.watch.state === 'unavailable') return { state: 'unavailable', retryable: true };
  const item = result.watch.items.find((candidate) => candidate.threadId === threadId);
  if (!item) throw new ProblemError('dependency_unavailable');
  if (item.state === 'current' && item.watching !== undefined) return { state: 'current', watching: item.watching };
  if (item.state === 'sign_in_required') return { state: 'sign_in_required' };
  return { state: 'unavailable', retryable: true };
}

function equalNativeThread(selected: SubjectThreadWithReactions, current: ThreadView | null): boolean {
  if (!current) return false;
  const { reactions: _reactions, viewerReaction: _viewerReaction, ...source } = selected;
  return JSON.stringify(source) === JSON.stringify(current);
}

/** Adds bounded card fields around Subject's selected native threads and retains every final source check. */
export async function projectSubjectThreadCards(
  dependencies: SubjectThreadCardDependencies,
  subjectId: string,
  placeId: string,
  selected: readonly SubjectThreadWithReactions[],
  context: ReadContext,
  activitySnapshot: SubjectThreadConversationActivity,
  reactionsAsOf: SubjectThreadCardProjection['reactionsAsOf'],
  finalDisclosure: () => Promise<void>,
): Promise<SubjectThreadCardProjection> {
  if (selected.length > 20) throw new RangeError('At most 20 Subject thread cards');
  if (selected.length === 0) {
    await finalDisclosure();
    return { entries: [], anchors: [], reactionsAsOf: null };
  }

  const references = selected.map((thread) => cardReference(thread, subjectId));
  const cards = await createContentReadingCardBatch(dependencies, references, context.actor, context.deadline);
  const initialActivity = activitySnapshot.selected;
  const content = await prepareFeedContentContext(dependencies, selected.map(contentReference), context, [], {
    observeThreads: (threadIds, current) =>
      Promise.all(
        threadIds.map(async (threadId) => await readSubjectThread(dependencies, threadId, subjectId, placeId, current)),
      ),
  });

  const cardResult = await cards.finish();
  const contentResult = await content.finish();
  const cardById = new Map(cardResult.selected.map((item) => [item.reference.id, item]));
  const mediaPosts: SubjectThreadWithReactions['firstPost'][] = [];
  type FeedContextValue = NonNullable<ReturnType<typeof contentResult.contexts.get>>;
  const ready: {
    thread: SubjectThreadWithReactions;
    selected: CurrentCardSelection;
    post: NonNullable<FeedContextValue['post']>;
    context: FeedContextValue;
  }[] = [];

  for (const thread of selected) {
    const selectedCard = cardById.get(thread.id);
    if (!selectedCard) throw new ProblemError('dependency_unavailable');
    if (selectedCard.state === 'withheld') continue;
    const currentSelection: CurrentCardSelection = {
      ...selectedCard,
      state: selectedCard.state === 'erased' ? 'erased' : 'current',
    };
    const composed = contentResult.contexts.get(thread.id);
    if (!composed?.thread || !composed.post) continue;
    if (
      !equalNativeThread(thread, composed.thread) ||
      JSON.stringify(thread.firstPost) !== JSON.stringify(composed.post)
    )
      throw new ProblemError('dependency_unavailable');
    if (currentSelection.state === 'current') mediaPosts.push(composed.post);
    ready.push({ thread, selected: currentSelection, post: composed.post, context: composed });
  }

  const images = await readMedia(dependencies, context, mediaPosts);
  await finalDisclosure();
  const finalActivity = await activitySnapshot.confirm(context.deadline);
  if (staleSubjectThreadActivity(finalActivity)) throw new ProblemError('dependency_unavailable');
  const activityById = new Map(finalActivity.map((item) => [item.threadId, item]));
  const entries: SubjectThreadCardEntry[] = [];
  let hasCurrentReaction = false;
  for (const item of ready) {
    const activitySelection = activityById.get(item.thread.id);
    const reactions = cardResult.reactions.items.find(
      (reaction) => reaction.type === 'content.thread' && reaction.id === item.thread.id,
    );
    const reactionCurrent =
      item.selected.state === 'current' &&
      cardResult.currentness.reactions === 'current' &&
      assertReactionCurrent(item.thread, reactions);
    if (reactionCurrent) hasCurrentReaction = true;
    const threadAuthorId = item.thread.authorId;
    const openingAuthorId =
      item.post.availability === 'available' && 'authorId' in item.post ? item.post.authorId : undefined;
    const actionReferences =
      item.selected.state === 'current' && cardResult.actions.state === 'current'
        ? cardResult.actions.references.filter(
            (reference) => reference.id === item.thread.id || reference.id === item.post.id,
          )
        : [];
    const reply = item.selected.state === 'current' ? item.selected.reply : { state: 'withheld' as const };
    const cardMedia = mediaFor(item.post, item.selected.state, images);
    const presentation =
      item.selected.state === 'current' && item.post.availability === 'available'
        ? { state: 'current' as const, ...presentationOf(item.post.body) }
        : { state: 'withheld' as const };
    const commentView = comments(activitySelection, item.selected.state, item.post.availability);
    const authorView = {
      thread: author(item.selected.state, threadAuthorId, cardResult.authors),
      openingPost: author(item.selected.state, openingAuthorId, cardResult.authors),
    };
    const authorsCurrent =
      cardResult.authors.state === 'current' &&
      authorView.thread.state !== 'unavailable' &&
      authorView.openingPost.state !== 'unavailable';
    const watchView = watch(cardResult, item.thread.id, item.selected.state);
    const card: SubjectThreadCard = {
      state: item.selected.state,
      authors: authorView,
      presentation,
      media: cardMedia,
      comments: commentView,
      actions: {
        state: item.selected.state === 'erased' ? 'not_applicable' : cardResult.actions.state,
        retryable: item.selected.state !== 'erased' && cardResult.actions.retryable,
        references: actionReferences.filter((reference) => reference.state === 'current'),
      },
      reply,
      watch: watchView,
      ...(item.context.parentContext ? { parentContext: item.context.parentContext } : {}),
      currentness: {
        source: 'current',
        place: 'current',
        authors: item.selected.state === 'current' ? (authorsCurrent ? 'current' : 'unavailable') : 'not_applicable',
        reactions: item.selected.state === 'erased' ? 'not_applicable' : reactionCurrent ? 'current' : 'unavailable',
        actions: item.selected.state === 'erased' ? 'not_applicable' : cardResult.currentness.actions,
        watch:
          item.selected.state === 'erased'
            ? 'not_applicable'
            : watchView.state === 'current'
              ? 'current'
              : watchView.state === 'sign_in_required'
                ? 'sign_in_required'
                : 'unavailable',
        media:
          cardMedia.state === 'none' || cardMedia.state === 'available'
            ? 'current'
            : cardMedia.state === 'withheld'
              ? 'not_applicable'
              : 'unavailable',
        comments:
          commentView.state === 'current'
            ? 'current'
            : commentView.state === 'withheld'
              ? 'not_applicable'
              : 'unavailable',
      },
    };
    const { reactions: _counts, viewerReaction: _viewerReaction, ...withoutReactions } = item.thread;
    const exposeReactions = reactionCurrent;
    entries.push({
      ...(exposeReactions ? item.thread : withoutReactions),
      ...(item.selected.state === 'current' && item.context.reviewContext
        ? { reviewContext: item.context.reviewContext }
        : {}),
      card,
    });
  }

  const anchors: AnchoredPosition[] = [
    ...cardResult.anchors,
    ...contentResult.anchors,
    ...initialActivity.flatMap((item) => (item.status === 'current' ? [item.witness.source] : [])),
    ...finalActivity.flatMap((item) => (item.status === 'current' ? [item.witness.source] : [])),
  ];
  return { entries, anchors, reactionsAsOf: hasCurrentReaction ? reactionsAsOf : null };
}
