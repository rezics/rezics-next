import { TrendingUp } from 'lucide-react';
import { useCallback, useContext } from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import { m } from '../paraglide/messages.js';
import { AnonymousSessionContext, useSession } from '../session/query';
import { useTrendingSearches, type TrendingState } from './trending';
import { headerSearchSessionKey, observeHeaderSearchSession } from './header-search/session-key';
import { useSearchRetryWait } from './search-recovery-retry';

/** Occurrence of delivered query/display; object allocation does not change identity. Native query is the quoted display. */
export function trendingTermRowKeys(terms: readonly { query: string; display: string }[]): string[] {
  const occurrences = new Map<string, number>();
  return terms.map(({ query, display }) => {
    const identity = JSON.stringify([query, display]);
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    return JSON.stringify([query, display, occurrence]);
  });
}

/** Owner operation rendered in the existing Search frame; shadcn has no discovery-section primitive. */
export function TrendingSearchesSection({
  state,
  onSelect,
  onRetry,
}: {
  state: TrendingState;
  onSelect?: ((query: string) => void) | undefined;
  onRetry?: (() => void) | undefined;
}) {
  const values = state.status === 'ready' ? state.page.trendingSearches : [];
  const waiting = useSearchRetryWait(state.status === 'ready' ? undefined : state.retryAt);
  const rows = trendingTermRowKeys(values).map((key, index) => ({ key, ...values[index]! }));
  return (
    <section
      className="space-y-2 pt-5"
      aria-label={m.header_search_trending_searches()}
      aria-busy={state.status === 'loading'}
      data-trending-searches
    >
      <h3 className="px-2 text-sm font-semibold">{m.header_search_trending_searches()}</h3>
      {values.length ? (
        <ul>
          {rows.map(({ key, query, display }) => (
            <li key={key}>
              <button
                type="button"
                className="flex min-h-11 w-full items-center gap-3 rounded-xl px-2 text-start text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => onSelect?.(query)}
              >
                <TrendingUp aria-hidden="true" className="size-4 shrink-0" />
                <span>{display}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p role="status" className="px-2 py-3 text-sm text-muted-foreground">
          {state.status === 'loading'
            ? m.trending_loading()
            : state.status === 'preparing'
              ? m.discovery_not_ready()
              : state.status === 'unavailable'
                ? m.trending_unavailable()
                : m.trending_empty()}
        </p>
      )}
      {onRetry && state.status !== 'ready' && (
        <>
          {waiting && <p className="px-2 text-sm text-muted-foreground">{m.search_recovery_wait()}</p>}
          <button
            type="button"
            className="min-h-11 rounded-xl px-2 text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            disabled={waiting || state.status === 'loading'}
            onClick={onRetry}
          >
            {m.search_facet_retry()}
          </button>
        </>
      )}
    </section>
  );
}
export function CurrentTrendingSearches({
  language,
  onSelect,
}: {
  language: string;
  onSelect?: ((query: string) => void) | undefined;
}) {
  const session = useSession();
  const client = useContext(QueryClientContext);
  const anonymous = useContext(AnonymousSessionContext);
  const observe = useCallback(
    (retire: () => void) => (anonymous || !client ? () => {} : observeHeaderSearchSession(client, retire)),
    [anonymous, client],
  );
  const identity = headerSearchSessionKey(session);
  const { state, retry, isCurrent } = useTrendingSearches(language, identity, observe);
  return (
    <TrendingSearchesSection
      state={state}
      onRetry={identity === null ? undefined : retry}
      onSelect={(query) => {
        if (isCurrent()) onSelect?.(query);
      }}
    />
  );
}
