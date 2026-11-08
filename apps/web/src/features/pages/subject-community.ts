import { planReads, platformRegistry, type CompositionDocument, type PageRead } from '@rezics/composition';
import type { KernelClient } from '@rezics/client';
import { checkDocument, documentText, type DocumentNode } from '@rezics/document';
import { readPageAuthors, type PageAuthors } from '../../identity/read';
import { isPlatformClosedError, isPlatformClosedProblem } from '../../kernel/platform-closed';
import type { ReactionKind } from '../../threads/reaction-request';
import { GLOBAL } from './subject-ratings';
import { pageContext, type SubjectPageData, type SubjectPageLoad } from './subject';
import { assertSubjectPageReadActive, type SubjectPageReadLifetime } from './subject-page-read-lifetime';
import { isRecord } from './shared';
import {
  COMMUNITY_POSITION_LIMIT,
  COMMUNITY_PROJECTED_BYTES,
  COMMUNITY_ROW_BYTES,
  COMMUNITY_TEXT_LIMIT,
  projectCommunityCard,
  projectNativeCommunityCard,
  projectCommunityReviewTarget,
  projectCommunityParentContext,
  withinCommunityBytes,
  type CommunityCard,
  type CommunityNativeCard,
} from './subject-community-card';
import { projectCommunityActionAdvice, type CommunityActionAdvice } from './subject-community-actions';

export type CommunityKind = 'review' | 'discussion';
export type NativeCommunityPage = NonNullable<
  Awaited<ReturnType<ReturnType<KernelClient['subjects']>['threads']['get']>>['data']
>;
export type NativeCommunityThread = NativeCommunityPage['threads'][number];
export type CommunityVoteCitation = { questionId: string; units: number; revision: number };
export type CommunityReactionCounts = Partial<Record<ReactionKind, number>>;
export type CommunityDisplayContext = {
  subjectId: string;
  subjectLabel: string | null;
  source?: NativeCommunityPage['context']['subject']['source'];
  place:
    | { kind: 'global'; id: string }
    | { kind: 'realm'; id: string; title: string; spaceId?: string; headRevisionId?: string };
};
export type CommunityReactionFreshness = { epoch: number; position: string } | null;
export type CommunityThread = Pick<NativeCommunityThread, 'id' | 'title' | 'authorId' | 'boardId' | 'createdAt'> & {
  /** Local occurrence identity preserves repeated native rows; it grants no authority. */
  rowKey?: string;
  position?: number;
  reviewTarget?: NonNullable<NativeCommunityThread['reviewContext']>['target'];
  parentContext?: NativeCommunityThread['card']['parentContext'];
  summary: string;
  licence: string;
  postRevisionId?: string;
  voteCitation?: CommunityVoteCitation | null;
  reactions?: CommunityReactionCounts;
  viewerReaction?: ReactionKind | null;
  card?: CommunityCard;
  nativeCard?: CommunityNativeCard;
  actions?: CommunityActionAdvice;
};
export type CommunityEntryAction = 'allowed' | 'denied' | 'sign-in' | 'unavailable';
/**
 * The native creation entry for the supplied Board, decoded from the installed `entry`.
 * Advice only presents the composer link; the composer and thread command stay authoritative.
 */
export type CommunityEntry =
  | { state: 'not_selected' }
  | { state: 'concealed' }
  | { state: 'unavailable' }
  | { state: 'current'; board: { id: string; title: string | null }; action: CommunityEntryAction };
export type CommunityRegion = (
  | { state: 'loading' | 'unavailable' | 'closed' | 'expired' }
  | {
      state: 'ready';
      threads: CommunityThread[];
      next: string | null;
      context: CommunityDisplayContext;
      reactionsAsOf: CommunityReactionFreshness;
      entry?: CommunityEntry;
    }
) & { request?: CommunityRequest };
export type SubjectCommunity = {
  regions: Partial<Record<CommunityKind, CommunityRegion>>;
  nodes?: Record<string, CommunityRegion>;
  authors: PageAuthors;
  now: string;
  reader?: string | null;
  contextId?: string | null;
  sourceKey?: string;
  /** The mounted composition query; omitted by standalone lists and recorded presentation. */
  queryKey?: readonly unknown[] | undefined;
};

