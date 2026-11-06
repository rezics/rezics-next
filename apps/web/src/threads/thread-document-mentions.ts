import type { ReadingPageResponse } from '@rezics/client';
import type { DocumentNode } from '@rezics/document';
import type { DocumentMentions } from '@rezics/ui/document-body';
import type { ThreadPost } from './thread-page';

export type ThreadMentionProjection = NonNullable<ReadingPageResponse['mentions']>;
type MentionIdentity = ThreadMentionProjection['identities'][number];

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

function admittedIdentities(projection: ThreadMentionProjection) {
  const identities = new Map<MentionIdentity['id'], MentionIdentity>();
  for (const identity of projection.identities) {
    // The wire schema bounds identities but does not require unique IDs. The first
    // disclosed row is the authority for that account on this page.
    if (!identities.has(identity.id)) identities.set(identity.id, identity);
  }
  return identities;
}

/** Resolve only active identities referenced by an exact current post on this admitted page. */
export function receiveThreadDocumentMentions(
  projection: ThreadMentionProjection | undefined,
  posts: readonly ThreadPost[],
): DocumentMentions {
  if (!projection || projection.state !== 'current') return {};
  const identities = admittedIdentities(projection);
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
