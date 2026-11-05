import type { FeedAuthor } from './feed-contract.ts';
import { feedAuthor, feedExcerpt } from './feed-summary.ts';
import { ContentNotFoundError, discloseThreads, readCitationDisclosure, readPost } from './reads.ts';
import type { ContentReadDependencies, PostEntry, ThreadView } from './reads.ts';
import type { AnchoredPosition, FeedParentAuthor, FeedParentContext, FeedReviewContext, ReadContext } from './model.ts';
import type { AccountDiscoverySummary } from '../search/index.ts';
import { readAccountDiscoverySummaries } from '../access/account-discovery-source.ts';
import { readSubjectSummaries, readSubjectSummaryObservation } from '../semantic/summaries.ts';
import { ProblemError } from '../http/problem.ts';
import { readVisibleRatingQuestion } from '../rating/question-directory.ts';
import { partitionOf, routeOf } from '../route/route.ts';

export const FEED_CONTEXT_MAX_REFERENCES = 20;
export const FEED_CONTEXT_MAX_AUTHORS = FEED_CONTEXT_MAX_REFERENCES * 3;
export const FEED_CONTEXT_MAX_SUBJECTS = FEED_CONTEXT_MAX_REFERENCES;
export const FEED_CONTEXT_MAX_QUESTIONS = FEED_CONTEXT_MAX_REFERENCES;
export const FEED_PARENT_PREVIEW_BYTES = 640;

/** Owner summaries use the service's trusted routing key, never a reader-selected route. */
export type FeedContentContextDependencies = ContentReadDependencies & Readonly<{ routeKey: Uint8Array }>;

export type FeedContentContextReference = Readonly<{
  key: string;
  threadId: string;
  postId?: string;
  initialThread?: ThreadView;
  initialPost?: PostEntry;
}>;

export type FeedContentContextValue = Readonly<{
  thread: ThreadView | null;
  post: PostEntry | null;
  threadAuthor?: FeedAuthor;
  postAuthor?: FeedAuthor;
  reviewContext?: FeedReviewContext;
  parentContext?: FeedParentContext;
}>;

export type FeedThreadObserver = (
  threadIds: readonly string[],
  context: ReadContext,
) => Promise<readonly Readonly<{ value: ThreadView | null; anchor: AnchoredPosition }>[]>;

export type FeedContentContextFinished = Readonly<{
  contexts: ReadonlyMap<string, FeedContentContextValue>;
  anchors: readonly AnchoredPosition[];
}>;

export type FeedContentContextComposition = Readonly<{
  finish(): Promise<FeedContentContextFinished>;
}>;

const postKey = (threadId: string, postId: string) => `${threadId}\u0000${postId}`;
const missing = (error: unknown) =>
  error instanceof ContentNotFoundError || (error instanceof ProblemError && error.code === 'not_found');

type PostObservation = Readonly<{ value: PostEntry | null; anchor?: AnchoredPosition }>;
type ContentObservation = Readonly<{
  threads: ReadonlyMap<string, ThreadView | null>;
  posts: ReadonlyMap<string, PostObservation>;
  parents: ReadonlyMap<string, PostObservation>;
  anchors: readonly AnchoredPosition[];
}>;

function threadMatches(thread: ThreadView, id: string): boolean {
  return thread.id === id && thread.firstPost.threadId === id && thread.route === routeOf(id);
}

function postMatches(post: PostEntry, threadId: string, postId: string): boolean {
  return post.id === postId && post.threadId === threadId && post.route === routeOf(threadId);
}

type DocumentNode = Readonly<{
  attrs?: Readonly<Record<string, unknown>>;
  marks?: readonly Readonly<{ type?: string }>[];
  content?: readonly DocumentNode[];
}>;

function documentPresentation(body: unknown): Readonly<{ language: string | null; spoiler: boolean }> {
  const stack: DocumentNode[] = [body as DocumentNode];
  let language: string | null = null;
  let spoiler = false;
  while (stack.length) {
    const node = stack.pop()!;
    if (!language && typeof node.attrs?.lang === 'string') language = node.attrs.lang;
    if (node.marks?.some((mark) => mark.type === 'spoiler')) spoiler = true;
    for (const child of node.content ?? []) stack.push(child);
  }
  return { language, spoiler };
}

