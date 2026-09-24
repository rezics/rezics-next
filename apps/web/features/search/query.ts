import { treaty } from '@elysia/eden';
import { queryOptions } from '@tanstack/react-query';
import type { MainApp } from '@rezics/main/app';

export type SearchContext = { kind: 'global' } | { kind: 'realm'; id: string };
export interface SearchSelection {
  phrase: string;
  context: SearchContext;
  language: string | null;
}

export function searchQueryOptions(selection: SearchSelection) {
  return queryOptions({
    queryKey: ['public-search', selection.phrase, selection.context.kind,
      selection.context.kind === 'realm' ? selection.context.id : '', selection.language],
    enabled: selection.phrase.trim().length >= 2,
    queryFn: async () => {
      const main = treaty<MainApp>(new URL('/api/main', window.location.origin).toString());
      const phrase = selection.phrase.trim();
      const response = selection.context.kind === 'realm'
        ? await main.v1.queries.post({ profile: 'public-realm-phrase-v1',
          context: { kind: 'realm-local', id: selection.context.id },
          phrase, language: selection.language })
        : await main.v1.queries.post({ profile: 'public-main-phrase-v1',
          phrase, language: selection.language });
      if (response.error) throw new Error(response.error.value.title);
      if (!response.data) throw new Error('Search returned no result envelope');
      return response.data;
    },
  });
}
