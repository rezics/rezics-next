import { TrendingUp } from 'lucide-react';
import { useCallback, useContext, useEffect, useLayoutEffect as useBrowserLayoutEffect, useRef } from 'react';
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

const useFocusLayoutEffect = typeof document === 'undefined' ? useEffect : useBrowserLayoutEffect;

function useTrendingRetryFocus(state: TrendingState, isCurrent?: () => boolean) {
  const regionRef = useRef<HTMLElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  const firstTermRef = useRef<HTMLButtonElement>(null);
  const pending = useRef<{
    source: HTMLButtonElement;
    live: () => boolean;
    moved: boolean;
    document: Document;
    onFocusIn: (event: FocusEvent) => void;
  } | null>(null);

  function clear() {
    const request = pending.current;
    if (!request) return;
    request.document.removeEventListener('focusin', request.onFocusIn, true);
    pending.current = null;
  }

  useEffect(() => () => clear(), []);
  useFocusLayoutEffect(() => {
    const request = pending.current;
    if (!request) return;
    if (!request.live()) {
      clear();
      return;
    }
    if (state.status === 'loading') return;
    const { source, moved, document } = request;
    clear();
    if (moved) return;
    const active = document.activeElement;
    if (active !== source && active !== document.body && active !== document.documentElement) return;
    const target = retryRef.current ?? firstTermRef.current ?? regionRef.current;
    if (target?.isConnected) target.focus();
  }, [state]);

  return {
    regionRef,
    retryRef,
    firstTermRef,
    requestRetryFocus(source: HTMLButtonElement) {
      if (source.ownerDocument.activeElement !== source) return;
      const live = isCurrent ?? (() => true);
      if (!live()) return;
      clear();
      const document = source.ownerDocument;
      const request = {
        source,
        live,
        moved: false,
        document,
        onFocusIn(event: FocusEvent) {
          const target = event.target;
          if (target !== source && target !== document.body && target !== document.documentElement)
            request.moved = true;
        },
      };
      document.addEventListener('focusin', request.onFocusIn, true);
      pending.current = request;
    },
  };
}

/** Owner operation rendered in the existing Search frame; shadcn has no discovery-section primitive. */
export function TrendingSearchesSection({
  state,
  onSelect,
  onRetry,
  isCurrent,
  language,
}: {
  state: TrendingState;
  onSelect?: ((query: string) => void) | undefined;
  onRetry?: (() => void) | undefined;
  isCurrent?: (() => boolean) | undefined;
  language?: string;
}) {
  const values = state.status === 'ready' ? state.page.trendingSearches : [];
  const waiting = useSearchRetryWait(state.status === 'ready' ? undefined : state.retryAt);
  const rows = trendingTermRowKeys(values).map((key, index) => ({ key, ...values[index]! }));
  const focus = useTrendingRetryFocus(state, isCurrent);
  const options = language === undefined ? undefined : { locale: language as never };
  return (
    <section
      ref={focus.regionRef}
      tabIndex={-1}
      className="space-y-2 pt-5"
      aria-label={m.header_search_trending_searches({}, options)}
      aria-busy={state.status === 'loading'}
      data-trending-searches
    >
      <h3 className="px-2 text-sm font-semibold">{m.header_search_trending_searches({}, options)}</h3>
      {values.length ? (
        <ul>
          {rows.map(({ key, query, display }, index) => (
            <li key={key}>
              <button
                ref={index === 0 ? focus.firstTermRef : undefined}
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
            ? m.trending_loading({}, options)
            : state.status === 'preparing'
              ? m.discovery_not_ready({}, options)
              : state.status === 'unavailable'
                ? m.trending_unavailable({}, options)
                : m.trending_empty({}, options)}
        </p>
      )}
      {onRetry && state.status !== 'ready' && (
        <>
          {waiting && <p className="px-2 text-sm text-muted-foreground">{m.search_recovery_wait({}, options)}</p>}
          <button
            ref={focus.retryRef}
            type="button"
            className="min-h-11 rounded-xl px-2 text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            disabled={waiting || state.status === 'loading'}
            onClick={(event) => {
              focus.requestRetryFocus(event.currentTarget);
              onRetry();
            }}
          >
            {m.search_facet_retry({}, options)}
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
      language={language}
      state={state}
      onRetry={identity === null ? undefined : retry}
      isCurrent={isCurrent}
      onSelect={(query) => {
        if (isCurrent()) onSelect?.(query);
      }}
    />
  );
}
