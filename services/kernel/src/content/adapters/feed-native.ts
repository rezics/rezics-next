import type { Actor } from '../../request/access.ts';
import { AuthenticationError } from '../../access/contract/authentication.ts';
import { ProblemError } from '../../http/problem-error.ts';
import {
  ContentNotFoundError,
  discloseThreads,
  readBoard,
  readPost,
  type PostEntry,
  type ThreadView,
} from '../reads.ts';
import { createFeedActivityStore, feedRoute, type ActivityRef } from '../feed-activity.ts';
import { createConversationActivityBatch } from '../conversation-activity.ts';
import {
  feedActivityLanesForThreads,
  feedActivityReferences,
  projectFeedConversationActivity,
  staleFeedActivityThreads,
} from '../feed-conversation-activity.ts';
import { decodeFeedCursor, encodeFeedCursor, feedBinding, fingerprint } from '../feed-cursor.ts';
import { feedExcerpt, feedAuthor } from '../feed-summary.ts';
import { prepareFeedContentContext, type FeedContentContextReference } from '../feed-context.ts';
import { projectFeedReactions } from '../feed-reactions.ts';
import { prepareFeedReactionAdvice, type FeedReactionAdviceComposition } from '../feed-reaction-advice.ts';
import { prepareFeedSubjectReactions } from '../feed-subject-reactions.ts';
import { feedDiscoveryItem } from '../feed-discovery.ts';
import { openFollowingSpace, type FollowingSpace } from '../feed-space.ts';
import { openSpaceSubjectPopulation, type SpaceSubjectPopulation } from '../feed-subject-scope.ts';
import { composeFeedViewerPersonalActions } from '../feed-viewer.ts';
import type { FeedDependencies, FeedProducerCapabilities } from './feed-capabilities.ts';
export type { FeedDependencies } from './feed-capabilities.ts';
import { isDiscoveryReview, isFollowingPost, isFollowingThread } from '../core/index.ts';
import type {
  FeedActor,
  FeedApplicationPorts,
  FeedContinuationPort,
  FeedDiscoveryPort,
  FeedItem,
  FeedLane,
  FeedPresentationPort,
  FeedPublicSummary,
  FeedPublicSummaryPort,
  FeedRefusalCode,
  FeedSourceState,
} from '../contract/index.ts';

function asPlatformActor(actor: FeedActor, live: Actor): Actor {
  if (actor.kind === 'anonymous') return { kind: 'anonymous' };
  if (live.kind !== 'account' || live.accountId !== actor.accountId) throw new ProblemError('forbidden');
  return live;
}

function sourceState(error: unknown, suppliers: FeedProducerCapabilities): FeedSourceState {
  if (suppliers.isDeadline(error)) throw new ProblemError('deadline_exceeded');
  if (error instanceof AuthenticationError || suppliers.isAdmissionFailure(error)) throw error;
  if (error instanceof ProblemError) {
    if (
      [
        'forbidden',
        'platform_closed',
        'invalid_request',
        'unsupported_query',
        'invalid_cursor',
        'stale_cursor',
        'search_restart_required',
        'deadline_exceeded',
        'authentication_required',
        'invalid_credentials',
      ].includes(error.code)
    )
      throw error;
    if (['semantic_not_ready', 'index_not_ready'].includes(error.code)) return 'preparing';
  }
  return 'unavailable';
}

function refuse(code: FeedRefusalCode): never {
  if (code === 'authentication_required') throw new AuthenticationError(401, 'Bearer');
  throw new ProblemError(code);
}

