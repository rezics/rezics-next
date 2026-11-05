import type { Pool } from 'pg';
import type { Access, Actor } from '../request/access.ts';
import type { KernelClock } from '../clock.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { WorkClient } from '../work/client.ts';
import type { DiscoverySearch } from '../search/index.ts';
import type { SearchService } from '../search/service-scope.ts';
import { admitGroup, PlatformClosedError } from '../access/gates/admission.ts';
import { AuthenticationError } from '../request/access.ts';
import { ProblemError } from '../http/problem.ts';
import { classifyUnavailability } from '../access/unavailable.ts';
import { createContinueReads } from '../library/continue-reads.ts';
import { createFollowActivitySource } from '../library/follow-activity.ts';
import { createCollectionReads } from '../library/collection-reads.ts';
import type { ViewerPersonalActionsReader } from '../library/viewer-personal-actions.ts';
import { composeFeedViewerPersonalActions } from './feed-viewer.ts';
import { readAccountDiscoverySummaries } from '../access/account-discovery-source.ts';
import { feedExcerpt, feedAuthor } from './feed-summary.ts';
import { prepareFeedContentContext, type FeedContentContextReference } from './feed-context.ts';
import { projectFeedReactions } from './feed-reactions.ts';
import { prepareFeedReactionAdvice, type FeedReactionAdviceComposition } from './feed-reaction-advice.ts';
import { prepareFeedSubjectReactions } from './feed-subject-reactions.ts';
import { feedDiscoveryItem } from './feed-discovery.ts';
import { openFollowingSpace, type FollowingSpace } from './feed-space.ts';
import { openSpaceSubjectPopulation } from './feed-subject-scope.ts';
import { readSubjectSummaries } from '../semantic/summaries.ts';
import { readPublication } from '../community/publication.ts';
import {
  ContentNotFoundError,
  discloseThreads,
  readBoard,
  readPost,
  type PostEntry,
  type ThreadView,
} from './reads.ts';
import { createFeedActivityStore, feedRoute, type ActivityRef } from './feed-activity.ts';
import { createConversationActivityBatch } from './conversation-activity.ts';
import {
  feedActivityLanesForThreads,
  feedActivityReferences,
  projectFeedConversationActivity,
  staleFeedActivityThreads,
} from './feed-conversation-activity.ts';
import { decodeFeedCursor, encodeFeedCursor, feedBinding, fingerprint, type FeedPosition } from './feed-cursor.ts';
import {
  readFeedKind,
  type FeedItem,
  type FeedPage,
  type FeedSourceState,
  type FeedSelection,
} from './feed-contract.ts';
import type { ReadingPageViewerActionRuntime } from './reading-page.ts';

export type FeedDependencies = {
  pool: Pool;
  routeKey: Uint8Array;
  tokens: KeyRing;
  clock: KernelClock;
  access: Access;
  contentAccess: Access;
  workClient: () => Promise<WorkClient>;
  discovery?: DiscoverySearch;
  search?: SearchService;
  /** Home calls this bounded seam only after its feed candidates are admitted and disclosed. */
  viewerPersonalActions: ViewerPersonalActionsReader;
  /** Reuse the mounted Content reading-page action catalogue for selected Home targets. */
  viewerActionRuntime?: () => ReadingPageViewerActionRuntime;
};

/** The native factory and mounted route share this query and response contract. */
export type FeedReadQuery = {
  stream?: 'home' | 'following';
  limit?: number;
  cursor?: string;
  kind?: string;
} & FeedSelection;
export type FeedReads = {
  list(actor: Actor, query: FeedReadQuery, deadline: number, languages: readonly string[]): Promise<FeedPage>;
};
// Native producer bounds from docs/feeds.md; one round, without refill.
export const FEED_PAGE_LIMIT = 20;
export const FEED_CANDIDATE_LIMIT = 160;
export const FEED_CONTINUE_WIDTH = 6;
export const FEED_CONTINUE_CANDIDATES = 39;
export const FEED_DISCOVERY_CANDIDATES_PER_RESULT = 6;
export const FEED_DISCOVERY_FIXED_CANDIDATES = 3;
// Accounts accepts 100 keys; each can expand to one avatar and one verified-agent Subject.
export const FEED_ACCOUNT_BATCH_LIMIT = 100;
export const FEED_AUTHOR_KEYS_PER_CANDIDATE = 3;
// Initial/final selected Space and Realm; at most one distinct board per inbox candidate.
export const FEED_SPACE_FIXED_KEYS = 4;
export const FEED_SPACE_BOARD_KEYS_PER_CANDIDATE = 1;
export const feedCandidateBound = (discovery: number, following: number, continued: boolean) =>
  (discovery ? FEED_DISCOVERY_CANDIDATES_PER_RESULT * discovery + FEED_DISCOVERY_FIXED_CANDIDATES : 0) +
  following +
  (continued ? FEED_CONTINUE_CANDIDATES : 0);

