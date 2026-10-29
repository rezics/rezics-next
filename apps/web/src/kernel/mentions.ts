import type { KernelClient } from '@rezics/client';
import type { DocumentNode, DocumentSnapshot } from '@rezics/document';
import type { DocumentMentions } from '@rezics/ui/document-body';
import type { MentionAccount } from '@rezics/ui/editor-mention';

const handlePattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** One exact public handle read. The source's caller owns debounce and cancellation. */
export async function lookupAccountMention(
  client: KernelClient,
  handle: string,
  signal: AbortSignal,
): Promise<MentionAccount | null> {
  if (!handlePattern.test(handle) || signal.aborted) return null;
  const result = await client.accounts.get({ query: { handle }, fetch: { signal } });
  if (signal.aborted || result.error || !result.data) return null;
  const account = result.data.accounts.find(
    (account) =>
      account.state === 'active' && account.handle !== null && account.handle.toLowerCase() === handle.toLowerCase(),
  );
  return account?.handle
    ? { accountId: account.id, handle: account.handle, ...(account.displayName ? { name: account.displayName } : {}) }
    : null;
}

/** Collect the first 100 distinct account ids in document order and resolve them in one optional public read. */
export async function readDocumentMentions(
  client: KernelClient,
  documents: readonly (DocumentSnapshot | null)[],
): Promise<DocumentMentions> {
  const ids = new Set<string>();
  function visit(node: DocumentNode) {
    if (ids.size >= 100) return;
    if (node.type === 'mention' && typeof node.attrs?.accountId === 'string') ids.add(node.attrs.accountId);
    for (const child of node.content ?? []) visit(child);
  }
  for (const document of documents) if (document) visit(document.doc);
  if (!ids.size) return {};
  try {
    const result = await client.accounts.get({ query: { ids: [...ids].join(',') } });
    if (result.error || !result.data) return {};
    return Object.fromEntries(
      result.data.accounts
        .filter((account) => ids.has(account.id) && account.state === 'active' && typeof account.handle === 'string')
        .map((account) => [account.id, { handle: account.handle! }]),
    );
  } catch {
    return {};
  }
}