export const COMMUNITY_PREVIEW_LIMIT = 5;
export const COMMUNITY_PAGE_LIMIT = 20;
export const COMMUNITY_CURSOR_LIMIT = 4096;
const validCursor = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= COMMUNITY_CURSOR_LIMIT;

/** Template placement opens a region; no Semantic Context or publication pointer selects a Content place. */
export function communityKinds(nodes: readonly unknown[]): CommunityKind[] {
  const kinds = new Set<CommunityKind>();
  function walk(content: readonly unknown[]) {
    for (const node of content) {
      if (!isRecord(node)) continue;
      if (node.type === 'ReviewList') kinds.add('review');
      if (node.type === 'ThreadList') kinds.add('discussion');
      if (isRecord(node.props)) for (const value of Object.values(node.props)) if (Array.isArray(value)) walk(value);
    }
  }
  walk(nodes);
  return [...kinds];
}

export type CommunityRequest = Extract<PageRead, { kind: 'subjectThreads' }>;
const nativeId = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const reactionKinds = new Set<ReactionKind>(['upvote', 'downvote', 'like', 'love', 'laugh', 'insightful', 'sad']);

function communityCitation(value: unknown): value is CommunityVoteCitation {
  return (
    isRecord(value) &&
    nativeId(value.questionId) &&
    Number.isSafeInteger(value.units) &&
    (value.units as number) >= 0 &&
    (value.units as number) <= 4096 &&
    Number.isSafeInteger(value.revision) &&
    (value.revision as number) >= 1 &&
    (value.revision as number) <= 2_147_483_647 &&
    Object.keys(value).every((key) => key === 'questionId' || key === 'units' || key === 'revision')
  );
}

function historicalCardInput(thread: unknown): unknown {
  if (!isRecord(thread)) return undefined;
  if (!isRecord(thread.card) || thread.card.version !== 1) return thread.card;
  // Keep the versioned historical seam strict while reading Content's adjacent native action advice.
  const historical = Object.fromEntries(
    Object.entries(thread.card).filter(([key]) =>
      ['version', 'threadId', 'postRevisionId', 'citation', 'activity', 'media'].includes(key),
    ),
  );
  return historical;
}

function communityContext(value: unknown, expected: CommunityRequest): CommunityDisplayContext | null {
  if (!isRecord(value) || value.kind !== expected.threadKind || !isRecord(value.subject) || !isRecord(value.place))
    return null;
  const subject = value.subject;
  const source = subject.source;
  const label = subject.label;
  if (
    subject.id !== expected.id ||
    !isRecord(source) ||
    !Number.isInteger(source.partition) ||
    (source.partition as number) < 0 ||
    (source.partition as number) > 4095 ||
    !Number.isInteger(source.epoch) ||
    (source.epoch as number) < 1 ||
    typeof source.position !== 'string' ||
    source.position.length > COMMUNITY_POSITION_LIMIT ||
    !/^[0-9]+$/.test(source.position) ||
    (label !== null &&
      (!isRecord(label) ||
        typeof label.value !== 'string' ||
        label.value.length > COMMUNITY_TEXT_LIMIT ||
        typeof label.language !== 'string' ||
        label.language.length > 64))
  )
    return null;
  const subjectLabel = label === null ? null : (label as { value: string }).value;
  const observation = {
    partition: source.partition as number,
    epoch: source.epoch as number,
    position: source.position,
  };

  if (expected.place === GLOBAL) {
    return value.place.kind === 'global' && value.place.id === GLOBAL
      ? { subjectId: expected.id, subjectLabel, source: observation, place: { kind: 'global', id: GLOBAL } }
      : null;
  }
  if (
    value.place.kind !== 'realm' ||
    value.place.id !== expected.place ||
    typeof value.place.title !== 'string' ||
    value.place.title.length > 2048 ||
    new TextEncoder().encode(value.place.title).length > 4096 ||
    !nativeId(value.place.spaceId) ||
    !nativeId(value.place.headRevisionId)
  )
    return null;
  return {
    subjectId: expected.id,
    subjectLabel,
    source: observation,
    place: {
      kind: 'realm',
      id: expected.place,
      title: value.place.title,
      spaceId: value.place.spaceId,
      headRevisionId: value.place.headRevisionId,
    },
  };
}