function boundedExcerpt(entry: PostEntry): string | null {
  const source = feedExcerpt(entry);
  if (!source) return null;
  let bytes = 0;
  let excerpt = '';
  const encoder = new TextEncoder();
  for (const character of source) {
    const width = encoder.encode(character).byteLength;
    if (bytes + width > FEED_PARENT_PREVIEW_BYTES) break;
    excerpt += character;
    bytes += width;
  }
  return excerpt || null;
}

async function readPostBatch(
  dependencies: ContentReadDependencies,
  references: readonly Readonly<{ threadId: string; postId: string }>[],
  context: ReadContext,
): Promise<Readonly<{ values: ReadonlyMap<string, PostObservation>; anchors: readonly AnchoredPosition[] }>> {
  const unique = [
    ...new Map(references.map((reference) => [postKey(reference.threadId, reference.postId), reference])).values(),
  ];
  if (unique.length > FEED_CONTEXT_MAX_REFERENCES * 2)
    throw new RangeError('Feed context selected-post and parent bound exceeded');
  const rows = await Promise.all(
    unique.map(async (reference) => {
      const key = postKey(reference.threadId, reference.postId);
      try {
        return { key, reference, result: await readPost(dependencies, reference.threadId, reference.postId, context) };
      } catch (error) {
        if (missing(error)) return { key, reference, result: null };
        throw error;
      }
    }),
  );
  const values = new Map<string, PostObservation>();
  const anchors: AnchoredPosition[] = [];
  for (const row of rows) {
    if (!row.result) {
      values.set(row.key, { value: null });
      continue;
    }
    const { reference } = row;
    if (
      row.result.anchor.partition.partitionNo !== partitionOf(routeOf(reference.threadId)!) ||
      (row.result.value && !postMatches(row.result.value, reference.threadId, reference.postId))
    )
      throw new ProblemError('dependency_unavailable');
    values.set(row.key, { value: row.result.value, anchor: row.result.anchor });
    anchors.push(row.result.anchor);
  }
  return { values, anchors };
}

function initialThreadMap(references: readonly FeedContentContextReference[]) {
  const result = new Map<string, ThreadView>();
  for (const reference of references) {
    const thread = reference.initialThread;
    if (!thread) continue;
    if (!threadMatches(thread, reference.threadId)) throw new TypeError('Feed context thread key mismatch');
    const previous = result.get(thread.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(thread))
      throw new TypeError('Feed context has conflicting thread observations');
    result.set(thread.id, thread);
  }
  return result;
}

function initialPostMap(references: readonly FeedContentContextReference[]) {
  const result = new Map<string, PostObservation>();
  for (const reference of references) {
    if (!reference.postId || !reference.initialPost) continue;
    if (!postMatches(reference.initialPost, reference.threadId, reference.postId))
      throw new TypeError('Feed context post key mismatch');
    const key = postKey(reference.threadId, reference.postId);
    const previous = result.get(key)?.value;
    if (previous && JSON.stringify(previous) !== JSON.stringify(reference.initialPost))
      throw new TypeError('Feed context has conflicting post observations');
    result.set(key, { value: reference.initialPost });
  }
  return result;
}

async function observeThreads(
  dependencies: ContentReadDependencies,
  ids: readonly string[],
  context: ReadContext,
  observer?: FeedThreadObserver,
): Promise<Readonly<{ values: ReadonlyMap<string, ThreadView | null>; anchors: readonly AnchoredPosition[] }>> {
  if (!ids.length) return { values: new Map(), anchors: [] };
  const unique = [...new Set(ids)];
  const rows = observer ? await observer(unique, context) : await discloseThreads(dependencies, unique, context);
  if (rows.length !== unique.length) throw new ProblemError('dependency_unavailable');
  for (const [index, row] of rows.entries()) {
    const id = unique[index]!;
    if (row.anchor.partition.partitionNo !== partitionOf(routeOf(id)!) || (row.value && !threadMatches(row.value, id)))
      throw new ProblemError('dependency_unavailable');
  }
  return {
    values: new Map(unique.map((id, index) => [id, rows[index]!.value])),
    anchors: rows.map((row) => row.anchor),
  };
}