/** Request-scoped native producers for the Content feed application. */
export function createNativeFeedPorts(
  deps: FeedDependencies,
  liveActor: () => Actor,
  capabilities: FeedProducerCapabilities,
): FeedApplicationPorts {
  const activities = createFeedActivityStore(deps);
  const producers = capabilities.create(deps, activities);
  const content = { ...deps, access: deps.contentAccess };
  const contextSources = new Map<string, Readonly<{ thread: ThreadView; post?: PostEntry }>>();
  const activitySources = new Map<string, ActivityRef>();
  const contextWitnesses = new Map<string, string>();
  let contextReferences: Array<FeedContentContextReference & { source: 'discovery' | 'following' }> = [];
  let initialActivity: Awaited<ReturnType<ReturnType<typeof createConversationActivityBatch>['select']>> = [];
  let conversation = createConversationActivityBatch(deps.pool);
  let space: FollowingSpace | undefined;
  let spacePopulation: SpaceSubjectPopulation | undefined;
  let reactionAdvice: FeedReactionAdviceComposition | undefined;

  async function supported(activity: ActivityRef, actor: Actor, deadline: number): Promise<boolean> {
    const status = (await producers.checkCurrentFollowSupport(actor, { targets: [activity.target] }, deadline))[0]
      ?.status;
    if (status === 'unavailable') throw new ProblemError('dependency_unavailable');
    return status === 'following';
  }

  async function hydrate(
    activity: ActivityRef,
    actor: Actor,
    deadline: number,
    summaries: ReadonlyMap<string, FeedPublicSummary | null>,
    threads: ReadonlyMap<string, ThreadView | null>,
    authors: Map<string, string>,
    followingSpace?: FollowingSpace,
  ): Promise<FeedItem | null> {
    if (!(await supported(activity, actor, deadline))) return null;
    const object = activity.object;
    if (activity.target.type === 'subject' && !summaries.get(activity.target.id)) return null;
    let item: FeedItem | null = null;
    if (object.owner === 'content') {
      const thread = threads.get(object.threadId);
      if (!thread || thread.availability !== 'available' || thread.firstPost.availability !== 'available') return null;
      if (
        object.kind === 'thread' &&
        activity.target.type === 'subject' &&
        !thread.subjectIds.includes(activity.target.id)
      )
        return null;
      if (activity.target.type === 'space') {
        if (followingSpace && activity.target.id !== followingSpace.spaceId) return null;
        if (followingSpace) {
          if (!(await followingSpace.containsBoard(thread.boardId))) return null;
        } else {
          const board = (await readBoard(content, thread.boardId, { actor, deadline })).value;
          if (!board || board.community?.spaceId !== activity.target.id) return null;
        }
      }
      if (followingSpace && activity.target.type !== 'space' && !(await followingSpace.containsBoard(thread.boardId)))
        return null;
      let entry = thread.firstPost;
      let postAt = thread.createdAt;
      if (object.kind === 'post') {
        const post = (await readPost(content, object.threadId, object.id, { actor, deadline })).value;
        if (!post || post.availability !== 'available') return null;
        if (activity.target.type === 'subject' && !post.subjectIds.includes(activity.target.id)) return null;
        postAt = post.createdAt;
        entry = post;
      }
      const excerpt = feedExcerpt(entry);
      authors.set(activity.id, entry.authorId);
      const summary = {
        ...(excerpt === undefined ? {} : { excerpt }),
        id: thread.id,
        kind: thread.kind,
        title: thread.title,
        createdAt: thread.createdAt,
      };
      item =
        object.kind === 'thread'
          ? {
              id: activity.id,
              source: 'following',
              key: { owner: 'content', kind: 'thread', route: object.route, id: object.id },
              occurredAt: activity.occurredAt,
              summary,
              destination: { kind: 'thread', id: object.id, title: thread.title },
            }
          : {
              id: activity.id,
              source: 'following',
              key: { owner: 'content', kind: 'post', route: object.route, id: object.id },
              occurredAt: activity.occurredAt,
              summary: {
                ...(excerpt === undefined ? {} : { excerpt }),
                id: object.id,
                threadId: thread.id,
                title: thread.title,
                createdAt: postAt,
              },
              destination: { kind: 'post', id: object.id, threadId: thread.id, postId: object.id, title: thread.title },
            };
      contextSources.set(activity.id, {
        thread,
        ...(object.kind === 'post' ? { post: entry } : {}),
      });
    } else if (object.owner === 'semantic') {
      if (followingSpace && object.realmId !== followingSpace.realmId) return null;
      const publication = await producers.readPublication(object.realmId, object.id, actor, deadline);
      if (!publication || publication.publicationId !== object.publicationId) return null;
      const summary = summaries.get(object.id);
      if (!summary) return null;
      item = {
        id: activity.id,
        source: 'following',
        key: { owner: 'semantic', kind: summary.type, route: feedRoute(summary.id), id: summary.id },
        occurredAt: activity.occurredAt,
        summary,
        destination: { kind: 'subject', id: summary.id, title: summary.label?.value ?? null },
      };
    } else {
      if (followingSpace) return null;
      const collection = await producers.readCollection(actor, object.id, deadline);
      if (collection.visibility !== 'public') return null;
      item = {
        id: activity.id,
        source: 'following',
        key: { owner: 'library', kind: 'collection', route: object.route, id: object.id },
        occurredAt: activity.occurredAt,
        summary: { id: collection.id, title: collection.title, description: collection.description },
        destination: { kind: 'collection', id: collection.id, title: collection.title },
      };
    }
    if (item) activitySources.set(item.id, activity);
    return item;
  }

  const continuation: FeedContinuationPort = {
    page(actor, query, deadline, languages) {
      return producers.continuation.list(asPlatformActor(actor, liveActor()), query, deadline, languages);
    },
  };
  const publicSummary: FeedPublicSummaryPort = {
    read(actor, ids, languages, deadline) {
      return producers.publicSummary.read(asPlatformActor(actor, liveActor()), { ids, languages, deadline });
    },
  };
  const presentation: FeedPresentationPort = { present: producers.present };

  const discovery: FeedDiscoveryPort | undefined = deps.discovery
    ? {
        async page(input) {
          const actor = asPlatformActor(input.actor, liveActor());
          const page = await deps.discovery!(
            actor.kind === 'account' ? `account:${actor.accountId}` : 'anonymous',
            {
              representation: 'discovery-v1',
              limit: input.limit,
              languages: [...input.languages],
              ...(input.kind === undefined ? {} : { filter: { kind: { in: [input.kind] } } }),
              ...(input.spaceId === undefined ? {} : { spaceId: input.spaceId }),
              ...(input.cursor ? { cursor: input.cursor } : {}),
            },
            {
              access: deps.access,
              actor,
              deadline: input.deadline,
              ...(spacePopulation ? { spacePopulation } : {}),
            },
          );
          return {
            candidates: page.hits.map((hit) => ({ item: feedDiscoveryItem(hit) as FeedItem })),
            next: page.next ?? false,
            asOf: page.as_of,
          };
        },
      }
    : undefined;

  return {
    continuation,
    publicSummary,
    presentation,
    ...(discovery === undefined ? {} : { discovery }),
    following: {
      async page(input) {
        const actor = asPlatformActor(input.actor, liveActor());
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const page = await activities.pageFollowingActivity(
          actor.accountId,
          {
            limit: input.limit,
            boundary: input.boundary,
            ...(input.cursor ? { cursor: input.cursor } : {}),
          },
          input.deadline,
        );
        const ids = [
          ...new Set(
            page.activities.flatMap((activity) => [
              ...(activity.object.owner === 'semantic' ? [activity.object.id] : []),
              ...(activity.target.type === 'subject' ? [activity.target.id] : []),
            ]),
          ),
        ];
        const summaries = await publicSummary.read(input.actor, ids, input.languages, input.deadline);
        const threadIds = [
          ...new Set(
            page.activities.flatMap((activity) =>
              activity.object.owner === 'content' ? [activity.object.threadId] : [],
            ),
          ),
        ];
        const disclosed = await discloseThreads(content, threadIds, { actor, deadline: input.deadline });
        const threads = new Map(threadIds.map((id, index) => [id, disclosed[index]!.value]));
        const authorIds = new Map<string, string>();
        let candidates = await Promise.all(
          page.activities.map(async (activity) => {
            try {
              return {
                item: await hydrate(activity, actor, input.deadline, summaries, threads, authorIds, space),
              };
            } catch (error) {
              if (
                error instanceof ContentNotFoundError ||
                (error instanceof ProblemError && error.code === 'not_found')
              )
                return { item: null };
              throw error;
            }
          }),
        );
        const accounts = await producers.readAccounts(
          actor,
          [...new Set(authorIds.values())],
          input.languages,
          input.deadline,
        );
        candidates = await Promise.all(
          candidates.map(async (candidate, index) => {
            const item = candidate.item;
            if (!item) return candidate;
            if (!(await supported(page.activities[index]!, actor, input.deadline))) return { item: null };
            if (item.key.owner === 'content' && 'createdAt' in item.summary) {
              const authorId = authorIds.get(item.id);
              const author = authorId ? feedAuthor(accounts.get(authorId)) : undefined;
              if (author) item.summary = { ...item.summary, author };
            }
            return candidate;
          }),
        );
        return { candidates, next: page.next ?? false };
      },
    },
    admission: {
      async following(actor, deadline) {
        const live = asPlatformActor(actor, liveActor());
        await producers.checkCurrentFollowSupport(live, { targets: [] }, deadline);
        await producers.admit(live, 'personal_library', 'follow:list', deadline);
      },
      async personalLibrary(actor, deadline) {
        const live = asPlatformActor(actor, liveActor());
        await producers.admit(live, 'personal_library', 'library_entry:list', deadline);
      },
      async readingProgress(actor, deadline) {
        const live = asPlatformActor(actor, liveActor());
        await producers.admit(live, 'reading_progress', 'progress_session:list', deadline);
      },
      async discovery(actor, deadline) {
        const live = asPlatformActor(actor, liveActor());
        await producers.admit(live, 'search', 'subject:search', deadline);
      },
    },
    cursor: {
      fingerprint,
      encode(actor, query, languages, position, now) {
        const live = asPlatformActor(actor, liveActor());
        return encodeFeedCursor(
          deps.tokens,
          feedBinding(live, query.stream ?? 'home', query.limit ?? 20, languages, query.kind, {
            ...(query.spaceId === undefined ? {} : { spaceId: query.spaceId }),
            ...(query.ratingQuestionId === undefined ? {} : { ratingQuestionId: query.ratingQuestionId }),
          }),
          position,
          now,
        );
      },
      decode(actor, query, languages, cursor, now) {
        const live = asPlatformActor(actor, liveActor());
        return decodeFeedCursor(
          deps.tokens,
          feedBinding(live, query.stream ?? 'home', query.limit ?? 20, languages, query.kind, {
            ...(query.spaceId === undefined ? {} : { spaceId: query.spaceId }),
            ...(query.ratingQuestionId === undefined ? {} : { ratingQuestionId: query.ratingQuestionId }),
          }),
          cursor,
          now,
        );
      },
    },
    space: {
      async open(actor, spaceId, deadline, asOf) {
        space = await openFollowingSpace(deps, asPlatformActor(actor, liveActor()), spaceId, deadline, asOf);
        return space;
      },
      async openPopulation(actor, selected, deadline, asOf) {
        if (selected.spaceId === undefined) return undefined;
        spacePopulation = await openSpaceSubjectPopulation(
          deps,
          asPlatformActor(actor, liveActor()),
          selected.spaceId,
          deadline,
          asOf,
        );
        return { spaceId: selected.spaceId, finish: () => spacePopulation!.finish() };
      },
    },
    finish: {
      async beginConversation(items, deadline) {
        const activityReferences = feedActivityReferences(items as Parameters<typeof feedActivityReferences>[0]);
        conversation = createConversationActivityBatch(deps.pool);
        initialActivity = [];
        if (!activityReferences.threadIds.length) return {};
        try {
          initialActivity = await conversation.select(activityReferences.threadIds, deadline);
          return {};
        } catch (error) {
          return {
            rewind: feedActivityLanesForThreads(activityReferences, new Set(activityReferences.threadIds)),
            error,
          };
        }
      },
      async confirmConversation(items, deadline) {
        if (!initialActivity.length) return { items };
        const activityReferences = feedActivityReferences(items as Parameters<typeof feedActivityReferences>[0]);
        try {
          const finalActivity = await conversation.confirm(initialActivity, deadline);
          const staleThreads = staleFeedActivityThreads(finalActivity);
          if (staleThreads.size) {
            return {
              items,
              rewind: feedActivityLanesForThreads(activityReferences, staleThreads),
              error: new ProblemError('dependency_unavailable'),
            };
          }
          projectFeedConversationActivity(
            items as Parameters<typeof projectFeedConversationActivity>[0],
            finalActivity,
          );
          return { items };
        } catch (error) {
          return {
            items,
            rewind: feedActivityLanesForThreads(activityReferences, new Set(activityReferences.threadIds)),
            error,
          };
        }
      },
      async contentContext(items, actor, languages, deadline) {
        const live = asPlatformActor(actor, liveActor());
        contextReferences = [];
        contextWitnesses.clear();
        for (const item of items) {
          if (isDiscoveryReview(item)) {
            const source = contextSources.get(item.id);
            contextReferences.push({
              key: item.id,
              source: item.source,
              threadId: item.key.id,
              ...(source ? { initialThread: source.thread } : {}),
            });
          } else if (isFollowingThread(item)) {
            const source = contextSources.get(item.id);
            contextReferences.push({
              key: item.id,
              source: item.source,
              threadId: item.key.id,
              ...(source ? { initialThread: source.thread } : {}),
            });
          } else if (isFollowingPost(item)) {
            const source = contextSources.get(item.id);
            contextReferences.push({
              key: item.id,
              source: item.source,
              threadId: item.summary.threadId,
              postId: item.key.id,
              ...(source ? { initialThread: source.thread, ...(source.post ? { initialPost: source.post } : {}) } : {}),
            });
          }
        }
        if (!contextReferences.length) return { items };
        try {
          const composition = await prepareFeedContentContext(
            content,
            contextReferences,
            { actor: live, deadline },
            languages,
          );
          const composed = await composition.finish();
          const concealed = new Set<string>();
          for (const reference of contextReferences) {
            const item = items.find((candidate) => candidate.id === reference.key);
            const context = composed.contexts.get(reference.key);
            if (context)
              contextWitnesses.set(reference.key, JSON.stringify({ thread: context.thread, post: context.post }));
            const thread = context?.thread;
            if (
              !item ||
              !thread ||
              thread.availability !== 'available' ||
              thread.firstPost.availability !== 'available'
            ) {
              concealed.add(reference.key);
              continue;
            }
            const excerpt = feedExcerpt(thread.firstPost);
            const reviewContext = context.reviewContext;
            if (isDiscoveryReview(item)) {
              const summary = { ...item.summary };
              summary.title = thread.title;
              if (excerpt) summary.excerpt = excerpt;
              else delete summary.excerpt;
              if (context.threadAuthor)
                summary.author = {
                  displayName: context.threadAuthor.displayName,
                  handle: context.threadAuthor.handle,
                };
              else delete summary.author;
              if (reviewContext?.target.state === 'available')
                summary.subject = {
                  id: reviewContext.target.subject.id,
                  title: reviewContext.target.subject.label?.value ?? null,
                };
              else summary.subject = null;
              if (reviewContext) summary.reviewContext = reviewContext;
              else delete summary.reviewContext;
              item.summary = summary;
              item.destination = { ...item.destination, title: thread.title };
            } else if (isFollowingThread(item)) {
              const summary = { ...item.summary };
              summary.id = thread.id;
              summary.kind = thread.kind;
              summary.title = thread.title;
              summary.createdAt = thread.createdAt;
              if (excerpt) summary.excerpt = excerpt;
              else delete summary.excerpt;
              if (context.threadAuthor) summary.author = context.threadAuthor;
              else delete summary.author;
              if (reviewContext) summary.reviewContext = reviewContext;
              else delete summary.reviewContext;
              item.summary = summary;
              item.destination = { ...item.destination, title: thread.title };
            } else if (isFollowingPost(item)) {
              const post = context.post;
              if (!post || post.availability !== 'available') {
                concealed.add(reference.key);
                continue;
              }
              const postExcerpt = feedExcerpt(post);
              const summary = { ...item.summary };
              summary.threadId = thread.id;
              summary.title = thread.title;
              summary.createdAt = post.createdAt;
              if (postExcerpt) summary.excerpt = postExcerpt;
              else delete summary.excerpt;
              if (context.postAuthor) summary.author = context.postAuthor;
              else delete summary.author;
              if (reviewContext) summary.reviewContext = reviewContext;
              else delete summary.reviewContext;
              if (context.parentContext) summary.parentContext = context.parentContext;
              else delete summary.parentContext;
              item.summary = summary;
              item.destination = { ...item.destination, title: thread.title };
            }
          }
          return {
            items: concealed.size ? items.filter((item) => !concealed.has(item.id)) : items,
          };
        } catch (error) {
          return {
            items,
            rewind: new Set(contextReferences.map(({ source }) => source)),
            error,
          };
        }
      },
      async reactions(items, actor, deadline) {
        const live = asPlatformActor(actor, liveActor());
        try {
          const projected = await projectFeedReactions(
            content,
            live,
            items as Parameters<typeof projectFeedReactions>[2],
            deadline,
          );
          const hasFollowingTargets = items.some((item) => item.source === 'following' && item.key.owner === 'content');
          const hasDiscoveryReviews = items.some(
            (item) => item.source === 'discovery' && item.key.owner === 'content' && item.key.kind === 'review',
          );
          return {
            items: projected.items as FeedItem[],
            ...(projected.reactionsAsOf === undefined ? {} : { reactionsAsOf: projected.reactionsAsOf }),
            ...(hasFollowingTargets || hasDiscoveryReviews ? {} : {}),
          };
        } catch (error) {
          const rewind = new Set<FeedLane>();
          if (items.some((item) => item.source === 'following' && item.key.owner === 'content'))
            rewind.add('following');
          if (
            items.some(
              (item) => item.source === 'discovery' && item.key.owner === 'content' && item.key.kind === 'review',
            )
          )
            rewind.add('discovery');
          return { items, rewind, error };
        }
      },
      async reactionAdvice(items, actor, deadline, stream) {
        if (stream !== 'home') return { items };
        const live = asPlatformActor(actor, liveActor());
        const advice = prepareFeedReactionAdvice(
          items as Parameters<typeof prepareFeedReactionAdvice>[0],
          contextWitnesses,
          {
            pool: deps.pool,
            ...(deps.viewerActionRuntime === undefined ? {} : { viewerActionRuntime: deps.viewerActionRuntime }),
          },
          live,
          deadline,
        );
        reactionAdvice = advice;
        return {
          items: advice.items as FeedItem[],
          hasTargets: advice.hasTargets,
          finish: async (current) =>
            (await advice.finish(current as Parameters<typeof advice.finish>[0])) as FeedItem[],
        };
      },
      async subjectReactions(items, actor, deadline) {
        const subjectLanes = new Set(
          items.filter((item) => item.destination.kind === 'subject').map((item) => item.source as FeedLane),
        );
        if (!subjectLanes.size) return { items };
        try {
          const live = asPlatformActor(actor, liveActor());
          const composition = await prepareFeedSubjectReactions(
            content,
            live,
            items as Parameters<typeof prepareFeedSubjectReactions>[2],
            deadline,
          );
          return { items: (await composition.finish()) as FeedItem[] };
        } catch (error) {
          return { items, rewind: subjectLanes, error };
        }
      },
      async followSupport(items, actor, deadline) {
        const live = asPlatformActor(actor, liveActor());
        try {
          const selectedFollowing = items.filter((item) => item.source === 'following');
          const currentFollowing = await Promise.all(
            selectedFollowing.map(async (item) => ({
              id: item.id,
              current: await supported(activitySources.get(item.id)!, live, deadline),
            })),
          );
          const withdrawn = new Set(currentFollowing.filter(({ current }) => !current).map(({ id }) => id));
          return { items: items.filter((item) => !withdrawn.has(item.id)) };
        } catch (error) {
          return { items, rewind: new Set<FeedLane>(['following']), error };
        }
      },
      async personalActions(items, actor, languages, deadline, reopen) {
        const live = asPlatformActor(actor, liveActor());
        if (live.kind !== 'account') return { items };
        const viewerPersonalActions = await composeFeedViewerPersonalActions(
          deps,
          live,
          items as Parameters<typeof composeFeedViewerPersonalActions>[2],
          deadline,
          languages,
          reopen as never,
        );
        return { items, viewerPersonalActions };
      },
      async reopenSelected(items, actor, _query, languages, deadline) {
        if (!contextReferences.length) return items;
        const live = asPlatformActor(actor, liveActor());
        const finalContexts = await (
          await prepareFeedContentContext(
            content,
            contextReferences.map(({ key, threadId, postId }) => ({
              key,
              threadId,
              ...(postId === undefined ? {} : { postId }),
            })),
            { actor: live, deadline },
            languages,
          )
        ).finish();
        return items.filter((item) => {
          if (!contextWitnesses.has(item.id)) return true;
          const context = finalContexts.contexts.get(item.id);
          return (
            !!context &&
            JSON.stringify({ thread: context.thread, post: context.post }) === contextWitnesses.get(item.id)
          );
        });
      },
    },
    classifyFailure: (error) => sourceState(error, capabilities),
    refuse,
    now: () => deps.clock(),
  };
}