function communityReactionFreshness(value: unknown): CommunityReactionFreshness | undefined {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !Number.isInteger(value.epoch) ||
    (value.epoch as number) < 1 ||
    typeof value.position !== 'string' ||
    value.position.length > COMMUNITY_POSITION_LIMIT ||
    !/^[1-9][0-9]*$/.test(value.position)
  )
    return undefined;
  return { epoch: value.epoch as number, position: value.position };
}

const entryActions = new Set<string>(['allowed', 'denied', 'sign-in', 'unavailable']);

/**
 * Decode the closed entry against the exact request it answers. A response without `entry` is the
 * no-Board answer, which is `not_selected`; a supplied Board must receive an explicit entry.
 */
function communityEntry(value: unknown, expected: CommunityRequest): CommunityEntry | undefined {
  if (value === undefined) return expected.board === undefined ? { state: 'not_selected' } : undefined;
  if (!isRecord(value) || !isRecord(value.request)) return undefined;
  const request = value.request;
  if (
    request.subjectId !== expected.id ||
    request.placeId !== expected.place ||
    request.kind !== expected.threadKind ||
    request.selectedBoardId !== expected.board
  )
    return undefined;
  if (value.state === 'not_selected') return expected.board === undefined ? { state: 'not_selected' } : undefined;
  if (expected.board === undefined) return undefined;
  if (value.state === 'concealed') return { state: 'concealed' };
  if (value.state === 'unavailable') return { state: 'unavailable' };
  if (value.state !== 'current') return undefined;
  const board = value.board;
  const actions = value.actions;
  if (!isRecord(board) || board.id !== expected.board || !isRecord(actions)) return undefined;
  const action = actions.createThread;
  const title = board.title;
  if (typeof action !== 'string' || !entryActions.has(action)) return undefined;
  if (title !== null && (typeof title !== 'string' || title.length > COMMUNITY_TEXT_LIMIT)) return undefined;
  return { state: 'current', board: { id: expected.board, title }, action: action as CommunityEntryAction };
}

function communityReactionCounts(value: unknown): CommunityReactionCounts | null {
  if (!isRecord(value)) return null;
  const counts: CommunityReactionCounts = {};
  for (const [kind, count] of Object.entries(value)) {
    if (!reactionKinds.has(kind as ReactionKind) || !Number.isSafeInteger(count) || (count as number) < 1) return null;
    counts[kind as ReactionKind] = count as number;
  }
  return counts;
}