async function loadContent(
  dependencies: ContentReadDependencies,
  references: readonly FeedContentContextReference[],
  context: ReadContext,
  initialThreads: ReadonlyMap<string, ThreadView>,
  initialPosts: ReadonlyMap<string, PostObservation>,
  observer?: FeedThreadObserver,
  useInitial = false,
): Promise<ContentObservation> {
  const threadIds = [...new Set(references.map(({ threadId }) => threadId))];
  let threads: ReadonlyMap<string, ThreadView | null>;
  let threadAnchors: readonly AnchoredPosition[] = [];
  if (useInitial) {
    const missingIds = threadIds.filter((id) => !initialThreads.has(id));
    const selected = await observeThreads(dependencies, missingIds, context);
    threads = new Map([...initialThreads, ...selected.values]);
    threadAnchors = selected.anchors;
  } else {
    const selected = await observeThreads(dependencies, threadIds, context, observer);
    threads = selected.values;
    threadAnchors = selected.anchors;
  }

  const postRefs = references.flatMap(({ threadId, postId }) => (postId ? [{ threadId, postId }] : []));
  const missingPosts = postRefs.filter(
    ({ threadId, postId }) => !useInitial || !initialPosts.has(postKey(threadId, postId)),
  );
  const selectedPosts = missingPosts.length
    ? await readPostBatch(dependencies, missingPosts, context)
    : { values: new Map<string, PostObservation>(), anchors: [] as readonly AnchoredPosition[] };
  const posts = useInitial ? new Map([...initialPosts, ...selectedPosts.values]) : new Map(selectedPosts.values);
  if (!useInitial && postRefs.length === 0) posts.clear();

  const parentRefs = new Map<string, Readonly<{ threadId: string; postId: string }>>();
  for (const reference of references) {
    if (!reference.postId) continue;
    const selected = posts.get(postKey(reference.threadId, reference.postId))?.value;
    if (!selected || selected.threadId !== reference.threadId || selected.parentId === null) continue;
    parentRefs.set(postKey(reference.threadId, selected.parentId), {
      threadId: reference.threadId,
      postId: selected.parentId,
    });
  }
  const parentBatch = await readPostBatch(dependencies, [...parentRefs.values()], context);
  const parents = parentBatch.values;
  return {
    threads,
    posts,
    parents,
    anchors: [...threadAnchors, ...selectedPosts.anchors, ...parentBatch.anchors],
  };
}

type OwnerViews = Readonly<{
  subjects: Awaited<ReturnType<typeof readSubjectSummaryObservation>>['summaries'];
  accounts: ReadonlyMap<string, AccountDiscoverySummary | null>;
  questions: ReadonlyMap<string, Awaited<ReturnType<typeof readVisibleRatingQuestion>>>;
  confirmSubjects?: () => Promise<boolean>;
}>;

type ContextOwnerOptions = Readonly<{
  /** A current question is not a presentation of the recorded vote revision. */
  questionMetadata?: 'current' | 'unavailable';
  confirmSubjects?: boolean;
  authors?: boolean;
}>;

