import { queryOptions } from '@tanstack/react-query';
import { characterPersonQueryKey, type CharacterPersonSearch } from './character-person';
import { readCharacterPerson } from './character-person-window-server';
import type { DiscoveryState } from './discovery';

/** The public reader lease owns both dispatch and completion, including transports that ignore cancellation. */
export function characterPersonQueryOptions(
  locale: string,
  search: CharacterPersonSearch,
  reader: string,
  current?: () => boolean,
) {
  return queryOptions({
    queryKey: characterPersonQueryKey(locale, reader, search),
    queryFn: async ({ signal }): Promise<{ discovery: DiscoveryState; restarted: boolean }> => {
      if (current && !current()) throw new DOMException('Reader retired', 'AbortError');
      const result = await readCharacterPerson({ data: { locale, search }, signal });
      signal.throwIfAborted();
      if (current && !current()) throw new DOMException('Reader retired', 'AbortError');
      return result;
    },
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnMount: true,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    enabled: true,
  });
}
