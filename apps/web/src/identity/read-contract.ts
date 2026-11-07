import type { KernelClient, ReadingPageResponse } from '@rezics/client';

type AccountsRead = NonNullable<Awaited<ReturnType<KernelClient['accounts']['get']>>['data']>;

export type PageAuthor =
  | AccountsRead['accounts'][number]
  | (ReadingPageResponse['authors']['items'][number] & { state?: never; kind?: never });
export type PageAuthors = Record<string, PageAuthor> | null;