async function loadOwners(
  dependencies: FeedContentContextDependencies,
  references: readonly FeedContentContextReference[],
  content: ContentObservation,
  context: ReadContext,
  languages: readonly string[],
  options: ContextOwnerOptions = {},
): Promise<OwnerViews> {
  const subjectIds = new Set<string>();
  const accountIds = new Set<string>();
  const questionIds = new Set<string>();
  for (const reference of references) {
    const thread = content.threads.get(reference.threadId);
    if (!thread || thread.availability !== 'available') continue;
    if (options.authors !== false && thread.firstPost.availability === 'available')
      accountIds.add(thread.firstPost.authorId);
    if (
      thread.kind === 'review' &&
      thread.availability === 'available' &&
      thread.firstPost.availability === 'available'
    ) {
      const threadSubjects = thread.subjectIds;
      const openingSubjects = thread.firstPost.subjectIds;
      if (threadSubjects.length === 1 && openingSubjects.length === 1 && threadSubjects[0] === openingSubjects[0])
        subjectIds.add(threadSubjects[0]!);
      if (
        options.questionMetadata !== 'unavailable' &&
        readCitationDisclosure(thread.firstPost) === 'visible' &&
        thread.firstPost.voteCitation
      )
        questionIds.add(thread.firstPost.voteCitation.questionId);
    }
    if (!reference.postId) continue;
    const selected = content.posts.get(postKey(reference.threadId, reference.postId))?.value;
    if (options.authors !== false && selected?.availability === 'available') accountIds.add(selected.authorId);
    if (selected?.parentId) {
      const parent = content.parents.get(postKey(reference.threadId, selected.parentId))?.value;
      if (options.authors !== false && parent?.availability === 'available') accountIds.add(parent.authorId);
    }
  }
  if (subjectIds.size > FEED_CONTEXT_MAX_SUBJECTS) throw new RangeError('Feed context Subject bound exceeded');
  if (accountIds.size > FEED_CONTEXT_MAX_AUTHORS) throw new RangeError('Feed context author bound exceeded');
  if (questionIds.size > FEED_CONTEXT_MAX_QUESTIONS) throw new RangeError('Feed context question bound exceeded');

  const ownerContext = {
    pool: dependencies.pool,
    routeKey: dependencies.routeKey,
    access: dependencies.access,
    actor: context.actor,
    deadline: context.deadline,
  };
  let confirmSubjects: (() => Promise<boolean>) | undefined;
  const [subjects, accounts, questions] = await Promise.all([
    subjectIds.size
      ? options.confirmSubjects
        ? readSubjectSummaryObservation(ownerContext, [...subjectIds], { languages: [...languages] }).then(
            (observation) => {
              confirmSubjects = observation.current;
              return observation.summaries;
            },
          )
        : readSubjectSummaries(ownerContext, [...subjectIds], { languages: [...languages] })
      : Promise.resolve(new Map()),
    accountIds.size
      ? readAccountDiscoverySummaries(ownerContext, [...accountIds], { languages: [...languages] })
      : Promise.resolve(new Map()),
    Promise.all(
      [...questionIds].map(async (id) => {
        try {
          return [id, await readVisibleRatingQuestion(dependencies, context.actor, id, context.deadline)] as const;
        } catch (error) {
          if (error instanceof ProblemError && error.code === 'not_found') return [id, null] as const;
          throw error;
        }
      }),
    ).then((rows) => new Map(rows)),
  ]);
  return { subjects, accounts, questions, ...(confirmSubjects ? { confirmSubjects } : {}) };
}

function parentAuthor(id: string | null, accounts: OwnerViews['accounts']): FeedParentAuthor | null {
  if (!id) return null;
  const account = accounts.get(id);
  return account ? { id, displayName: account.displayName, handle: account.handle } : null;
}

function reviewContext(thread: ThreadView, owners: OwnerViews): FeedReviewContext | undefined {
  if (thread.kind !== 'review') return;
  const opening = thread.firstPost;
  let target: FeedReviewContext['target'];
  if (opening.availability !== 'available') target = { state: 'withheld' };
  else if (thread.subjectIds.length === 0 && opening.subjectIds.length === 0) target = { state: 'absent' };
  else if (
    thread.subjectIds.length !== 1 ||
    opening.subjectIds.length !== 1 ||
    thread.subjectIds[0] !== opening.subjectIds[0]
  )
    target = { state: 'withheld' };
  else {
    const id = thread.subjectIds[0]!;
    const subject = owners.subjects.get(id);
    target = subject
      ? { state: 'available', subject: { id, kind: subject.type, label: subject.label } }
      : { state: 'withheld' };
  }

  const disclosure = readCitationDisclosure(opening);
  const recorded = 'voteCitation' in opening ? opening.voteCitation : null;
  let citation: FeedReviewContext['citation'];
  if (opening.availability !== 'available' || disclosure === 'withheld') citation = { state: 'withheld' };
  else if (!recorded || disclosure === 'absent') citation = { state: 'absent' };
  else {
    const question = owners.questions.get(recorded.questionId);
    citation = question
      ? {
          state: 'available',
          question: {
            id: question.id,
            revision: question.revision,
            label: question.label,
            grain: question.grain,
            scale: {
              min: question.minimumUnits,
              max: question.maximumUnits,
              displayStep: question.stepUnits,
            },
          },
          units: recorded.units,
          voteRevision: recorded.revision,
        }
      : { state: 'withheld' };
  }
  return { target, citation };
}

