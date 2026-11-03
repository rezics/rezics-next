import type { KernelClient } from '@rezics/client';
import type { DocumentNode } from '@rezics/document';
import type { DocumentMentions } from '@rezics/ui/document-body';
import { readPageAuthors, type PageAuthors } from '../identity/read';
import {
  loadRevisionDocumentMedia,
  revisionDocumentImageIds,
  type RevisionDocumentMedia,
} from './exact-revision-media';
import { readAuthorRevisionVotes, readRevisionSubjects, type RevisionVotes } from './revision-provenance';
import type { ThreadSubject } from './subjects';

type PostResource = ReturnType<KernelClient['posts']>;
type NativeHistoryPage = NonNullable<Awaited<ReturnType<PostResource['revisions']['get']>>['data']>;

export type PostHistoryReadData =
  | { available: false; transportFailed?: true }
  | {
      available: true;
      revisions: NativeHistoryPage['revisions'];
      next: NativeHistoryPage['next'];
      authors: PageAuthors;
      mentions: DocumentMentions;
      subjects: ThreadSubject[];
      reviewVotes: RevisionVotes;
      documentMedia: RevisionDocumentMedia;
      now: string;
    };

export const POST_HISTORY_DEFAULT_LIMIT = 20;
export const POST_HISTORY_MAXIMUM_LIMIT = 100;

/** One index for the admitted author/mention keys; overlapping identities are hydrated only once. */
async function readHistoryIdentities(client: KernelClient, revisions: NativeHistoryPage['revisions']) {
  const authorIds = new Set<string>();
  const mentionIds = new Set<string>();
  function visit(node: DocumentNode) {
    if (mentionIds.size === 100) return;
    if (node.type === 'mention' && typeof node.attrs?.accountId === 'string') mentionIds.add(node.attrs.accountId);
    for (const child of node.content ?? []) {
      if (mentionIds.size === 100) break;
      visit(child);
    }
  }
  for (const revision of revisions) {
    authorIds.add(revision.authorId);
    if (revision.availability === 'available' && revision.body) visit(revision.body.doc);
  }
  const ids = [...new Set([...authorIds, ...mentionIds])];
  // Preserve the existing 100-identity batch cap, including at most 100 distinct body mentions.
  const batches: Promise<PageAuthors>[] = [];
  for (let offset = 0; offset < ids.length; offset += 100)
    batches.push(readPageAuthors(client, ids.slice(offset, offset + 100)));
  const authors: NonNullable<PageAuthors> = {};
  const mentions: Record<string, { handle: string }> = {};
  let authorReadFailed = false;
  const pages = await Promise.all(batches);
  for (let index = 0; index < pages.length; index++) {
    const accounts = pages[index];
    if (!accounts) {
      if (ids.slice(index * 100, (index + 1) * 100).some((id) => authorIds.has(id))) authorReadFailed = true;
      continue;
    }
    for (const account of Object.values(accounts)) {
      if (authorIds.has(account.id)) authors[account.id] = account;
      if (mentionIds.has(account.id) && account.state === 'active' && account.handle)
        mentions[account.id] = { handle: account.handle };
    }
  }
  return { authors: authorReadFailed ? null : authors, mentions };
}

/**
 * Check the exact page before using its keys for identity, media or private vote reads.
 * The generated client owns the row schema; this checks association and the native page bound only.
 * Repeated post/author IDs are normal, repeated revision identities are not separate historical rows.
 */
function matchesHistoryAddress(page: NativeHistoryPage, postId: string): boolean {
  if (page.revisions.length > POST_HISTORY_MAXIMUM_LIMIT) return false;
  const revisions = new Set<string>();
  const threadId = page.revisions[0]?.threadId;
  for (const revision of page.revisions) {
    if (revision.id !== postId || revision.threadId !== threadId || revisions.has(revision.revisionId)) return false;
    revisions.add(revision.revisionId);
  }
  return true;
}

/**
 * One explicit history address, using the credential already prepared by the server-function caller.
 * No session preparation, current-head read, cursor decoding, refill or follow-up history request occurs here.
 * The caller keeps actual-reader provenance even when this transport or a required dependency fails.
 *
 * The installed closed response currently supplies only revisions/next. Keep the existing optional joins
 * until Content publishes its generated current-context/enrichment variants; do not guess their wire shape.
 */
export async function loadPostHistoryPage(
  client: KernelClient,
  address: { postId: string; cursor?: string },
  reader: { authorization: string | null; subject: string | undefined },
): Promise<PostHistoryReadData> {
  const { authorization, subject } = reader;
  try {
    const result = await client.posts({ id: address.postId }).revisions.get({
      query: {
        limit: POST_HISTORY_DEFAULT_LIMIT,
        ...(address.cursor !== undefined ? { cursor: address.cursor } : {}),
      },
      ...(authorization ? { headers: { authorization } } : {}),
    });
    if (result.error || !result.data || !matchesHistoryAddress(result.data, address.postId))
      return { available: false };

    const { revisions, next } = result.data;
    const documentMedia = await loadRevisionDocumentMedia(client, revisionDocumentImageIds(revisions), authorization);
    const [{ authors, mentions }, subjects, reviewVotes] = await Promise.all([
      readHistoryIdentities(client, revisions),
      readRevisionSubjects(client, revisions),
      readAuthorRevisionVotes(client, revisions, subject && authorization ? { id: subject, authorization } : null),
    ]);
    return {
      available: true,
      revisions,
      next,
      authors,
      mentions,
      subjects,
      reviewVotes,
      documentMedia,
      now: new Date().toISOString(),
    };
  } catch {
    // Retry retains this address; a failed read cannot certify an empty history.
    return { available: false, transportFailed: true };
  }
}
