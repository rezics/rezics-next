import type { DocumentNode } from '@rezics/document';
import { readSubjectSummaryObservation } from '../semantic/summaries.ts';
import { ProblemError } from '../http/problem-error.ts';
import type { FeedConversationActivity } from './feed-contract.ts';
import { createConversationActivityBatch } from './conversation-activity.ts';
import type { AnchoredPosition, FeedParentContext, FeedReviewContext, ReadContext } from './model.ts';
import {
  readCitationDisclosure,
  readPost,
  type ContentReadDependencies,
  type PostEntry,
  type ThreadView,
} from './reads.ts';

const MAX_SELECTED = 20;
const MAX_NODES = 4096;
const MAX_DEPTH = 64;
const MAX_EXCERPT_CHARACTERS = 160;
const MAX_EXCERPT_BYTES = 640;
const MAX_CONTEXT_BYTES = 32 * 1024;

export type AuthorContextReference = Readonly<{ thread: ThreadView; post?: PostEntry }>;
export type AuthorItemContext = Readonly<{
  parentContext?: FeedParentContext;
  conversationActivity: FeedConversationActivity;
  reviewContext?: FeedReviewContext;
}>;
type AuthorItemContextDependencies = ContentReadDependencies & Readonly<{ routeKey: Uint8Array }>;

/** Text only from visible document nodes. Attributes, annotation text, opaque
 * payloads, alt text, media captions and mention identities are not excerpts.
 * Inspect the whole admitted tree for spoilers even after the text budget fills.
 */
function presentation(post: Extract<PostEntry, { availability: 'available' }>) {
  let nodes = 0;
  let characters = 0;
  let bytes = 0;
  let excerpt = '';
  let language: string | null = null;
  let spoiler = false;
  const containers = new Set([
    'doc',
    'paragraph',
    'heading',
    'blockquote',
    'bulletList',
    'orderedList',
    'listItem',
    'codeBlock',
    'table',
    'tableRow',
    'tableCell',
    'tableHeader',
    'ruby',
  ]);
  const append = (text: string) => {
    for (const character of text) {
      const width = Buffer.byteLength(character, 'utf8');
      if (characters === MAX_EXCERPT_CHARACTERS || bytes + width > MAX_EXCERPT_BYTES) break;
      excerpt += character;
      characters++;
      bytes += width;
    }
  };
  const visit = (node: DocumentNode, depth: number): boolean => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) return false;
    if (!language && typeof node.attrs?.lang === 'string') {
      if (Buffer.byteLength(node.attrs.lang) > 256) return false;
      language = node.attrs.lang;
    }
    if (node.marks?.some((mark) => mark.type === 'spoiler')) spoiler = true;
    if (node.type === 'text') append(node.text ?? '');
    else if (node.type === 'hardBreak') append(' ');
    else if (containers.has(node.type)) {
      for (const child of node.content ?? []) if (!visit(child, depth + 1)) return false;
      if (['paragraph', 'heading', 'codeBlock', 'tableCell'].includes(node.type)) append(' ');
    }
    return true;
  };
  if (!visit(post.body.doc, 0)) return null;
  return { excerpt: excerpt.replace(/\s+/gu, ' ').trim() || null, language, spoiler };
}

const parentKey = (threadId: string, postId: string) => `${threadId}:${postId}`;

/** Selected native parents only; anonymous disclosure never inherits an editor's
 * rights. No account labels, media, recursive context or private viewer slots.
 * Native readPost retains responsibility for ancestor/place/Access admission.
 */
export async function prepareAuthorItemContext(
  dependencies: AuthorItemContextDependencies,
  references: readonly AuthorContextReference[],
  context: ReadContext,
): Promise<
  Readonly<{
    anchors: AnchoredPosition[];
    finish(): Promise<ReadonlyMap<string, AuthorItemContext>>;
    confirm(): Promise<void>;
  }>