/** Validate only native identity, disclosure and projected fields; never hydrate a missing row. */
function project(thread: unknown, expected: CommunityRequest, admitViewer: boolean): CommunityThread | null {
  if (
    !isRecord(thread) ||
    !withinCommunityBytes(thread, COMMUNITY_ROW_BYTES) ||
    !nativeId(thread.id) ||
    !nativeId(thread.authorId) ||
    !nativeId(thread.boardId) ||
    (thread.title !== null && (typeof thread.title !== 'string' || thread.title.length > COMMUNITY_TEXT_LIMIT)) ||
    typeof thread.createdAt !== 'string' ||
    thread.createdAt.length > 40 ||
    !Number.isFinite(Date.parse(thread.createdAt)) ||
    thread.kind !== expected.threadKind ||
    !Array.isArray(thread.subjectIds) ||
    !thread.subjectIds.includes(expected.id) ||
    thread.visibility !== 'published' ||
    thread.availability !== 'available'
  )
    return null;
  const post = thread.firstPost;
  if (
    !isRecord(post) ||
    !nativeId(post.id) ||
    post.id === thread.id ||
    post.threadId !== thread.id ||
    post.boardId !== thread.boardId ||
    post.availability !== 'available' ||
    post.visibility !== 'published' ||
    !checkDocument(post.body)
  )
    return null;
  if (typeof post.licence !== 'string' || post.licence.length < 1 || post.licence.length > 128) return null;
  const citationPresent = Object.hasOwn(post, 'voteCitation');
  if (citationPresent && post.voteCitation !== null && !communityCitation(post.voteCitation)) return null;
  const referencedMedia = new Map<string, string>();
  function collectImages(node: DocumentNode) {
    if (node.type === 'image' && typeof node.attrs?.src === 'string')
      referencedMedia.set(
        node.attrs.src,
        typeof node.attrs.alt === 'string' ? node.attrs.alt.slice(0, COMMUNITY_TEXT_LIMIT) : '',
      );
    for (const child of node.content ?? []) collectImages(child);
  }
  // Only a supplied extension needs media inspection; ordinary ThreadView stays text-only.
  if (thread.card !== undefined) collectImages(post.body.doc);
  const card = projectCommunityCard(historicalCardInput(thread), {
    id: thread.id,
    postRevisionId: post.revisionId,
    mediaIds: Array.isArray(post.mediaIds) ? post.mediaIds.filter((id) => referencedMedia.has(id)) : [],
    citation: citationPresent ? (post.voteCitation as CommunityVoteCitation | null) : undefined,
  });
  const nativeCard = projectNativeCommunityCard(thread.card, {
    postId: post.id,
    mediaIds: Array.isArray(post.mediaIds) ? post.mediaIds : [],
    images: referencedMedia,
  });
  if (isRecord(thread.card) && 'state' in thread.card && !nativeCard) return null;
  const actions = nativeId(post.revisionId)
    ? projectCommunityActionAdvice(thread, { threadId: thread.id, postRevisionId: post.revisionId })
    : undefined;
  const reactionsPresent = Object.hasOwn(thread, 'reactions');
  const reactions = reactionsPresent ? communityReactionCounts(thread.reactions) : undefined;
  if (reactionsPresent && reactions === null) return null;
  const viewerPresent = Object.hasOwn(thread, 'viewerReaction');
  if (
    admitViewer &&
    viewerPresent &&
    thread.viewerReaction !== null &&
    !reactionKinds.has(thread.viewerReaction as ReactionKind)
  )
    return null;
  // The native DTO has no place field. Board-to-place authority stays with the supplied native read.
  const reviewTarget = projectCommunityReviewTarget(thread.reviewContext);
  const parentContext = nativeCard ? projectCommunityParentContext(thread.card) : undefined;
  const projected: CommunityThread = {
    ...(reviewTarget ? { reviewTarget } : {}),
    ...(parentContext ? { parentContext } : {}),
    id: thread.id,
    title: thread.title,
    authorId: thread.authorId,
    boardId: thread.boardId,
    createdAt: thread.createdAt,
    summary: documentText(post.body).replace(/\s+/g, ' ').trim().slice(0, 280),
    licence: post.licence,
    ...(nativeId(post.revisionId) ? { postRevisionId: post.revisionId } : {}),
    ...(citationPresent ? { voteCitation: post.voteCitation as CommunityVoteCitation | null } : {}),
    ...(reactionsPresent ? { reactions: reactions! } : {}),
    ...(admitViewer && viewerPresent ? { viewerReaction: thread.viewerReaction as ReactionKind | null } : {}),
    ...(card ? { card } : {}),
    ...(nativeCard ? { nativeCard } : {}),
    ...(actions ? { actions } : {}),
  };
  return withinCommunityBytes(projected, COMMUNITY_PROJECTED_BYTES) ? projected : null;
}

function regionAuthorIds(region: CommunityRegion): string[] {
  return region.state === 'ready' ? region.threads.map((thread) => thread.authorId) : [];
}