function parentContext(
  reference: FeedContentContextReference,
  post: PostEntry | null,
  content: ContentObservation,
  owners: OwnerViews,
): FeedParentContext | undefined {
  if (!reference.postId || !post) return;
  if (post.threadId !== reference.threadId) return { kind: 'reply', parent: { state: 'withheld' } };
  if (post.parentId === null) return { kind: 'opening' };
  const parent = content.parents.get(postKey(reference.threadId, post.parentId))?.value;
  if (!parent || parent.threadId !== reference.threadId || parent.id !== post.parentId)
    return { kind: 'reply', parent: { state: 'withheld' } };
  if (parent.availability === 'erased') return { kind: 'reply', parent: { state: 'removed', id: parent.id } };
  if (parent.availability !== 'available') return { kind: 'reply', parent: { state: 'withheld' } };
  const presentation = documentPresentation(parent.body);
  return {
    kind: 'reply',
    parent: {
      state: 'available',
      id: parent.id,
      revisionId: parent.revisionId,
      createdAt: parent.createdAt,
      author: parentAuthor('authorId' in parent ? parent.authorId : null, owners.accounts),
      excerpt: boundedExcerpt(parent),
      language: presentation.language,
      spoiler: presentation.spoiler,
    },
  };
}

function composeValues(
  references: readonly FeedContentContextReference[],
  content: ContentObservation,
  owners: OwnerViews,
): ReadonlyMap<string, FeedContentContextValue> {
  return new Map(
    references.map((reference) => {
      const thread = content.threads.get(reference.threadId) ?? null;
      const post = reference.postId
        ? (content.posts.get(postKey(reference.threadId, reference.postId))?.value ?? null)
        : null;
      const threadSummary =
        thread?.availability === 'available' && thread.firstPost.availability === 'available'
          ? feedAuthor(owners.accounts.get(thread.firstPost.authorId))
          : undefined;
      const postSummary =
        post?.availability === 'available' ? feedAuthor(owners.accounts.get(post.authorId)) : undefined;
      const review = thread ? reviewContext(thread, owners) : undefined;
      const parent = post ? parentContext(reference, post, content, owners) : undefined;
      return [
        reference.key,
        {
          thread,
          post,
          ...(threadSummary ? { threadAuthor: threadSummary } : {}),
          ...(postSummary ? { postAuthor: postSummary } : {}),
          ...(review ? { reviewContext: review } : {}),
          ...(parent ? { parentContext: parent } : {}),
        },
      ] as const;
    }),
  );
}

/** Prepare one selected page of native review and immediate-parent context.
 * `finish` repeats all selected Content keys after owner hydration; Subject pages
 * pass their exact subject/place observer so membership stays with that owner. */
export async function prepareFeedContentContext(
  dependencies: FeedContentContextDependencies,
  references: readonly FeedContentContextReference[],
  context: ReadContext,
  languages: readonly string[] = [],
  options: ContextOwnerOptions & Readonly<{ observeThreads?: FeedThreadObserver }> = {},
): Promise<FeedContentContextComposition> {
  if (references.length > FEED_CONTEXT_MAX_REFERENCES)
    throw new RangeError('At most 20 selected feed content references');
  if (new Set(references.map(({ key }) => key)).size !== references.length)
    throw new TypeError('Duplicate feed context reference key');
  for (const reference of references) {
    const route = routeOf(reference.threadId);
    if (route === null || (reference.postId !== undefined && routeOf(reference.postId) !== route))
      throw new TypeError('Feed context requires exact native thread and post keys');
    if (reference.postId && reference.initialPost?.id !== undefined && reference.initialPost.id !== reference.postId)
      throw new TypeError('Feed context selected post key mismatch');
    if (reference.initialPost && !reference.postId) throw new TypeError('Feed context post has no selected key');
  }

  const initialThreads = initialThreadMap(references);
  const initialPosts = initialPostMap(references);
  const initial = await loadContent(dependencies, references, context, initialThreads, initialPosts, undefined, true);
  await loadOwners(dependencies, references, initial, context, languages, options);
  let completed = false;

  return {
    async finish() {
      if (completed) throw new TypeError('Feed context composition can finish only once');
      completed = true;
      const current = await loadContent(
        dependencies,
        references,
        context,
        initialThreads,
        initialPosts,
        options.observeThreads,
      );
      for (const reference of references) {
        if (!reference.postId) continue;
        const before = initial.posts.get(postKey(reference.threadId, reference.postId))?.value;
        const after = current.posts.get(postKey(reference.threadId, reference.postId))?.value;
        if (before && after && before.parentId !== after.parentId) throw new ProblemError('dependency_unavailable');
      }
      const owners = await loadOwners(dependencies, references, current, context, languages, options);
      if (owners.confirmSubjects && !(await owners.confirmSubjects())) throw new ProblemError('dependency_unavailable');
      return { contexts: composeValues(references, current, owners), anchors: current.anchors };
    },
  };
}