const canonical = (item: FeedItem) =>
  `${item.key.owner === 'library' && item.key.kind === 'collection' ? 'commerce' : item.key.owner}:${item.key.id}`;
const isDiscoveryReview = (
  item: FeedItem,
): item is Extract<FeedItem, { source: 'discovery'; key: { owner: 'content'; kind: 'review' } }> =>
  item.source === 'discovery' && item.key.owner === 'content' && item.key.kind === 'review';
const isFollowingThread = (
  item: FeedItem,
): item is Extract<FeedItem, { source: 'following'; key: { owner: 'content'; kind: 'thread' } }> =>
  item.source === 'following' && item.key.owner === 'content' && item.key.kind === 'thread';
const isFollowingPost = (
  item: FeedItem,
): item is Extract<FeedItem, { source: 'following'; key: { owner: 'content'; kind: 'post' } }> =>
  item.source === 'following' && item.key.owner === 'content' && item.key.kind === 'post';
const sourceState = (error: unknown): FeedSourceState => {
  if (classifyUnavailability(error) === 'deadline') throw new ProblemError('deadline_exceeded');
  if (error instanceof AuthenticationError || error instanceof PlatformClosedError) throw error;
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
};

export function createFeedReads(deps: FeedDependencies): FeedReads {
  const activities = createFeedActivityStore(deps);
  let follows: ReturnType<typeof createFollowActivitySource> | undefined;
  const followSource = async () =>
    (follows ??= createFollowActivitySource({
      ...deps,
      workClient: await deps.workClient(),
      activityStore: activities,
    }));
  const continued = createContinueReads(deps);
  const collections = createCollectionReads(deps);
  const content = { ...deps, access: deps.contentAccess };

  async function supported(activity: ActivityRef, actor: Actor, deadline: number): Promise<boolean> {
    const status = (
      await (await followSource()).checkCurrentFollowSupport(actor, { targets: [activity.target] }, deadline)
    )[0]?.status;
    if (status === 'unavailable') throw new ProblemError('dependency_unavailable');
    return status === 'following';
  }

  async function hydrate(
    activity: ActivityRef,
    actor: Actor,
    deadline: number,
    summaries: Awaited<ReturnType<typeof readSubjectSummaries>>,
    threads: ReadonlyMap<string, ThreadView | null>,
    authors: Map<string, string>,
    contextSources: Map<string, Readonly<{ thread: ThreadView; post?: PostEntry }>>,
    activitySources: Map<string, ActivityRef>,
    space?: FollowingSpace,
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
        if (space && activity.target.id !== space.spaceId) return null;
        // Reuse the selected Space's bounded current board read when present.
        if (space) {
          if (!(await space.containsBoard(thread.boardId))) return null;
        } else {
          const board = (await readBoard(content, thread.boardId, { actor, deadline })).value;
          if (!board || board.community?.spaceId !== activity.target.id) return null;
        }
      }
      if (space && activity.target.type !== 'space' && !(await space.containsBoard(thread.boardId))) return null;
      let entry = thread.firstPost;
      let postAt = thread.createdAt;
      if (object.kind === 'post') {
        const post = (await readPost(content, object.threadId, object.id, { actor, deadline })).value;
        if (!post || post.availability !== 'available') return null;
        if (activity.target.type === 'subject' && !post.subjectIds.includes(activity.target.id)) return null;
        postAt = post.createdAt;
        entry = post;
      }
      // Both entries have passed native current body disclosure; never use inventory author IDs.
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
      if (space && object.realmId !== space.realmId) return null;
      const publication = await readPublication(deps, object.realmId, object.id, { actor, deadline });
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
      // Collections have no native Space membership. Contained Subjects are not
      // the primary candidate and cannot supply it on the Collection's behalf.
      if (space) return null;
      const collection = await collections.readCollection(actor, object.id, deadline);
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

  return {
    async list(actor: Actor, query: FeedReadQuery, deadline: number, languages: readonly string[]): Promise<FeedPage> {
      const stream = query.stream ?? 'home';
      const limit = query.limit ?? FEED_PAGE_LIMIT;
      const kind = readFeedKind(query.kind);
      if (!Number.isInteger(limit) || limit < 1 || limit > FEED_PAGE_LIMIT) throw new ProblemError('invalid_request');
      const personal = actor.kind === 'account';
      if (stream === 'following' && !personal) throw new AuthenticationError(401, 'Bearer');
      // Admission is outside lane-local recovery, including the current account lifecycle read.
      if (personal) {
        if (
          !actor.scopes.includes('follow:list') ||
          (stream === 'home' &&
            (!actor.scopes.includes('library_entry:list') || !actor.scopes.includes('progress_session:list')))
        )
          throw new ProblemError('forbidden');
        await (await followSource()).checkCurrentFollowSupport(actor, { targets: [] }, deadline);
        await admitGroup({
          ...deps,
          access: () => deps.access,
          actor,
          group: 'personal_library',
          clientAction: 'follow:list',
          deadline,
        });
        if (stream === 'home') {
          await admitGroup({
            ...deps,
            access: () => deps.access,
            actor,
            group: 'personal_library',
            clientAction: 'library_entry:list',
            deadline,
          });
          await admitGroup({
            ...deps,
            access: () => deps.access,
            actor,
            group: 'reading_progress',
            clientAction: 'progress_session:list',
            deadline,
          });
        }
      }
      if (stream === 'home')
        await admitGroup({
          ...deps,
          access: () => deps.access,
          actor,
          group: 'search',
          clientAction: 'subject:search',
          deadline,
        });
      const now = deps.clock();
      const selection: FeedSelection = {
        ...(query.spaceId === undefined ? {} : { spaceId: query.spaceId }),
        ...(query.ratingQuestionId === undefined ? {} : { ratingQuestionId: query.ratingQuestionId }),
      };
      const binding = feedBinding(actor, stream, limit, languages, kind, selection);
      const position: FeedPosition = query.cursor
        ? await decodeFeedCursor(deps.tokens, binding, query.cursor, now)
        : {
            boundary: now.toISOString(),
            turn: 0,
            discovery: stream === 'home' ? null : false,
            following: personal ? null : false,
            continue: personal && stream === 'home' ? null : false,
            resume: null,
          };
      // Point question witnesses do not establish population coverage. Keep the
      // independent Context producer closed before enumerating any source.
      if (query.ratingQuestionId !== undefined) throw new ProblemError('dependency_unavailable');
      let space =
        query.spaceId === undefined
          ? undefined
          : await openFollowingSpace(deps, actor, query.spaceId, deadline, now.toISOString());
      const spacePopulation =
        space && stream === 'home'
          ? await openSpaceSubjectPopulation(deps, actor, space.spaceId, deadline, now.toISOString())
          : undefined;
      const sources: FeedPage['sources'] = {
        discovery: stream === 'home' ? 'ready' : 'not_requested',
        following: personal ? 'ready' : 'not_requested',
        continue: personal && stream === 'home' ? 'ready' : 'not_requested',
      };
      type Lane = 'continue' | 'following' | 'discovery';
      const names: Lane[] = ['continue', 'following', 'discovery'];
      type Candidate = { item: FeedItem | null; after?: string };
      const lanes: Record<Lane, Candidate[]> = { continue: [], following: [], discovery: [] };
      const contextSources = new Map<string, Readonly<{ thread: ThreadView; post?: PostEntry }>>();
      const activitySources = new Map<string, ActivityRef>();
      const next = { ...position };
      let continueFingerprint = '';
      let discoveryAsOf: string | undefined;
      const discoveryLimit = !personal ? limit : Math.max(1, Math.floor((limit - FEED_CONTINUE_WIDTH) / 2));
      const followingLimit = stream === 'following' ? limit : Math.max(1, limit - FEED_CONTINUE_WIDTH - discoveryLimit);
      const candidateBound = feedCandidateBound(
        stream === 'home' ? discoveryLimit : 0,
        personal ? followingLimit : 0,
        personal && stream === 'home',
      );
      const authorKeys = personal ? followingLimit * FEED_AUTHOR_KEYS_PER_CANDIDATE : 0;
      const spaceKeys = space ? FEED_SPACE_FIXED_KEYS + followingLimit * FEED_SPACE_BOARD_KEYS_PER_CANDIDATE : 0;
      if (followingLimit > FEED_ACCOUNT_BATCH_LIMIT || candidateBound + authorKeys + spaceKeys > FEED_CANDIDATE_LIMIT)
        throw new RangeError('Feed native candidate bound exceeded');
      // One bounded mixed round. Reserve native raw costs, including rejected keys inside owners:
      // discovery <=6D+3, Continue <=39, inbox <=F. Mixed max91; anonymous max123.
      const loadLane = async (lane: Lane) => {
        if (position[lane] === false) return;
        try {
          if (lane === 'discovery') {
            if (!deps.discovery) throw new ProblemError('dependency_unavailable');
            const discoveryContext = {
              access: deps.access,
              actor,
              deadline,
              ...(spacePopulation ? { spacePopulation } : {}),
            };
            const page = await deps.discovery(
              personal ? `account:${actor.accountId}` : 'anonymous',
              {
                representation: 'discovery-v1',
                limit: discoveryLimit,
                languages: [...languages],
                ...(kind === undefined ? {} : { filter: { kind: { in: [kind] } } }),
                ...(space ? { spaceId: space.spaceId } : {}),
                ...(position.discovery ? { cursor: position.discovery } : {}),
              },
              discoveryContext,
            );
            discoveryAsOf = page.as_of;
            lanes.discovery = page.hits.map((hit) => ({ item: feedDiscoveryItem(hit) }));
            next.discovery = page.next ?? false;
          } else if (lane === 'continue') {
            const page = await continued.list(
              actor,
              {
                limit: FEED_CONTINUE_WIDTH,
                view: 'FULL',
                ...(space ? { spaceId: space.spaceId } : {}),
                ...(space && kind !== undefined ? { kind } : {}),
                ...(position.continue ? { cursor: position.continue } : {}),
              },
              deadline,
              languages,
            );
            continueFingerprint = fingerprint(page.subjects.map((row) => [row.subjectId, row.lastActivityAt]));
            if (position.resume && position.resume.fingerprint !== continueFingerprint)
              throw new ProblemError('stale_cursor');
            const offset = position.resume
              ? page.subjects.findIndex(
                  (row) => fingerprint([row.subjectId, row.lastActivityAt]) === position.resume!.after,
                ) + 1
              : 0;
            if (position.resume && !offset) throw new ProblemError('stale_cursor');
            lanes.continue = page.subjects.slice(offset).map((row) => ({
              after: fingerprint([row.subjectId, row.lastActivityAt]),
              item: row.subject
                ? {
                    id: `continue:${row.subject.id}`,
                    source: 'continue',
                    key: {
                      owner: 'semantic',
                      kind: row.subject.type,
                      route: feedRoute(row.subject.id),
                      id: row.subject.id,
                    },
                    occurredAt: row.lastActivityAt,
                    summary: row.subject,
                    continue: row,
                    destination: { kind: 'subject', id: row.subject.id, title: row.subject.label?.value ?? null },
                  }
                : null,
            }));
            next.continue = page.next ?? false;
            next.resume = null;
          } else if (actor.kind === 'account') {
            const page = await activities.pageFollowingActivity(
              actor.accountId,
              {
                limit: followingLimit,
                boundary: position.boundary,
                ...(position.following ? { cursor: position.following } : {}),
              },
              deadline,
            );
            const ids = [
              ...new Set(
                page.activities.flatMap((activity) => [
                  ...(activity.object.owner === 'semantic' ? [activity.object.id] : []),
                  ...(activity.target.type === 'subject' ? [activity.target.id] : []),
                ]),
              ),
            ];
            const summaries = await readSubjectSummaries({ ...deps, actor, deadline }, ids, { languages });
            const threadIds = [
              ...new Set(
                page.activities.flatMap((activity) =>
                  activity.object.owner === 'content' ? [activity.object.threadId] : [],
                ),
              ),
            ];
            // The native executor groups complete anchored keys per backend/container and applies
            // its original opening-post, parent-chain and body/reference final disclosure checks.
            const disclosed = await discloseThreads(content, threadIds, { actor, deadline });
            const threads = new Map(threadIds.map((id, index) => [id, disclosed[index]!.value]));
            const authorIds = new Map<string, string>();
            lanes.following = await Promise.all(
              page.activities.map(async (activity) => {
                try {
                  return {
                    item: await hydrate(
                      activity,
                      actor,
                      deadline,
                      summaries,
                      threads,
                      authorIds,
                      contextSources,
                      activitySources,
                      space,
                    ),
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
            // One page batch (at most F distinct identities), with Accounts' own final disclosure.
            const accounts = await readAccountDiscoverySummaries(
              { ...deps, actor, deadline },
              [...new Set(authorIds.values())],
              { languages },
            );
            // Keep the existing final follow disclosure after all owner hydration, including identities.
            lanes.following = await Promise.all(
              lanes.following.map(async (candidate, index) => {
                const item = candidate.item;
                if (!item) return candidate;
                if (!(await supported(page.activities[index]!, actor, deadline))) return { item: null };
                if (item.key.owner === 'content' && 'createdAt' in item.summary) {
                  const authorId = authorIds.get(item.id);
                  const author = authorId ? feedAuthor(accounts.get(authorId)) : undefined;
                  if (author) item.summary = { ...item.summary, author };
                }
                return candidate;
              }),
            );
            next.following = page.next ?? false;
          }
        } catch (error) {
          lanes[lane] = [];
          sources[lane] = sourceState(error);
          next[lane] = position[lane];
        }
      };
      await Promise.all(names.map(loadLane));
      const sourceWitnesses = new Map(
        names.flatMap((lane) =>
          lanes[lane].flatMap(({ item }) => (item ? [[item.id, JSON.stringify(item)] as const] : [])),
        ),
      );
      // Keep rejected candidates in their original slots: they still consume the native
      // raw budget and examined frontier, including Continue's fingerprint/resume keys.
      if (kind !== undefined)
        for (const lane of names)
          for (const candidate of lanes[lane])
            if (candidate.item && candidate.item.key.kind !== kind) candidate.item = null;
      const preferred = new Map<string, Lane>();
      for (const lane of names)
        for (const candidate of lanes[lane])
          if (candidate.item && !preferred.has(canonical(candidate.item)))
            preferred.set(canonical(candidate.item), lane);
      const offsets = { continue: 0, following: 0, discovery: 0 };
      const seen = new Set<string>();
      const feedItems: FeedItem[] = [];
      let turn = position.turn;
      let remaining = names.reduce((sum, lane) => sum + lanes[lane].length, 0);
      while (remaining && feedItems.length < limit) {
        const lane = names[turn]!;
        turn = (turn + 1) % 3;
        const candidate = lanes[lane][offsets[lane]];
        if (!candidate) continue;
        offsets[lane]++;
        remaining--;
        const item = candidate.item;
        if (item && preferred.get(canonical(item)) === lane && !seen.has(canonical(item))) {
          seen.add(canonical(item));
          feedItems.push(item);
        }
      }
      for (const lane of names) {
        if (offsets[lane] === lanes[lane].length) continue;
        // Discovery/inbox widths exceed one only when all admitted candidates fit P.
        // Continue always reads its native six; resume by actual source key, never visible count.
        next[lane] = position[lane];
        if (lane === 'continue') next.resume = position.resume;
        if (lane === 'continue' && offsets.continue > 0)
          next.resume = {
            fingerprint: continueFingerprint,
            after: lanes.continue[offsets.continue - 1]!.after!,
          };
      }
      next.turn = turn;
      const activityReferences = feedActivityReferences(feedItems);
      const conversationActivity = createConversationActivityBatch(deps.pool);
      let initialActivity: Awaited<ReturnType<typeof conversationActivity.select>> = [];
      const rewindActivityLanes = (affected: ReadonlySet<'discovery' | 'following'>, error: unknown) => {
        for (const lane of affected) {
          sources[lane] = sourceState(error);
          lanes[lane] = [];
          next[lane] = position[lane];
        }
        for (let index = feedItems.length - 1; index >= 0; index--)
          if (affected.has(feedItems[index]!.source as 'discovery' | 'following')) feedItems.splice(index, 1);
      };
      if (activityReferences.threadIds.length) {
        try {
          initialActivity = await conversationActivity.select(activityReferences.threadIds, deadline);
        } catch (error) {
          rewindActivityLanes(
            feedActivityLanesForThreads(activityReferences, new Set(activityReferences.threadIds)),
            error,
          );
        }
      }
      const contextReferences: Array<FeedContentContextReference & { source: 'discovery' | 'following' }> = [];
      for (const item of feedItems) {
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
      const contextWitnesses = new Map<string, string>();
      if (contextReferences.length) {
        try {
          const composition = await prepareFeedContentContext(
            content,
            contextReferences,
            { actor, deadline },
            languages,
          );
          const composed = await composition.finish();
          const concealed = new Set<string>();
          for (const reference of contextReferences) {
            const item = feedItems.find((candidate) => candidate.id === reference.key);
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
          if (concealed.size)
            for (let index = feedItems.length - 1; index >= 0; index--)
              if (concealed.has(feedItems[index]!.id)) feedItems.splice(index, 1);
        } catch (error) {
          const affected = new Set(contextReferences.map(({ source }) => source));
          for (const source of affected) {
            sources[source] = sourceState(error);
            lanes[source] = [];
            next[source] = position[source];
          }
          for (let index = feedItems.length - 1; index >= 0; index--)
            if (affected.has(feedItems[index]!.source as 'discovery' | 'following')) feedItems.splice(index, 1);
        }
      }
      let reactionsAsOf: FeedPage['reactionsAsOf'];
      try {
        const projected = await projectFeedReactions(content, actor, feedItems, deadline);
        feedItems.splice(0, feedItems.length, ...projected.items);
        reactionsAsOf = projected.reactionsAsOf;
      } catch (error) {
        // Rows with reaction targets must not escape with a guessed viewer slot. Rewind
        // each affected native lane so its action cards can be retried with their source.
        const hasFollowingTargets = feedItems.some(
          (item) => item.source === 'following' && item.key.owner === 'content',
        );
        const hasDiscoveryReviews = feedItems.some(
          (item) => item.source === 'discovery' && item.key.owner === 'content' && item.key.kind === 'review',
        );
        if (hasFollowingTargets) {
          sources.following = sourceState(error);
          lanes.following = [];
          next.following = position.following;
        }
        if (hasDiscoveryReviews) {
          sources.discovery = sourceState(error);
          lanes.discovery = [];
          next.discovery = position.discovery;
        }
        for (let index = feedItems.length - 1; index >= 0; index--)
          if (
            (hasFollowingTargets && feedItems[index]!.source === 'following') ||
            (hasDiscoveryReviews && feedItems[index]!.source === 'discovery')
          )
            feedItems.splice(index, 1);
        reactionsAsOf = undefined;
      }
      let reactionAdvice: FeedReactionAdviceComposition | undefined;
      if (stream === 'home') {
        reactionAdvice = prepareFeedReactionAdvice(
          feedItems,
          contextWitnesses,
          {
            pool: deps.pool,
            ...(deps.viewerActionRuntime === undefined ? {} : { viewerActionRuntime: deps.viewerActionRuntime }),
          },
          actor,
          deadline,
        );
        feedItems.splice(0, feedItems.length, ...reactionAdvice.items);
      }
      const subjectLanes = new Set(
        feedItems.filter((item) => item.destination.kind === 'subject').map((item) => item.source as Lane),
      );
      if (subjectLanes.size) {
        try {
          const composition = await prepareFeedSubjectReactions(content, actor, feedItems, deadline);
          feedItems.splice(0, feedItems.length, ...(await composition.finish()));
        } catch (error) {
          // A missing Subject component invalidates its whole lane. Preserve its exact
          // input frontier; Continue also keeps its original fingerprint/resume key.
          for (const lane of subjectLanes) {
            sources[lane] = sourceState(error);
            lanes[lane] = [];
            next[lane] = position[lane];
            if (lane === 'continue') next.resume = position.resume;
          }
          for (let index = feedItems.length - 1; index >= 0; index--)
            if (subjectLanes.has(feedItems[index]!.source as Lane)) feedItems.splice(index, 1);
        }
      }
      // Repeat the original selected Space authority after all native hydration,
      // reaction projection and final follow checks, including sparse examined pages.
      await space?.finish();
      await spacePopulation?.finish();
      try {
        const selectedFollowing = feedItems.filter((item) => item.source === 'following');
        const currentFollowing = await Promise.all(
          selectedFollowing.map(async (item) => ({
            id: item.id,
            current: await supported(activitySources.get(item.id)!, actor, deadline),
          })),
        );
        const withdrawn = new Set(currentFollowing.filter(({ current }) => !current).map(({ id }) => id));
        for (let index = feedItems.length - 1; index >= 0; index--)
          if (withdrawn.has(feedItems[index]!.id)) feedItems.splice(index, 1);
      } catch (error) {
        rewindActivityLanes(new Set(['following']), error);
      }
      if (initialActivity.length) {
        try {
          const finalActivity = await conversationActivity.confirm(initialActivity, deadline);
          const staleThreads = staleFeedActivityThreads(finalActivity);
          if (staleThreads.size) {
            rewindActivityLanes(
              feedActivityLanesForThreads(activityReferences, staleThreads),
              new ProblemError('dependency_unavailable'),
            );
          } else projectFeedConversationActivity(feedItems, finalActivity);
        } catch (error) {
          rewindActivityLanes(
            feedActivityLanesForThreads(activityReferences, new Set(activityReferences.threadIds)),
            error,
          );
        }
      }
      let viewerPersonalActions: FeedPage['viewerPersonalActions'];
      const finalFeedAdmission = async () => {
        // Reopen the exact independent source queries after all foreign work. Their
        // new cursors are observations only: retries retain the original frontier.
        const retainedNext = { ...next };
        const selectedLanes = [...new Set(feedItems.map((item) => item.source))];
        await space?.finish();
        if (query.spaceId !== undefined)
          space = await openFollowingSpace(deps, actor, query.spaceId, deadline, now.toISOString());
        for (const lane of selectedLanes) await loadLane(lane);
        Object.assign(next, retainedNext);
        const current = new Map(
          selectedLanes.flatMap((lane) =>
            lanes[lane].flatMap(({ item }) => (item ? [[item.id, JSON.stringify(item)] as const] : [])),
          ),
        );
        for (let index = feedItems.length - 1; index >= 0; index--) {
          const item = feedItems[index]!;
          if (current.get(item.id) !== sourceWitnesses.get(item.id)) {
            feedItems.splice(index, 1);
            next[item.source] = position[item.source];
            if (item.source === 'continue') next.resume = position.resume;
          }
        }
        if (contextReferences.length) {
          const finalContexts = await (
            await prepareFeedContentContext(
              content,
              contextReferences.map(({ key, threadId, postId }) => ({
                key,
                threadId,
                ...(postId === undefined ? {} : { postId }),
              })),
              { actor, deadline },
              languages,
            )
          ).finish();
          for (let index = feedItems.length - 1; index >= 0; index--) {
            const item = feedItems[index]!;
            if (!contextWitnesses.has(item.id)) continue;
            const context = finalContexts.contexts.get(item.id);
            if (
              !context ||
              JSON.stringify({ thread: context.thread, post: context.post }) !== contextWitnesses.get(item.id)
            ) {
              feedItems.splice(index, 1);
              next[item.source] = position[item.source];
            }
          }
        }
        await space?.finish();
        await spacePopulation?.finish();
        return feedItems;
      };
      if (personal && stream === 'home')
        viewerPersonalActions = await composeFeedViewerPersonalActions(
          deps,
          actor,
          feedItems,
          deadline,
          languages,
          finalFeedAdmission,
        );
      else if (stream === 'home' && reactionAdvice?.hasTargets) await finalFeedAdmission();
      if (reactionAdvice) feedItems.splice(0, feedItems.length, ...(await reactionAdvice.finish(feedItems)));
      const hasNext = names.some((lane) => next[lane] !== false && sources[lane] === 'ready');
      return {
        feedItems,
        ...(viewerPersonalActions === undefined ? {} : { viewerPersonalActions }),
        sources,
        asOf: personal ? position.boundary : (discoveryAsOf ?? position.boundary),
        ...(reactionsAsOf === undefined ? {} : { reactionsAsOf }),
        next: hasNext ? await encodeFeedCursor(deps.tokens, binding, next, now) : null,
      };
    },
  };
}
