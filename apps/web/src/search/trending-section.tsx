import { TrendingUp } from 'lucide-react';
import { m } from '../paraglide/messages.js';
import { useSession } from '../session/query';
import { useTrendingSearches, type TrendingState } from './trending';

/** Owner operation rendered in the existing Search frame; shadcn has no discovery-section primitive. */
export function TrendingSearchesSection({
  state,
  onSelect,
}: {
  state: TrendingState;
  onSelect?: ((query: string) => void) | undefined;
}) {
  const values = state.status === 'ready' ? state.page.trendingSearches : [];
  return (
    <section className="space-y-2 pt-5" aria-label={m.header_search_trending_searches()} data-trending-searches>
      <h3 className="px-2 text-sm font-semibold">{m.header_search_trending_searches()}</h3>
      {values.length ? (
        <ul>
          {values.map(({ query, display }) => (
            <li key={query}>
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
  const identity =
    session.state === 'signed-in' ? (session.subject ?? null) : session.state === 'signed-out' ? 'anonymous' : null;
  const state = useTrendingSearches(language, identity);
  return <TrendingSearchesSection state={state} onSelect={onSelect} />;
}
