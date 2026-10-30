import { ChevronRight, Clock, TrendingUp, UserRound, X } from 'lucide-react';
import { useState } from 'react';
import { m } from '../paraglide/messages.js';
import type { RecentEntry, RecentHistory } from './recent-history';

export type SearchRealmDiscovery = { id: string; name: string; description: string; href: string; avatar?: string };
/** Supply only responses from a real owner endpoint. Absent endpoints leave discovery absent. */
export type SearchDiscovery = {
  popularRealms?: readonly SearchRealmDiscovery[];
  trendingQueries?: readonly string[];
  trendingRealms?: readonly SearchRealmDiscovery[];
};
const control =
  'flex min-h-11 items-center gap-3 rounded-xl px-2 text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring';
export function RecentPanel({
  history,
  recent,
  onSelect,
  discovery,
  onQuery,
}: {
  history?: RecentHistory | undefined;
  recent?: React.ReactNode;
  onSelect?: ((entry: RecentEntry) => void) | undefined;
  discovery?: SearchDiscovery | undefined;
  onQuery?: ((query: string) => void) | undefined;
}) {
  const [all, setAll] = useState(false);
  const entries = history?.entries ?? [];
  const realms = (title: string, values: readonly SearchRealmDiscovery[] | undefined) =>
    values?.length ? (
      <section className="space-y-2 pt-5">
        <h3 className="px-2 text-sm font-semibold">{title}</h3>
        {values.slice(0, 8).map((realm) => (
          <a key={realm.id} href={realm.href} className={control}>
            {realm.avatar ? (
              <img src={realm.avatar} alt="" className="size-9 shrink-0 rounded-full object-cover" />
            ) : (
              <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-full bg-muted">
                <UserRound className="size-4" />
              </span>
            )}
            <span className="min-w-0">
              <span className="block truncate font-medium">{realm.name}</span>
              <span className="block truncate text-xs text-muted-foreground">{realm.description}</span>
            </span>
          </a>
        ))}
      </section>
    ) : null;
  return (
    <div data-search-discovery className="px-2 py-4">
      {recent ?? (
      <section className="space-y-2">
        <div className="flex items-center justify-between gap-2 px-2">
          <h2 className="font-semibold">{all ? m.header_search_history() : m.header_search_recent()}</h2>
          <button type="button" className={control} aria-expanded={all} onClick={() => setAll(!all)}>
            {all ? m.header_search_recent() : m.header_search_history()}
            <ChevronRight aria-hidden="true" className="size-4" />
          </button>
        </div>
        <p className="px-2 text-xs text-muted-foreground">
          {history?.persistence === 'unavailable'
            ? m.shell_account_unavailable()
            : history?.persistence === 'memory'
              ? m.header_search_history_memory()
              : history?.sync === 'pending'
                ? m.header_search_history_pending()
                : m.header_search_history_local()}
        </p>
        {entries.length ? (
          <ul>
            {entries.slice(0, all ? 32 : 5).map((entry) => (
              <li key={entry.id} className="flex items-center gap-1">
                <button
                  type="button"
                  className={`${control} min-w-0 flex-1 text-start`}
                  onClick={() => onSelect?.(entry)}
                >
                  {entry.scope?.image ? (
                    <img alt="" src={entry.scope.image} className="size-9 rounded-full object-cover" />
                  ) : entry.scope ? (
                    <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-full bg-muted">
                      <UserRound className="size-4" />
                    </span>
                  ) : (
                    <Clock aria-hidden="true" className="mx-2 size-5 shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0">
                    <span className="block truncate">{entry.query || entry.scope?.name}</span>
                    {entry.query && entry.scope ? (
                      <span className="block truncate text-xs text-muted-foreground">{entry.scope.name}</span>
                    ) : null}
                  </span>
                </button>
                <button
                  type="button"
                  className={`${control} shrink-0`}
                  aria-label={m.header_search_remove_recent({ name: entry.query || entry.scope?.name || '' })}
                  onClick={() => history?.remove(entry.id)}
                >
                  <X aria-hidden="true" className="size-4" />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-2 py-4 text-sm text-muted-foreground">{m.header_search_recent_empty()}</p>
        )}
      </section>
      )}
      {discovery?.trendingQueries?.length ? (
        <section className="space-y-2 pt-5">
          <h3 className="px-2 text-sm font-semibold">{m.header_search_trending_searches()}</h3>
          {discovery.trendingQueries.slice(0, 8).map((query) => (
            <button
              type="button"
              key={query}
              className={`${control} w-full text-start`}
              onClick={() => onQuery?.(query)}
            >
              <TrendingUp aria-hidden="true" className="size-4" />
              {query}
            </button>
          ))}
        </section>
      ) : null}
      {realms(m.header_search_trending_communities(), discovery?.trendingRealms)}
      {realms(m.header_search_popular_realms(), discovery?.popularRealms)}
    </div>
  );
}
