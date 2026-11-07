import type { KernelClient } from '@rezics/client';

import type { PageAuthor, PageAuthors } from './read-contract';
export type { PageAuthor, PageAuthors } from './read-contract';

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