> {
  if (references.length > MAX_SELECTED) throw new RangeError('At most 20 author contexts');
  const publicContext = { ...context, actor: { kind: 'anonymous' as const } };
  const activity = createConversationActivityBatch(dependencies.pool);
  const selectedActivity = await activity.select(
    [...new Set(references.map(({ thread }) => thread.id))],
    context.deadline,
  );
  const parents = new Map<string, { threadId: string; postId: string; initial: PostEntry | null }>();
  const parentFinal = new Map<string, PostEntry | null>();
  const anchors = selectedActivity.flatMap((item) => (item.status === 'current' ? [item.witness.source] : []));
  const subjectIds = new Set<string>();
  for (const { thread, post } of references) {
    const opening = thread.firstPost;
    if (
      !post &&
      thread.kind === 'review' &&
      thread.availability === 'available' &&
      opening.availability === 'available' &&
      thread.subjectIds.length === 1 &&
      opening.subjectIds.length === 1 &&
      thread.subjectIds[0] === opening.subjectIds[0]
    )
      subjectIds.add(thread.subjectIds[0]!);
  }
  const subjects = subjectIds.size
    ? await readSubjectSummaryObservation({ ...dependencies, actor: context.actor, deadline: context.deadline }, [
        ...subjectIds,
      ])
    : undefined;
  for (const { thread, post } of references) {
    if (!post || post.threadId !== thread.id) {
      if (post) throw new TypeError('Author context thread mismatch');
      continue;
    }
    if (!post.parentId) continue;
    const key = parentKey(thread.id, post.parentId);
    if (parents.has(key)) continue;
    const observed = await readPost(dependencies, thread.id, post.parentId, publicContext);
    anchors.push(observed.anchor);
    parents.set(key, { threadId: thread.id, postId: post.parentId, initial: observed.value });
  }
  let finished = false;
  let confirmed = false;
  return {
    anchors,
    async finish() {
      if (finished) throw new TypeError('Author context finish only once');
      finished = true;
      const confirmedActivity = await activity.confirm(selectedActivity, context.deadline);
      if (confirmedActivity.some((item) => item.status === 'withheld' && item.reason === 'stale'))
        throw new ProblemError('dependency_unavailable');
      const byThread = new Map(confirmedActivity.map((item) => [item.threadId, item]));
      for (const item of confirmedActivity) if (item.status === 'current') anchors.push(item.witness.source);
      const parentViews = new Map<string, FeedParentContext>();
      for (const [key, parent] of parents) {
        const current = await readPost(dependencies, parent.threadId, parent.postId, publicContext);
        anchors.push(current.anchor);
        parentFinal.set(key, current.value);
        const initial = parent.initial;
        const value = current.value;
        const excerpt =
          value?.availability === 'available' &&
          initial?.availability === 'available' &&
          value.id === parent.postId &&
          value.threadId === parent.threadId &&
          JSON.stringify(initial) === JSON.stringify(value)
            ? presentation(value)
            : null;
        parentViews.set(
          key,
          excerpt && value?.availability === 'available'
            ? {
                kind: 'reply',
                parent: {
                  state: 'available',
                  id: value.id,
                  revisionId: value.revisionId,
                  createdAt: value.createdAt,
                  author: null,
                  ...excerpt,
                },
              }
            : { kind: 'reply', parent: { state: 'withheld' } },
        );
      }
      const result = new Map<string, AuthorItemContext>();
      for (const { thread, post } of references) {
        const selection = byThread.get(thread.id);
        const conversationActivity: FeedConversationActivity =
          selection?.status === 'current'
            ? {
                state: 'current',
                cohort: 'public',
                count: selection.replyCount,
                lastActivityAt: selection.lastContributionAt,
              }
            : { state: 'withheld' };
        const parentContext: FeedParentContext | undefined = post
          ? post.parentId === null
            ? { kind: 'opening' }
            : (parentViews.get(parentKey(thread.id, post.parentId)) ?? { kind: 'reply', parent: { state: 'withheld' } })
          : undefined;
        const opening = thread.firstPost;
        let reviewContext: FeedReviewContext | undefined;
        if (thread.kind === 'review') {
          let target: FeedReviewContext['target'];
          if (thread.availability !== 'available' || opening.availability !== 'available') {
            target = { state: 'withheld' };
          } else if (thread.subjectIds.length === 0 && opening.subjectIds.length === 0) {
            target = { state: 'absent' };
          } else if (
            thread.subjectIds.length !== 1 ||
            opening.subjectIds.length !== 1 ||
            thread.subjectIds[0] !== opening.subjectIds[0]
          ) {
            target = { state: 'withheld' };
          } else {
            const id = thread.subjectIds[0]!;
            const subject = subjects?.summaries.get(id) ?? null;
            target = subject
              ? { state: 'available', subject: { id, kind: subject.type, label: subject.label } }
              : { state: 'withheld' };
          }
          // Exact published voteCitation remains on the native opening post. Its historical
          // question label and scale are unavailable until an exact reader exists.
          const citation =
            opening.availability !== 'available' || readCitationDisclosure(opening) !== 'absent'
              ? { state: 'withheld' as const }
              : { state: 'absent' as const };
          reviewContext = { target, citation };
        }
        result.set(post?.id ?? thread.id, {
          conversationActivity,
          ...(parentContext ? { parentContext } : {}),
          ...(reviewContext ? { reviewContext } : {}),
        });
      }
      if (Buffer.byteLength(JSON.stringify([...result])) > MAX_CONTEXT_BYTES)
        throw new ProblemError('dependency_unavailable');
      return result;
    },
    async confirm() {
      if (!finished) throw new TypeError('Author context must finish before confirmation');
      if (confirmed) throw new TypeError('Author context confirmation only once');
      confirmed = true;
      const confirmedActivity = await activity.confirm(selectedActivity, context.deadline);
      if (confirmedActivity.some((item) => item.status === 'withheld' && item.reason === 'stale'))
        throw new ProblemError('dependency_unavailable');
      for (const item of confirmedActivity) if (item.status === 'current') anchors.push(item.witness.source);
      for (const [key, parent] of parents) {
        const current = await readPost(dependencies, parent.threadId, parent.postId, publicContext);
        anchors.push(current.anchor);
        if (JSON.stringify(current.value) !== JSON.stringify(parentFinal.get(key)))
          throw new ProblemError('dependency_unavailable');
      }
      if (subjects && !(await subjects.current())) throw new ProblemError('dependency_unavailable');
    },
  };
}
