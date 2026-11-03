import type { KernelClient } from '@rezics/client';
import type { DocumentMentions } from '@rezics/ui/document-body';
import type { PageAuthors } from '../identity/read';
import type { RevisionDocumentMedia } from './exact-revision-media';
import type { ThreadSubject } from './subjects';

type PostResource = ReturnType<KernelClient['posts']>;
export type NativeHistoryPage = NonNullable<Awaited<ReturnType<PostResource['revisions']['get']>>['data']>;
export type HistoryContext = NativeHistoryPage['page'];
export type HistoryScore = HistoryContext['reviewScores']['items'][number];
export type HistoryComparison = HistoryContext['navigation']['compareToHead'][number];

/** Index native keys once. No current-head, identity, subject or media hydration is performed here. */
export function projectHistoryContext(page: HistoryContext) {
  const authors: PageAuthors = page.authors.state === 'current' ? {} : null;
  for (const author of page.authors.items) {
    if (authors && author.state === 'available')
      authors[author.id] = {
        id: author.id,
        state: 'active',
        kind: 'actor',
        displayName: author.displayName,
        handle: author.handle,
        avatar: author.avatar,
        automated: false,
        operatorId: null,
      };
  }
  const mentions: DocumentMentions = {};
  if (page.mentions.state === 'current')
    for (const mention of page.mentions.items)
      if (mention.state === 'available') mentions[mention.id] = { handle: mention.handle };
  const subjects: ThreadSubject[] = [];
  if (page.subjects.state === 'current')
    for (const subject of page.subjects.items)
      if (subject.state === 'available')
        subjects.push({
          // Keep the original key even when the current summary resolves to a merged terminal subject.
          id: subject.id,
          label: subject.summary.label?.value ?? null,
          labels: {},
          types: subject.summary.types,
          cover: subject.summary.cover,
        });
  const documentMedia: RevisionDocumentMedia =
    page.media.state === 'current'
      ? {
          kind: 'ready',
          images: new Map(
            page.media.items.flatMap((item) => (item.state === 'available' ? [[item.id, item.image] as const] : [])),
          ),
        }
      : { kind: 'unavailable' };
  const scores = new Map(page.reviewScores.items.map((item) => [item.revisionId, item]));
  const comparisons = new Map(page.navigation.compareToHead.map((item) => [item.fromRevisionId, item]));
  const exact = new Set(page.navigation.exact.map((item) => item.revisionId));
  return { authors, mentions, subjects, documentMedia, scores, comparisons, exact };
}

/** Native context and destinations must belong to this page, never merely a matching URL. */
export function historyContextMatches(
  response: NativeHistoryPage,
  postId: string,
  reader: { authorization: string | null; subject: string | undefined },
) {
  const page = response.page;
  if (!!reader.authorization !== !!reader.subject) return false;
  if (
    page.head.postId !== postId ||
    page.conversation.boardId !== page.board.id ||
    (page.place.kind === 'realm' ? page.place.id !== page.board.realmId : page.board.realmId !== null) ||
    (reader.authorization && reader.subject
      ? page.viewer.kind !== 'account' || page.viewer.id !== reader.subject
      : page.viewer.kind !== 'anonymous')
  )
    return false;
  const revisions = new Map(response.revisions.map((revision) => [revision.revisionId, revision]));
  for (const revision of response.revisions)
    if (revision.threadId !== page.conversation.id || revision.boardId !== page.board.id) return false;
  const exact = new Set<string>();
  for (const item of page.navigation.exact) {
    if (item.postId !== postId || !revisions.has(item.revisionId) || exact.has(item.revisionId)) return false;
    exact.add(item.revisionId);
  }
  if (exact.size !== revisions.size) return false;
  const comparisons = new Set<string>();
  for (const item of page.navigation.compareToHead) {
    const revision = revisions.get(item.fromRevisionId);
    if (
      item.postId !== postId ||
      !revision ||
      revision.availability !== 'available' ||
      item.toRevisionId !== page.head.revisionId ||
      page.head.state !== 'current' ||
      item.fromRevisionId === item.toRevisionId ||
      comparisons.has(item.fromRevisionId)
    )
      return false;
    comparisons.add(item.fromRevisionId);
  }
  const scores = new Set<string>();
  for (const item of page.reviewScores.items) {
    const revision = revisions.get(item.revisionId);
    if (!revision || scores.has(item.revisionId)) return false;
    scores.add(item.revisionId);
    if (
      item.state === 'available' &&
      (item.citation.questionId !== revision.voteCitation?.questionId ||
        item.citation.revision !== revision.voteCitation.revision ||
        item.citation.units !== revision.voteCitation.units ||
        item.question.id !== item.citation.questionId)
    )
      return false;
  }
  return true;
}
