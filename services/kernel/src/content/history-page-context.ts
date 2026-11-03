import { readAccountDiscoverySummaries } from '../access/account-discovery-source.ts';
import { readViewerActions } from '../access/viewer-actions.ts';
import { classifyUnavailability } from '../access/unavailable.ts';
import { ProblemError } from '../http/problem.ts';
import type { Actor } from '../request/access.ts';
import { GLOBAL_CONTEXT } from '../semantic/definitions.ts';
import { readSubjectSummaryObservation, type SubjectSummary } from '../semantic/summaries.ts';
import { readVisibleRatingQuestion, ratingQuestionView } from '../rating/question-directory.ts';
import type { RatingQuestionView } from '../rating/question-directory.ts';
import type { ContentCommandDependencies } from './commands.ts';
import { readDocumentMediaPresentations, type DocumentImagePresentation } from './media-presentation.ts';
import type { Anchored, AnchoredPosition, BoardView, ReadContext, ThreadView } from './model.ts';
import {
  ContentNotFoundError,
  listPostRevisions,
  readBoard,
  readThread,
  type ContentReadDependencies,
  type ItemView,
  type PostEntry,
} from './reads.ts';
import { readingPageOperationState, type ReadingPageViewerActionRuntime } from './reading-page.ts';
import { routeOf } from '../route/route.ts';

const HISTORY_REVISION_LIMIT = 100;
const HISTORY_AUTHOR_LIMIT = HISTORY_REVISION_LIMIT + 2;
const HISTORY_MENTION_LIMIT = 100;
const HISTORY_SUBJECT_LIMIT = 4;
const HISTORY_MEDIA_PER_REVISION = 32;
const HISTORY_QUESTION_LIMIT = HISTORY_REVISION_LIMIT;
const ACCOUNT_SUMMARY_BATCH_LIMIT = 100;
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const MAX_AUTHOR_DISPLAY_BYTES = 32 * 1024;
const MAX_SUBJECT_DISPLAY_BYTES = 128 * 1024;
const MAX_MEDIA_DISPLAY_BYTES = 16 * 1024 * 1024;
const MAX_REVIEW_DISPLAY_BYTES = 8 * 1024;
const MAX_REVISION_METADATA_BYTES = 8 * 1024;
const MAX_HISTORY_ENVELOPE_BYTES = 1024 * 1024;
const MAX_HISTORY_RESPONSE_BYTES =
  HISTORY_REVISION_LIMIT * MAX_DOCUMENT_BYTES * 6 +
  HISTORY_AUTHOR_LIMIT * MAX_AUTHOR_DISPLAY_BYTES +
  MAX_SUBJECT_DISPLAY_BYTES +
  MAX_MEDIA_DISPLAY_BYTES +
  HISTORY_REVISION_LIMIT * MAX_REVIEW_DISPLAY_BYTES +
  HISTORY_REVISION_LIMIT * MAX_REVISION_METADATA_BYTES +
  MAX_HISTORY_ENVELOPE_BYTES;

export type NativeHistoryPageDependencies = ContentReadDependencies &
  Pick<ContentCommandDependencies, 'routeKey' | 'realmParticipation'> &
  Readonly<{ viewerActionRuntime?: () => ReadingPageViewerActionRuntime }>;

type AccountSummaryMap = Awaited<ReturnType<typeof readAccountDiscoverySummaries>>;
type OptionalState = 'current' | 'unavailable';

function responseBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function dependencyUnavailable(error: unknown): boolean {
  return (
    classifyUnavailability(error) !== undefined ||
    (error instanceof ProblemError && error.code === 'dependency_unavailable')
  );
}

function concealed(error: unknown): boolean {
  return error instanceof ProblemError && error.code === 'not_found';
}

function threadWitness(thread: ThreadView): string {
  const opening = thread.firstPost;
  return JSON.stringify({
    id: thread.id,
    route: thread.route,
    authorId: thread.authorId,
    kind: thread.kind,
    title: thread.title,
    licence: thread.licence,
    subjectIds: thread.subjectIds,
    boardId: thread.boardId,
    visibility: thread.visibility,
    securityRevision: thread.securityRevision,
    availability: thread.availability,
    createdAt: thread.createdAt,
    firstPost: {
      id: opening.id,
      revisionId: 'revisionId' in opening ? opening.revisionId : null,
      authorId: 'authorId' in opening ? opening.authorId : null,
      availability: opening.availability,
      sha256: 'sha256' in opening ? opening.sha256 : null,
    },
  });
}