/** One native page per placed region and one shared public identity batch; continuations are never drained. */
export async function readSubjectCommunity(
  client: KernelClient,
  subjectId: string,
  kinds: readonly CommunityKind[],
  paged = false,
  cursor?: string,
  requestedReader?: string | null,
  requestedPlace = GLOBAL,
  board?: string,
): Promise<SubjectCommunity> {
  const limit = paged ? COMMUNITY_PAGE_LIMIT : COMMUNITY_PREVIEW_LIMIT;
  const entries = await Promise.all(
    [...new Set(kinds)].map(async (kind): Promise<[CommunityKind, CommunityRegion]> => {
      const request: CommunityRequest = {
        kind: 'subjectThreads',
        id: subjectId,
        place: requestedPlace,
        threadKind: kind,
        limit,
        ...(board === undefined ? {} : { board }),
        ...(cursor !== undefined ? { cursor } : {}),
      };
      if (cursor !== undefined && (!paged || !validCursor(cursor))) return [kind, { state: 'unavailable', request }];
      try {
        const result = await client.subjects({ id: subjectId }).threads.get({
          query: {
            place: requestedPlace,
            kind,
            limit: String(limit),
            ...(board === undefined ? {} : { board }),
            ...(cursor !== undefined ? { cursor } : {}),
          },
        });
        if (isPlatformClosedProblem(result.status, result.error?.value)) return [kind, { state: 'closed', request }];
        const region = composedCommunityRegion(
          { status: result.status, body: result.error ? result.error.value : result.data },
          request,
          typeof requestedReader === 'string',
        );
        return [kind, region];
      } catch (error) {
        return [kind, { state: isPlatformClosedError(error) ? 'closed' : 'unavailable', request }];
      }
    }),
  );
  const authorIds = entries.flatMap(([, region]) => regionAuthorIds(region));
  return {
    regions: Object.fromEntries(entries),
    authors: await readPageAuthors(client, authorIds),
    now: new Date().toISOString(),
    reader: requestedReader ?? null,
    sourceKey: crypto.randomUUID(),
  };
}

function stripViewerReaction(row: unknown): unknown {
  if (!isRecord(row)) return row;
  const { viewerReaction: _viewerReaction, ...thread } = row;
  if (!isRecord(thread.firstPost)) return thread;
  const { viewerReaction: _firstPostViewerReaction, ...firstPost } = thread.firstPost;
  return { ...thread, firstPost };
}

function stripSubjectThreadViewerSlots(
  reads: SubjectPageData['reads'],
  plan: ReturnType<typeof planReads>,
): SubjectPageData['reads'] {
  const next = { ...reads };
  for (const [key, descriptor] of Object.entries(plan.reads)) {
    if (descriptor.kind !== 'subjectThreads') continue;
    const read = next[key];
    if (!read || !isRecord(read.body) || !Array.isArray(read.body.threads)) continue;
    next[key] = { ...read, body: { ...read.body, threads: read.body.threads.map(stripViewerReaction) } };
  }
  return next;
}

/** Decode only the existing native DTO. A failed/unrequested read cannot become an empty invitation. */
function decodeCommunityRegion(
  read: { status: number; body: unknown } | undefined,
  expected?: CommunityRequest,
  admitViewer = false,
): CommunityRegion {
  if (!read) return { state: 'unavailable' };
  if (isPlatformClosedProblem(read.status, read.body)) return { state: 'closed' };
  if (
    expected?.cursor &&
    isRecord(read.body) &&
    ((read.status === 400 && read.body.code === 'invalid_cursor') ||
      (read.status === 409 && read.body.code === 'stale_cursor'))
  )
    return { state: 'expired' };
  if (
    read.status !== 200 ||
    !expected ||
    !Number.isInteger(expected.limit) ||
    expected.limit < 1 ||
    expected.limit > COMMUNITY_PAGE_LIMIT ||
    !isRecord(read.body) ||
    !withinCommunityBytes(read.body, expected.limit * COMMUNITY_ROW_BYTES + 64 * 1024) ||
    !Array.isArray(read.body.threads) ||
    read.body.threads.length > expected.limit ||
    (read.body.next !== null && !validCursor(read.body.next))
  )
    return { state: 'unavailable' };
  const context = communityContext(read.body.context, expected);
  const reactionsAsOf = Object.hasOwn(read.body, 'reactionsAsOf')
    ? communityReactionFreshness(read.body.reactionsAsOf)
    : undefined;
  const entry = communityEntry(read.body.entry, expected);
  if (!context || reactionsAsOf === undefined || entry === undefined) return { state: 'unavailable' };
  try {
    const threads: CommunityThread[] = [];
    const occurrences = new Map<string, number>();
    for (const row of read.body.threads) {
      const thread = project(row, expected, admitViewer);
      if (!thread) return { state: 'unavailable' };
      const occurrence = occurrences.get(thread.id) ?? 0;
      occurrences.set(thread.id, occurrence + 1);
      threads.push({ ...thread, rowKey: `${thread.id}:${occurrence}`, position: threads.length });
    }
    return { state: 'ready', threads, next: read.body.next, context, reactionsAsOf, entry };
  } catch {
    return { state: 'unavailable' };
  }
}

