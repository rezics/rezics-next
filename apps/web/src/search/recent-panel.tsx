import { recentHistoryDestination } from './recent-replay';
import { locales } from '../paraglide/runtime.js';
import { CurrentTrendingSearches } from './trending-section';
import { ChevronRight, Clock, UserRound, X } from 'lucide-react';
import { useCallback, useState } from 'react';
import { m } from '../paraglide/messages.js';
import type { RecentEntry, RecentHistory } from './recent-history';
import { SearchRealmDiscoverySection, type SearchRealmDiscoveryLoader } from './realm-discovery-section';
import { useHistoryRemovalFocus } from './history-removal-focus';
import { useHistoryRetryFocus } from './history-retry-focus';

export type SearchRealmDiscovery = { id: string; name: string; description: string; href: string; avatar?: string };
/** Legacy caller shape retained for compatibility. Realm arrays cannot establish native discovery authority. */
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
  loadRealmDiscovery,
  onQuery,
  language = 'en',
  global = true,
  query = '',
}: {
  language?: string;
  global?: boolean;
  query?: string;
  history?: RecentHistory | undefined;
  recent?: React.ReactNode;
  onSelect?: ((entry: RecentEntry) => void) | undefined;
  discovery?: SearchDiscovery | undefined;
  loadRealmDiscovery?: SearchRealmDiscoveryLoader | undefined;
  onQuery?: ((query: string) => void) | undefined;
}) {
  const [all, setAll] = useState(false);
  const entries = history?.entries ?? [];
  const visibleEntries = entries.slice(0, all ? 32 : 5);
  const [announcement, setAnnouncement] = useState('');
  const announce = useCallback((message: string) => setAnnouncement(message), []);
  const focusCandidates = entries.slice(0, (all ? 32 : 5) + 1);
  const focus = useHistoryRemovalFocus(entries, focusCandidates, announce, history?.owner);
  const retry = useHistoryRetryFocus(
    focus.regionRef,
    history?.owner,
    history?.sync === 'pending' && !history.failure,
    history?.failure ?? history?.sync,
  );
  const options = { locale: language as never };
  const status =
    history?.failure === 'conflict'
      ? m.search_history_conflict({}, options)
      : history?.failure === 'unavailable'
        ? m.search_history_offline({}, options)
        : history?.persistence === 'unavailable'
          ? m.shell_account_unavailable({}, options)
          : history?.sync === 'pending'
            ? m.header_search_history_pending({}, options)
            : undefined;
  return (
    <div data-search-discovery className="px-2 py-4">
      {recent ?? (
        <section
          ref={focus.regionRef}
          tabIndex={-1}
          aria-label={all ? m.header_search_history({}, options) : m.header_search_recent({}, options)}
          className="space-y-2"
        >
          <div className="flex items-center justify-between gap-2 px-2">
            <h2 className="font-semibold">
              {all ? m.header_search_history({}, options) : m.header_search_recent({}, options)}
            </h2>
            <button type="button" className={control} aria-expanded={all} onClick={() => setAll(!all)}>
              {all ? m.header_search_recent({}, options) : m.header_search_history({}, options)}
              <ChevronRight aria-hidden="true" className="size-4" />
            </button>
          </div>
          {status && <p className="px-2 text-xs text-muted-foreground">{status}</p>}
          {history?.failure && history.retry && (
            <button
              ref={retry.reloadRef}
              type="button"
              className={control}
              onClick={(event) => {
                retry.requestReloadFocus(event.currentTarget);
                history.retry?.();
              }}
            >
              {m.search_history_reload({}, options)}
            </button>
          )}
          {entries.length ? (
            <ul ref={focus.listRef}>
              {visibleEntries.map((entry, index) => {
                const name = entry.query || entry.scope?.name || '';
                const destination = recentHistoryDestination(entry, locales);
                const scoped = Boolean(entry.scope);
                const Tag = scoped && destination ? 'a' : 'button';
                const href = scoped && destination ? `/${language}${destination}` : undefined;
                return (
                  <li key={entry.id} className="flex items-center gap-1">
                    <Tag
                      type={Tag === 'button' ? 'button' : undefined}
                      href={href}
                      disabled={Tag === 'button' && scoped}
                      className={`${control} min-w-0 flex-1 text-start`}
                      onClick={(event) => {
                        if (history?.owner && !history.owner()) {
                          event.preventDefault();
                          return;
                        }
                        if (scoped && destination) history?.remember(entry.query, entry.scope, entry.languages);
                        else if (!scoped) onSelect?.(entry);
                      }}
                    >
                      {entry.scope?.image ? (
                        <img alt="" src={entry.scope.image} className="size-9 rounded-full object-cover" />
                      ) : entry.scope ? (
                        <span
                          aria-hidden="true"
                          className="grid size-9 shrink-0 place-items-center rounded-full bg-muted"
                        >
                          <UserRound className="size-4" />
                        </span>
                      ) : (
                        <Clock aria-hidden="true" className="mx-2 size-5 shrink-0 text-muted-foreground" />
                      )}
                      <span className="min-w-0">
                        <span className="block truncate">
                          {entry.query || entry.scope?.name || m.search_history_unavailable({}, options)}
                        </span>
                        {entry.query && entry.scope ? (
                          <span className="block truncate text-xs text-muted-foreground">
                            {entry.scope.name || m.search_history_unavailable({}, options)}
                          </span>
                        ) : null}
                      </span>
                    </Tag>
                    <button
                      type="button"
                      className={`${control} shrink-0`}
                      aria-label={m.header_search_remove_recent({ name }, options)}
                      data-history-action=""
                      data-history-id={entry.id}
                      onClick={(event) => {
                        focus.requestRemove(
                          entry.id,
                          index,
                          event.currentTarget,
                          m.search_history_management_removed({ name }, options),
                        );
                        history?.remove(entry.id);
                      }}
                    >
                      <X aria-hidden="true" className="size-4" />
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="px-2 py-4 text-sm text-muted-foreground">{m.header_search_recent_empty({}, options)}</p>
          )}
          <p className="sr-only" role="status" aria-live="polite">
            {announcement}
          </p>
        </section>
      )}
      {global ? <CurrentTrendingSearches language={language} onSelect={onQuery} /> : null}
      {global ? (
        <div className="px-2 pt-5">
          <SearchRealmDiscoverySection
            key={JSON.stringify([language, query])}
            locale={language}
            load={loadRealmDiscovery}
          />
        </div>
      ) : null}
    </div>
  );
}