function boardWitness(board: BoardView): string {
  return JSON.stringify(board);
}

function identityIds(posts: readonly ItemView[], currentHead: PostEntry, conversationAuthorId: string): string[] {
  const ids = new Set<string>();
  for (const post of posts) ids.add(post.authorId);
  if ('authorId' in currentHead) ids.add(currentHead.authorId);
  ids.add(conversationAuthorId);
  if (ids.size > HISTORY_AUTHOR_LIMIT) throw new RangeError('History author bound exceeded');
  return [...ids];
}

function documentMentionIds(posts: readonly ItemView[]): string[] {
  const ids = new Set<string>();
  for (const post of posts) {
    const pending: unknown[] = [post.body.doc];
    while (pending.length && ids.size < HISTORY_MENTION_LIMIT) {
      const value = pending.pop();
      if (!value || typeof value !== 'object') continue;
      const node = value as { type?: unknown; attrs?: Record<string, unknown>; content?: unknown };
      if (
        node.type === 'mention' &&
        typeof node.attrs?.accountId === 'string' &&
        routeOf(node.attrs.accountId) !== null
      )
        ids.add(node.attrs.accountId);
      if (Array.isArray(node.content)) {
        for (let index = node.content.length - 1; index >= 0; index--) pending.push(node.content[index]);
      }
    }
    if (ids.size >= HISTORY_MENTION_LIMIT) break;
  }
  return [...ids];
}

function selectedSubjectIds(posts: readonly ItemView[]): string[] {
  const ids = new Set<string>();
  for (const post of posts) {
    for (const id of post.subjectIds) {
      if (routeOf(id) !== null) ids.add(id);
      if (ids.size >= HISTORY_SUBJECT_LIMIT) return [...ids];
    }
  }
  return [...ids];
}

function mediaIds(posts: readonly ItemView[]): string[] {
  const ids = new Set<string>();
  for (const post of posts) {
    if (post.mediaIds.length > HISTORY_MEDIA_PER_REVISION) throw new RangeError('History media bound exceeded');
    for (const id of post.mediaIds) if (routeOf(id) !== null) ids.add(id);
  }
  return [...ids];
}

