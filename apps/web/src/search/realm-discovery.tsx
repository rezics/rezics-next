import { useEffect, useReducer, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@rezics/ui/shadcn/button';
import { RealmDiscoverySection, type RealmDiscoverySort, type RealmDiscoveryState } from '../community/realm-discovery';
import { m } from '../paraglide/messages.js';
import { realmDiscoveryQueryOptions, reduceRealmDiscovery, type RealmDiscoveryReader } from './realm-discovery-loader';

/** Search owns request/continuation state; Content owns the only card renderer and GET adapter. */
export function SearchRealmDiscovery({
  initial,
  locale,
  sort = 'popular',
  read,
}: {
  initial: RealmDiscoveryState;
  locale: string;
  sort?: RealmDiscoverySort;
  read?: RealmDiscoveryReader;
}) {
  const client = useQueryClient();
  const [window, dispatch] = useReducer(reduceRealmDiscovery, initial, (state) =>
    reduceRealmDiscovery({ state: { kind: 'loading' }, pending: false, retry: false }, state),
  );
  const active = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => active.current?.abort(), []);
  const { state, pending, retry } = window;

  async function load() {
    if (active.current || state.kind === 'closed' || (state.kind === 'ready' && state.next === null)) return;
    const controller = new AbortController();
    active.current = controller;
    const cursor = state.kind === 'ready' ? (state.next ?? undefined) : undefined;
    dispatch({ kind: 'loading' });
    try {
      const page = await client.fetchQuery(realmDiscoveryQueryOptions(locale, sort, cursor, read));
      if (!controller.signal.aborted) dispatch(page);
    } catch {
      if (!controller.signal.aborted) dispatch({ kind: 'unavailable' });
    } finally {
      if (active.current === controller) active.current = undefined;
    }
  }

  const options = { locale: locale as never };
  return (
    <div className="space-y-3" aria-busy={pending}>
      <RealmDiscoverySection
        sort={sort}
        state={state}
        locale={locale}
        {...(!pending && !retry && state.kind === 'ready' && state.next !== null ? { onNext: load } : {})}
        {...(!pending && retry && state.kind === 'unavailable' ? { onRetry: load } : {})}
      />
      {state.kind === 'ready' && pending && (
        <p role="status" className="text-sm text-muted-foreground">
          {m.discovery_loading({}, options)}
        </p>
      )}
      {state.kind === 'ready' && retry && (
        <div className="space-y-2">
          <p role="status" className="text-sm text-muted-foreground">
            {m.search_failed({}, options)}
          </p>
          <Button type="button" variant="outline" onClick={load}>
            {m.search_facet_retry({}, options)}
          </Button>
        </div>
      )}
    </div>
  );
}
