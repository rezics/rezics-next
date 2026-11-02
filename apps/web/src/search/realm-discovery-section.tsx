import { createServerFn } from '@tanstack/react-start';
import { useEffect, useMemo, useRef, useState } from 'react';
import { RealmDiscoverySection, loadRealmDiscovery, type RealmDiscoveryState } from '../community/realm-discovery';
import { type RealmDiscoveryWindow } from './realm-discovery-loader';
import { createRealmPageProgress } from './realm-page-progress';

export type {
  RealmDiscoveryCard,
  RealmDiscoverySectionProps,
  RealmDiscoverySort,
  RealmDiscoveryState,
} from '../community/realm-discovery';
type Page = Exclude<RealmDiscoveryState, { kind: 'loading' }>;

export const REALM_DISCOVERY_LIMIT = 20;
export type SearchRealmDiscoveryRequest = Readonly<{
  locale: string;
  sort: 'trending';
  cursor?: string;
  limit: typeof REALM_DISCOVERY_LIMIT;
}>;
export type SearchRealmDiscoveryLoader = (input: SearchRealmDiscoveryRequest) => Promise<Page>;

const readSearchRealmDiscovery = createServerFn({ method: 'GET' })
  .validator((data: SearchRealmDiscoveryRequest) => ({
    locale: data.locale,
    ...(data.cursor === undefined ? {} : { cursor: data.cursor }),
  }))
  .handler(async ({ data }): Promise<Page> => {
    const { kernelClient } = await import('../kernel/client');
    return loadRealmDiscovery(kernelClient(data.locale), {
      sort: 'trending',
      limit: REALM_DISCOVERY_LIMIT,
      ...(data.cursor === undefined ? {} : { cursor: data.cursor }),
    });
  });
const loadSearchRealmDiscovery: SearchRealmDiscoveryLoader = (data) => readSearchRealmDiscovery({ data });

/** Accumulated public rows, one bounded page per action; disposal fences every late completion. */
export function createSearchRealmDiscoveryPage(
  load: SearchRealmDiscoveryLoader,
  locale: string,
  publish: (state: RealmDiscoveryState, progress: Pick<RealmDiscoveryWindow, 'pending' | 'retry' | 'restart'>) => void,
) {
  const page = createRealmPageProgress({
    read: ({ cursor }) => load({
      locale,
      sort: 'trending',
      limit: REALM_DISCOVERY_LIMIT,
      ...(cursor === undefined ? {} : { cursor }),
    }),
    publish: (window) => publish(window.state, {
      pending: window.pending,
      retry: window.retry,
      restart: window.restart,
    }),
  });
  return {
    start: () => page.start(),
    next: () => page.next(),
    retry: () => page.retry(),
    dispose: () => page.dispose(),
  };
}

/** Mounted only by the existing visible, global, empty-query region. Content owns all successful presentation. */
export function SearchRealmDiscoverySection({
  locale,
  load = loadSearchRealmDiscovery,
}: {
  locale: string;
  load?: SearchRealmDiscoveryLoader | undefined;
}) {
  const [snapshot, setSnapshot] = useState<RealmDiscoveryWindow & { owner: object }>();
  const owner = useMemo(() => ({ locale, load }), [locale, load]);
  const current = useRef<ReturnType<typeof createSearchRealmDiscoveryPage> | null>(null);
  useEffect(() => {
    const page = createSearchRealmDiscoveryPage(owner.load, owner.locale, (state, progress) =>
      setSnapshot({ owner, state, ...progress }),
    );
    current.current = page;
    let active = true;
    // React's development effect replay must not issue a second request for the same visible panel.
    queueMicrotask(() => {
      if (active) void page.start();
    });
    return () => {
      active = false;
      page.dispose();
      if (current.current === page) current.current = null;
    };
  }, [owner]);
  const { state, pending, retry, restart } =
    snapshot?.owner === owner
      ? snapshot
      : { state: { kind: 'loading' as const }, pending: false, retry: false, restart: false };
  return (
    <div data-search-realm-discovery data-state={state.kind}>
      <RealmDiscoverySection
        sort="trending"
        state={state}
        locale={locale}
        pending={pending}
        retry={retry}
        restart={restart}
        {...(state.kind === 'ready' && state.next !== null && !retry
          ? { onNext: () => void current.current?.next() }
          : {})}
        {...(retry ? { onRetry: () => void current.current?.retry() } : {})}
      />
    </div>
  );
}