function uniqueAnchors(anchors: readonly AnchoredPosition[]): AnchoredPosition[] {
  const seen = new Set<string>();
  return anchors.filter((anchor) => {
    const key = `${anchor.partition}/${anchor.epoch}/${anchor.position}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function loadMedia(
  dependencies: NativeHistoryPageDependencies,
  actor: Actor,
  ids: readonly string[],
  deadline: number,
): Promise<readonly DocumentImagePresentation[]> {
  const images: DocumentImagePresentation[] = [];
  for (let offset = 0; offset < ids.length; offset += HISTORY_MEDIA_PER_REVISION) {
    const batch = ids.slice(offset, offset + HISTORY_MEDIA_PER_REVISION);
    images.push(...(await readDocumentMediaPresentations(dependencies, actor, batch, { deadline })).images);
  }
  return images;
}

async function loadIdentitySummaries(
  dependencies: NativeHistoryPageDependencies,
  actor: Actor,
  ids: readonly string[],
  deadline: number,
): Promise<AccountSummaryMap> {
  const summaries: AccountSummaryMap = new Map();
  for (let offset = 0; offset < ids.length; offset += ACCOUNT_SUMMARY_BATCH_LIMIT) {
    const batch = ids.slice(offset, offset + ACCOUNT_SUMMARY_BATCH_LIMIT);
    const current = await readAccountDiscoverySummaries(
      { pool: dependencies.pool, routeKey: dependencies.routeKey, access: dependencies.access, actor, deadline },
      batch,
    );
    for (const [id, summary] of current) summaries.set(id, summary);
  }
  return summaries;
}

function identityViews(ids: readonly string[], summaries: AccountSummaryMap) {
  return ids.map((id) => {
    const summary = summaries.get(id);
    return summary
      ? {
          id,
          state: 'available' as const,
          displayName: summary.displayName,
          handle: summary.handle,
          avatar: summary.avatar,
        }
      : { id, state: 'concealed' as const };
  });
}

function mentionViews(ids: readonly string[], summaries: AccountSummaryMap) {
  return ids.map((id) => {
    const handle = summaries.get(id)?.handle;
    return typeof handle === 'string' && handle.length
      ? { id, state: 'available' as const, handle }
      : { id, state: 'concealed' as const };
  });
}

function subjectViews(ids: readonly string[], summaries: ReadonlyMap<string, SubjectSummary | null>) {
  return ids.map((id) => {
    const summary = summaries.get(id) ?? null;
    return summary ? { id, state: 'available' as const, summary } : { id, state: 'concealed' as const, summary: null };
  });
}

function mediaViews(ids: readonly string[], images: readonly DocumentImagePresentation[]) {
  const byId = new Map(images.map((image) => [image.id, image]));
  return ids.map((id) => {
    const image = byId.get(id);
    return image ? { id, state: 'available' as const, image } : { id, state: 'concealed' as const };
  });
}

type ReviewCitation = NonNullable<ItemView['voteCitation']>;
type HistoryReviewItem =
  | Readonly<{ revisionId: string; state: 'available'; citation: ReviewCitation; question: RatingQuestionView }>
  | Readonly<{ revisionId: string; state: 'unavailable'; citation: null; question: null }>;

function reviewItems(
  posts: readonly ItemView[],
  questions: ReadonlyMap<string, RatingQuestionView | null>,
  readableSubjects: ReadonlySet<string>,
  unavailable = false,
): HistoryReviewItem[] {
  return posts.map((post) => {
    const citation = post.voteCitation;
    const question = citation ? questions.get(citation.questionId) : null;
    const subjectId = post.subjectIds[0];
    return !unavailable && citation && question && subjectId && readableSubjects.has(subjectId)
      ? { revisionId: post.revisionId, state: 'available' as const, citation, question }
      : { revisionId: post.revisionId, state: 'unavailable' as const, citation: null, question: null };
  });
}

async function readReviewQuestions(
  dependencies: NativeHistoryPageDependencies,
  actor: Actor,
  posts: readonly ItemView[],
  deadline: number,
): Promise<ReadonlyMap<string, RatingQuestionView | null>> {
  const ids = [...new Set(posts.flatMap((post) => (post.voteCitation ? [post.voteCitation.questionId] : [])))];
  if (ids.length > HISTORY_QUESTION_LIMIT) throw new RangeError('History question bound exceeded');
  const questions = await Promise.all(
    ids.map(async (id) => {
      try {
        const question = await readVisibleRatingQuestion(dependencies, actor, id, deadline);
        return [id, question ? ratingQuestionView(question) : null] as const;
      } catch (error) {
        if (concealed(error)) return [id, null] as const;
        throw error;
      }
    }),
  );
  return new Map(questions);
}

function actionReferences(
  actor: Actor,
  runtime: ReadingPageViewerActionRuntime,
  refs: readonly Readonly<{ type: 'content.thread' | 'content.post'; id: string; sourceRevisionId?: string }>[],
  results: readonly Readonly<{
    type: string;
    id: string;
    error?: string;
    viewerActions?: readonly { operations: readonly string[] }[];
  }>[],
) {
  const byKey = new Map(results.map((result) => [`${result.type}/${result.id}`, result]));
  const watch = { state: 'unavailable' as const, retryable: true as const };
  return refs.map((reference) => {
    const result = byKey.get(`${reference.type}/${reference.id}`);
    if (!result || result.error === 'not_found') return { ...reference, state: 'withheld' as const, operations: [] };
    const allowed = new Set((result.viewerActions ?? []).flatMap((entry) => entry.operations));
    const operations = (runtime.bindings.get(reference.type) ?? [])
      .filter((binding) => binding.fixedResourceId === undefined || binding.fixedResourceId === reference.id)
      .map((binding) => ({
        action: binding.action,
        operationId: binding.operationId,
        state: readingPageOperationState(actor, binding.operationId, allowed, runtime.guestSecurity, watch),
      }));
    return { ...reference, state: 'current' as const, operations };
  });
}

async function readHistoryActions(
  dependencies: NativeHistoryPageDependencies,
  actor: Actor,
  thread: ThreadView,
  head: PostEntry,
  deadline: number,
) {
  let runtime: ReadingPageViewerActionRuntime | undefined;
  try {
    runtime = dependencies.viewerActionRuntime?.();
  } catch (error) {
    if (!dependencyUnavailable(error)) throw error;
  }
  const refs: Array<Readonly<{ type: 'content.thread' | 'content.post'; id: string; sourceRevisionId?: string }>> = [
    { type: 'content.thread', id: thread.id },
  ];
  if ('revisionId' in head && head.availability === 'available')
    refs.push({ type: 'content.post', id: head.id, sourceRevisionId: head.revisionId });
  if (
    !runtime ||
    refs.some((ref) => !runtime!.resources.has(ref.type)) ||
    (actor.kind === 'anonymous' &&
      refs.some((ref) =>
        (runtime!.bindings.get(ref.type) ?? []).some((binding) => {
          const security = runtime!.guestSecurity.get(binding.operationId);
          return security !== 'anonymous' && security !== 'authenticated';
        }),
      ))
  )
    return { state: 'unavailable' as const, retryable: true, references: [] as const };
  try {
    const result = await readViewerActions(
      { pool: dependencies.pool, ...runtime },
      actor,
      refs.map(({ type, id }) => ({ type, id })),
      deadline,
    );
    return {
      state: 'current' as const,
      retryable: false,
      references: actionReferences(actor, runtime, refs, result.resources),
    };
  } catch (error) {
    if (!dependencyUnavailable(error)) throw error;
    return { state: 'unavailable' as const, retryable: true, references: [] as const };
  }
}

/** Compose the selected native rows with current conversation context and bounded owner reads. */
export async function readContentHistoryPage(
  dependencies: NativeHistoryPageDependencies,
  threadId: string,
  postId: string,
  actor: Actor,
  deadline: number,
  cursor?: string,
  limit = 20,
) {
  const readContext: ReadContext = { actor, deadline };
  const selected = await listPostRevisions(dependencies, threadId, postId, readContext, cursor, limit);
  if (selected.currentHead.availability === 'withheld') throw new ContentNotFoundError();
  const firstThread: Anchored<ThreadView | null> = await readThread(dependencies, threadId, readContext);
  if (!firstThread.value || firstThread.value.firstPost.availability === 'withheld') throw new ContentNotFoundError();
  const firstBoard = await readBoard(dependencies, firstThread.value.boardId, readContext);
  if (!firstBoard.value) throw new ContentNotFoundError();

  const authors = identityIds(selected.posts, selected.currentHead, firstThread.value.authorId);
  const mentions = documentMentionIds(selected.posts);
  const subjects = selectedSubjectIds(selected.posts);
  const media = mediaIds(selected.posts);
  const identityKeys = [...new Set([...authors, ...mentions])];
  if (identityKeys.length > HISTORY_AUTHOR_LIMIT + HISTORY_MENTION_LIMIT)
    throw new RangeError('History identity bound exceeded');

  let identityState: OptionalState = 'current';
  let identitySummaries: AccountSummaryMap = new Map();
  if (identityKeys.length) {
    try {
      identitySummaries = await loadIdentitySummaries(dependencies, actor, identityKeys, deadline);
      if (identityViews(authors, identitySummaries).some((author) => responseBytes(author) > MAX_AUTHOR_DISPLAY_BYTES))
        identityState = 'unavailable';
    } catch (error) {
      if (!dependencyUnavailable(error)) throw error;
      identityState = 'unavailable';
    }
  }

  let subjectState: OptionalState = 'current';
  let subjectObservation: Awaited<ReturnType<typeof readSubjectSummaryObservation>> | undefined;
  if (subjects.length) {
    try {
      subjectObservation = await readSubjectSummaryObservation(
        { pool: dependencies.pool, routeKey: dependencies.routeKey, access: dependencies.access, actor, deadline },
        subjects,
      );
      if (responseBytes(subjectViews(subjects, subjectObservation.summaries)) > MAX_SUBJECT_DISPLAY_BYTES)
        subjectState = 'unavailable';
    } catch (error) {
      if (!dependencyUnavailable(error)) throw error;
      subjectState = 'unavailable';
    }
  }

  let mediaState: OptionalState = 'current';
  let mediaImages: readonly DocumentImagePresentation[] = [];
  if (media.length) {
    try {
      mediaImages = await loadMedia(dependencies, actor, media, deadline);
      if (responseBytes(mediaImages) > MAX_MEDIA_DISPLAY_BYTES) {
        mediaState = 'unavailable';
        mediaImages = [];
      }
    } catch (error) {
      if (!dependencyUnavailable(error)) throw error;
      mediaState = 'unavailable';
    }
  }

  let reviewState: OptionalState = 'current';
  let questions: ReadonlyMap<string, RatingQuestionView | null> = new Map();
  if (firstThread.value.kind === 'review') {
    try {
      questions = await readReviewQuestions(dependencies, actor, selected.posts, deadline);
      if (
        reviewItems(selected.posts, questions, new Set()).some((item) => responseBytes(item) > MAX_REVIEW_DISPLAY_BYTES)
      )
        reviewState = 'unavailable';
    } catch (error) {
      if (!dependencyUnavailable(error)) throw error;
      reviewState = 'unavailable';
    }
  }

  const actions = await readHistoryActions(dependencies, actor, firstThread.value, selected.currentHead, deadline);

  // Recheck every optional owner read before the final native source fence. A changed or failed
  // optional owner is explicitly unavailable; it is never serialized as a confirmed absence.
  if (identityState === 'current' && identityKeys.length) {
    try {
      const current = await loadIdentitySummaries(dependencies, actor, identityKeys, deadline);
      if (
        JSON.stringify(identityViews(identityKeys, identitySummaries)) !==
        JSON.stringify(identityViews(identityKeys, current))
      )
        identityState = 'unavailable';
      else {
        identitySummaries = current;
        if (
          identityViews(authors, identitySummaries).some((author) => responseBytes(author) > MAX_AUTHOR_DISPLAY_BYTES)
        )
          identityState = 'unavailable';
      }
    } catch (error) {
      if (!dependencyUnavailable(error)) throw error;
      identityState = 'unavailable';
    }
  }
  if (subjectState === 'current' && subjectObservation) {
    try {
      if (!(await subjectObservation.current())) subjectState = 'unavailable';
      else if (responseBytes(subjectViews(subjects, subjectObservation.summaries)) > MAX_SUBJECT_DISPLAY_BYTES)
        subjectState = 'unavailable';
    } catch (error) {
      if (!dependencyUnavailable(error)) throw error;
      subjectState = 'unavailable';
    }
  }
  if (mediaState === 'current' && media.length) {
    try {
      const current = await loadMedia(dependencies, actor, media, deadline);
      if (JSON.stringify(mediaImages) !== JSON.stringify(current) || responseBytes(current) > MAX_MEDIA_DISPLAY_BYTES)
        mediaState = 'unavailable';
      else mediaImages = current;
    } catch (error) {
      if (!dependencyUnavailable(error)) throw error;
      mediaState = 'unavailable';
    }
  }
  if (reviewState === 'current' && questions.size) {
    try {
      const current = await readReviewQuestions(dependencies, actor, selected.posts, deadline);
      if (
        JSON.stringify([...questions]) !== JSON.stringify([...current]) ||
        reviewItems(selected.posts, current, new Set()).some((item) => responseBytes(item) > MAX_REVIEW_DISPLAY_BYTES)
      )
        reviewState = 'unavailable';
      else questions = current;
    } catch (error) {
      if (!dependencyUnavailable(error)) throw error;
      reviewState = 'unavailable';
    }
  }
  if (subjectState === 'unavailable' && firstThread.value.kind === 'review') reviewState = 'unavailable';

  const finalThread = await readThread(dependencies, threadId, readContext);
  const finalBoard = finalThread.value ? await readBoard(dependencies, finalThread.value.boardId, readContext) : null;
  if (
    !finalThread.value ||
    finalThread.value.firstPost.availability === 'withheld' ||
    !finalBoard?.value ||
    threadWitness(firstThread.value) !== threadWitness(finalThread.value) ||
    boardWitness(firstBoard.value) !== boardWitness(finalBoard.value) ||
    !(await selected.revalidate())
  )
    throw new ContentNotFoundError();

  const headRevisionId = 'revisionId' in selected.currentHead ? selected.currentHead.revisionId : null;
  const head = {
    postId: selected.currentHead.id,
    revisionId: headRevisionId,
    state: selected.currentHead.availability === 'available' ? ('current' as const) : ('erased' as const),
    authorId: 'authorId' in selected.currentHead ? selected.currentHead.authorId : null,
    createdAt: 'createdAt' in selected.currentHead ? selected.currentHead.createdAt : null,
    revisedAt: 'revisedAt' in selected.currentHead ? selected.currentHead.revisedAt : null,
  };
  const readableSubjects = new Set(
    subjectState === 'current' && subjectObservation
      ? [...subjectObservation.summaries].flatMap(([id, summary]) => (summary ? [id] : []))
      : [],
  );
  let reviewItemsForPage =
    firstThread.value.kind === 'review'
      ? reviewItems(selected.posts, questions, readableSubjects, reviewState === 'unavailable')
      : [];
  if (reviewItemsForPage.some((item) => responseBytes(item) > MAX_REVIEW_DISPLAY_BYTES)) {
    reviewState = 'unavailable';
    reviewItemsForPage = reviewItems(selected.posts, questions, readableSubjects, true);
  }
  const visibleCitationIds = new Set(
    reviewItemsForPage.flatMap((item) => (item.state === 'available' ? [item.revisionId] : [])),
  );
  const outputRevisions = selected.posts.map((post) =>
    firstThread.value!.kind === 'review' && post.voteCitation && !visibleCitationIds.has(post.revisionId)
      ? { ...post, voteCitation: null }
      : post,
  );
  const review =
    firstThread.value.kind === 'review'
      ? {
          state: reviewState,
          retryable: reviewState === 'unavailable',
          items: reviewItemsForPage,
        }
      : { state: 'current' as const, retryable: false, items: [] as HistoryReviewItem[] };
  const authorItems = identityState === 'current' ? identityViews(authors, identitySummaries) : [];
  const mentionItems = identityState === 'current' ? mentionViews(mentions, identitySummaries) : [];
  const subjectItems =
    subjectState === 'current' && subjectObservation ? subjectViews(subjects, subjectObservation.summaries) : [];
  const imageItems = mediaState === 'current' ? mediaViews(media, mediaImages) : [];
  const unavailable =
    identityState === 'unavailable' ||
    subjectState === 'unavailable' ||
    mediaState === 'unavailable' ||
    reviewState === 'unavailable' ||
    actions.state === 'unavailable';
  const page = {
    viewer:
      actor.kind === 'account' ? { kind: 'account' as const, id: actor.accountId } : { kind: 'anonymous' as const },
    conversation: {
      id: firstThread.value.id,
      kind: firstThread.value.kind,
      title: firstThread.value.title,
      authorId: firstThread.value.authorId,
      boardId: firstThread.value.boardId,
      subjectIds: [...firstThread.value.subjectIds],
      createdAt: firstThread.value.createdAt,
    },
    board: finalBoard.value,
    place:
      finalBoard.value.realmId === null
        ? { kind: 'global' as const, id: GLOBAL_CONTEXT.id }
        : { kind: 'realm' as const, id: finalBoard.value.realmId },
    head,
    authors: {
      state: identityState,
      retryable: identityState === 'unavailable',
      items: authorItems,
    },
    mentions: {
      state: identityState,
      retryable: identityState === 'unavailable',
      items: mentionItems,
    },
    subjects: {
      state: subjectState,
      retryable: subjectState === 'unavailable',
      limit: HISTORY_SUBJECT_LIMIT,
      items: subjectItems,
    },
    reviewScores: review,
    media: {
      state: mediaState,
      retryable: mediaState === 'unavailable',
      items: imageItems,
    },
    actions,
    navigation: {
      exact: selected.posts.map((post) => ({ postId: post.id, revisionId: post.revisionId })),
      compareToHead: selected.posts.flatMap((post) =>
        post.availability === 'available' &&
        selected.currentHead.availability === 'available' &&
        headRevisionId !== null &&
        post.revisionId !== headRevisionId
          ? [{ postId: post.id, fromRevisionId: post.revisionId, toRevisionId: headRevisionId }]
          : [],
      ),
    },
    currentness: {
      source: 'current' as const,
      conversation: 'current' as const,
      board: 'current' as const,
      place: 'current' as const,
      head: 'current' as const,
      authors: identityState,
      mentions: identityState,
      subjects: subjectState,
      reviewScores: reviewState,
      media: mediaState,
      actions: actions.state,
    },
    retry: unavailable ? { state: 'same_cursor' as const, cursor: cursor ?? null } : { state: 'none' as const },
  };
  const response = { revisions: outputRevisions, next: selected.nextCursor, page };
  if (responseBytes(response) > MAX_HISTORY_RESPONSE_BYTES) throw new ProblemError('content_too_large');
  return {
    ...response,
    anchors: uniqueAnchors([
      ...selected.anchors,
      firstThread.anchor,
      firstBoard.anchor,
      finalThread.anchor,
      finalBoard.value.anchor,
    ]),
  };
}
