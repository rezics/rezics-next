import type { ReadingPageResponse } from '@rezics/client';
import type { DocumentNode } from '@rezics/document';
import type { DocumentMentions } from '@rezics/ui/document-body';
import type { ThreadPost } from './thread-page';

export type ThreadMentionProjection = NonNullable<ReadingPageResponse['mentions']>;

const handlePattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function referencedInPost(post: Extract<ThreadPost, { availability: 'available' }>, references: readonly string[]) {
  const expected = new Set(references);
  const found = new Set<string>();
  const pending: DocumentNode[] = [post.body.doc];
  while (pending.length && found.size < expected.size) {
    const node = pending.pop()!;
    const id = node.type === 'mention' ? node.attrs?.accountId : undefined;
    if (typeof id === 'string' && expected.has(id)) found.add(id);
    for (const child of node.content ?? []) pending.push(child);
  }
  return found;
}

/** Resolve only active identities referenced by an exact current post on this admitted page. */
export function receiveThreadDocumentMentions(
  projection: ThreadMentionProjection | undefined,
  posts: readonly ThreadPost[],
): DocumentMentions {
  if (!projection || projection.state !== 'current') return {};
  const identities = new Map<
    ThreadMentionProjection['identities'][number]['id'],
    ThreadMentionProjection['identities'][number]
  >();
  for (const identity of projection.identities) {
    // The wire schema bounds identities but does not require unique IDs. A duplicate could
    // otherwise let an active row override a concealed or erased row for the same account.
    if (identities.has(identity.id)) return {};
    identities.set(identity.id, identity);
  }
  const resolved: Record<string, { handle: string }> = {};
  for (const source of projection.sources) {
    const post = posts[source.pageIndex];
    if (
      !post ||
      post.availability !== 'available' ||
      post.id !== source.postId ||
      post.threadId !== source.threadId ||
      post.revisionId !== source.revisionId ||
      post.sha256 !== source.sha256
    )
      continue;
    const actualReferences = referencedInPost(post, source.references);
    for (const id of actualReferences) {
      const identity = identities.get(id);
      if (identity?.state === 'active' && identity.handle && handlePattern.test(identity.handle))
        resolved[id] ??= { handle: identity.handle };
    }
  }
  return resolved;
}
