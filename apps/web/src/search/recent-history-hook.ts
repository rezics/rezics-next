import { getLocale } from '../paraglide/runtime.js';
import { useRecentSearches } from './recent';
import type { RecentEntry, RecentHistory } from './recent-history';

/** Compatibility for the shared shell: one native coordinator, never a second local scope cache. */
export function useRecentHistory(_bucket: string | null): RecentHistory {
  const recent = useRecentSearches();
  return {
    entries: recent.entries.flatMap<RecentEntry>((item) => {
      const common = { id: item.id, visitedAt: Date.parse(item.lastUsed) };
      if (item.entry.kind === 'query') return [{ ...common, query: item.entry.text }];
      if (!item.display) return [];
      const ref = item.entry.scope;
      return [
        {
          ...common,
          query: '',
          scope: {
            kind: ref.kind === 'route' ? 'Library' : ref.kind === 'realm' ? 'Realm' : 'Collection',
            id: ref.kind === 'route' ? ref.route : ref.id,
            name: item.display.name,
          },
        },
      ];
    }),
    persistence: recent.status === 'local' || recent.status === 'ready' ? 'local' : 'memory',
    sync: recent.status === 'local' ? 'local-only' : recent.status === 'ready' ? 'synced' : 'pending',
    // Visited scopes are recorded from current page owner data by the coordinator, never from retained shell labels.
    remember: (query) => {
      if (query.trim()) recent.remember({ kind: 'query', text: query.trim(), languages: [getLocale()] });
    },
    remove: recent.onRemove,
  };
}
