import type { KernelClient } from '@rezics/client';

type AccountsRead = NonNullable<Awaited<ReturnType<KernelClient['accounts']['get']>>['data']>;
export type PageAuthor =
  | AccountsRead['accounts'][number]
  | (import('../threads/thread-page').ThreadPageAuthor & { state?: never; kind?: never });
export type PageAuthors = Record<string, PageAuthor> | null;

/** Reads a page's distinct public identities. A failed optional read has no effect on the page's primary content. */
export async function readPageAuthors(
  client: KernelClient,
  authorIds: readonly string[],
  signal?: AbortSignal,
): Promise<PageAuthors> {
  signal?.throwIfAborted();
  const ids = [...new Set(authorIds)];
  if (ids.length === 0) return {};
  try {
    const result = await client.accounts.get({
      query: { ids: ids.join(',') },
      ...(signal ? { fetch: { signal } } : {}),
    });
    signal?.throwIfAborted();
    if (result.error || !result.data) return null;
    return Object.fromEntries(result.data.accounts.map((account) => [account.id, account]));
  } catch {
    signal?.throwIfAborted();
    return null;
  }
}