// Preserve the original request even on failure; recovery never silently starts a different window.
export function composedCommunityRegion(
  read: { status: number; body: unknown } | undefined,
  expected?: CommunityRequest,
  admitViewer = false,
): CommunityRegion {
  const region = decodeCommunityRegion(read, expected, admitViewer);
  return expected ? { ...region, request: { ...expected } } : region;
}

/** Use the guarded composition leaves and their exact cursor, with one shared public identity batch. */
export async function withComposedCommunity(
  client: KernelClient,
  loaded: SubjectPageLoad,
  signal?: SubjectPageReadLifetime,
): Promise<SubjectPageLoad> {
  assertSubjectPageReadActive(signal);
  if (loaded.kind !== 'page' || !loaded.page.subject || loaded.page.account) return loaded;
  const plan = planReads(platformRegistry, loaded.page.document as CompositionDocument, pageContext(loaded.page));
  const reader = loaded.page.requestedReader ?? null;
  const reads = reader === null ? stripSubjectThreadViewerSlots(loaded.page.reads, plan) : loaded.page.reads;
  const nodes: Record<string, CommunityRegion> = {};
  const regions: SubjectCommunity['regions'] = {};
  for (const [node, key] of Object.entries(plan.nodes)) {
    const descriptor = plan.reads[key];
    if (descriptor?.kind !== 'subjectThreads') continue;
    const region = composedCommunityRegion(reads[key], descriptor, reader !== null);
    nodes[node] = region;
    regions[descriptor.threadKind] ??= region;
  }
  const authorIds = Object.values(nodes).flatMap(regionAuthorIds);
  assertSubjectPageReadActive(signal);
  const authors = await readPageAuthors(client, authorIds, signal);
  assertSubjectPageReadActive(signal);
  return {
    ...loaded,
    page: {
      ...loaded.page,
      reads,
      community: {
        nodes,
        regions,
        authors,
        now: new Date().toISOString(),
        reader,
        contextId: loaded.page.context?.id ?? null,
        // An observation replacement retires its visit even at an identical URL.
        sourceKey: crypto.randomUUID(),
      },
    },
  };
}

/** Tab availability comes exclusively from the native composition status. */
export function communityOverview(overview: SubjectPageData): SubjectPageData {
  return overview;
}

/** Standalone compatibility loader. The actual page query consumes composition leaves through withComposedCommunity. */
export async function withSubjectCommunity(
  client: KernelClient,
  loaded: SubjectPageLoad,
  view?: string,
  cursor?: string,
): Promise<SubjectPageLoad> {
  if (loaded.kind !== 'page' || !loaded.page.subject || loaded.page.account) return loaded;
  if (loaded.page.requestedRealm || (loaded.page.context && loaded.page.context.population.kind !== 'global'))
    return loaded;
  const kinds = communityKinds(loaded.page.document.content);
  if (!kinds.length) return loaded;
  const community = await readSubjectCommunity(
    client,
    loaded.page.subject,
    kinds,
    view !== undefined,
    cursor,
    loaded.page.requestedReader ?? null,
    GLOBAL,
    loaded.page.board,
  );
  community.contextId = loaded.page.context?.id ?? null;
  return { ...loaded, page: { ...loaded.page, community } };
}
