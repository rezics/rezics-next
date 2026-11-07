import {
  READING_PAGE_MENTION_LIMIT,
  type ReadingPageNode,
  type ReadingPagePost,
  type ReadingPageMentionIdentity,
  type ReadingPageMentionSource,
  type ReadingPageMentions,
  type SelectedReadingPageMentionInventory,
  type ReadingPageMentionPort,
} from '../contract/index.ts';

function visitMentions(node: ReadingPageNode, visit: (id: string) => void, isRoutedId: (id: string) => boolean): void {
  const id = node.type === 'mention' ? node.attrs?.accountId : undefined;
  if (typeof id === 'string' && isRoutedId(id)) visit(id);
  for (const child of node.content ?? []) visitMentions(child, visit, isRoutedId);
}

/** Select only current readable bodies, preserving their page and document order. */
export function selectReadingPageMentions(
  posts: readonly ReadingPagePost[],
  isRoutedId: (id: string) => boolean,
): SelectedReadingPageMentionInventory {
  const identities: string[] = [];
  const selected = new Set<string>();
  const sources: ReadingPageMentionSource[] = [];
  for (const [pageIndex, post] of posts.entries()) {
    if (post.availability !== 'available' || !post.body || !post.revisionId || !post.sha256) continue;
    const references = new Set<string>();
    let overflow = false;
    visitMentions(
      post.body.doc,
      (id) => {
        if (selected.has(id)) references.add(id);
        else if (identities.length < READING_PAGE_MENTION_LIMIT) {
          identities.push(id);
          selected.add(id);
          references.add(id);
        } else overflow = true;
      },
      isRoutedId,
    );
    sources.push({
      postId: post.id,
      threadId: post.threadId,
      revisionId: post.revisionId,
      sha256: post.sha256,
      pageIndex,
      references: [...references],
      overflow,
    });
  }
  return { identities, sources, overflow: sources.some((source) => source.overflow) };
}

export function readingPageMentionIdentityViews(
  ids: readonly string[],
  accounts: readonly ReadingPageMentionIdentity[],
) {
  const byId = new Map<string, ReadingPageMentionIdentity>();
  for (const account of accounts) if (!byId.has(account.id)) byId.set(account.id, account);
  const seen = new Set<string>();
  const identities: ReadingPageMentions['identities'] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const account = byId.get(id);
    identities.push(
      account?.state === 'active'
        ? { id, state: 'active', handle: account.handle }
        : account?.state === 'deleted'
          ? { id, state: 'erased' }
          : { id, state: 'concealed' },
    );
  }
  return identities;
}

export function currentReadingPageMentions(
  selection: SelectedReadingPageMentionInventory,
  accounts: readonly ReadingPageMentionIdentity[],
): ReadingPageMentions {
  return {
    state: 'current',
    retryable: false,
    overflow: selection.overflow,
    sources: [...selection.sources],
    identities: readingPageMentionIdentityViews(selection.identities, accounts),
  };
}

export function unavailableReadingPageMentions(selection: SelectedReadingPageMentionInventory): ReadingPageMentions {
  return {
    state: 'unavailable',
    retryable: true,
    overflow: selection.overflow,
    sources: [...selection.sources],
    identities: [],
  };
}

/** A failed identity read preserves selected occurrences and cannot certify an empty batch. */
export async function readReadingPageMentions(
  port: ReadingPageMentionPort,
  selection: SelectedReadingPageMentionInventory,
): Promise<ReadingPageMentions> {
  if (!selection.identities.length) return currentReadingPageMentions(selection, []);
  const accounts = await port.read(selection.identities);
  return accounts.state === 'current'
    ? currentReadingPageMentions(selection, accounts.value)
    : unavailableReadingPageMentions(selection);
}
