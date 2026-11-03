import type { PageAuthor } from '../identity/read';
import type { HistoryPage, HistoryView } from './post-history-lifetime';
import { m } from '../paraglide/messages.js';

export type HistoryRevision = HistoryPage['revisions'][number];

/** Small admitted metadata only. A summary never retains or walks a document tree. */
export type RevisionSummary = {
  index: number;
  postId: string;
  revisionId: string;
  recordedAt: string;
  revised: boolean;
  author: string;
  authorHref: string | null;
  licence: string;
  availability: HistoryRevision['availability'];
  subjectCount: number;
  scored: boolean;
};

export const HISTORY_SUMMARY_LIMIT = 240;
const AUTHOR_LIMIT = 120;
const LICENCE_LIMIT = 80;

/** Stop at the bound, including for astral characters; do not first allocate the entire string. */
export function boundedHistoryText(value: string, limit = HISTORY_SUMMARY_LIMIT): string {
  if (limit <= 0) return '';
  const characters: string[] = [];
  for (const point of value) {
    if (characters.length === limit) {
      characters[limit - 1] = '…';
      break;
    }
    characters.push(point);
  }
  return characters.join('');
}

function authorDisclosure(author: PageAuthor | undefined, locale: string) {
  // Match Byline's deleted/unknown disclosure. Never recover a removed name from another row.
  if (author?.state === 'deleted') {
    return {
      label: author.kind === 'organization' ? m.thread_author_deleted_organization() : m.thread_author_deleted(),
      href: null,
    };
  }
  if (!author || (!author.displayName && !author.handle)) {
    return { label: m.thread_author_unknown(), href: null };
  }
  return {
    label: author.displayName || `@${author.handle}`,
    href: author.handle ? `/${encodeURIComponent(locale)}/@${encodeURIComponent(author.handle)}` : null,
  };
}

/** One pass in native order. No preview, neighbour comparison, inferred head, or additional read. */
export function projectRevisionSummaries(
  entries: HistoryView['revisions'],
  authors: HistoryPage['authors'],
  locale: string,
): RevisionSummary[] {
  return entries.map((entry, index) => {
    const { revision } = entry;
    const author = authorDisclosure(
      revision.availability === 'available' ? authors?.[revision.authorId] : entry.summaryAuthor,
      locale,
    );
    return {
      index,
      postId: revision.id,
      revisionId: revision.revisionId,
      recordedAt: revision.revisedAt ?? revision.createdAt,
      revised: revision.revisedAt !== null,
      author: boundedHistoryText(author.label, AUTHOR_LIMIT),
      authorHref: author.href,
      licence: boundedHistoryText(revision.licence, LICENCE_LIMIT),
      availability: revision.availability,
      subjectCount: revision.subjectIds.length,
      scored: revision.voteCitation !== null && revision.voteCitation !== undefined,
    };
  });
}

/** IDs in local anchors are identities only; names, documents and credentials never enter the URL. */
export function revisionHistoryAnchor(postId: string, revisionId: string) {
  return `history-${encodeURIComponent(postId)}-${encodeURIComponent(revisionId)}`;
}
