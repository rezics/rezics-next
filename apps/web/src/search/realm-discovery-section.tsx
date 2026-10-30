import { createServerFn } from '@tanstack/react-start';
import { useEffect, useMemo, useRef, useState } from 'react';
import { RealmDiscoverySection, loadRealmDiscovery, type RealmDiscoveryState } from '../community/realm-discovery';
import { isPlatformClosedError } from '../kernel/platform-closed';

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

/** One visible page, one request per action; disposal fences every late completion. */
export function createSearchRealmDiscoveryPage(
  load: SearchRealmDiscoveryLoader,
  locale: string,
  publish: (state: RealmDiscoveryState) => void,
) {
  let state: RealmDiscoveryState = { kind: 'loading' };
  let cursor: string | undefined;
  let pending = false;
  let disposed = false;
  let started = false;
  const request = async (nextCursor?: string) => {
    if (disposed || pending) return;
    pending = true;
    cursor = nextCursor;
    publish((state = { kind: 'loading' }));
    let page: Page;
    try {
      page = await load({
        locale,
        sort: 'trending',
        limit: REALM_DISCOVERY_LIMIT,
        ...(cursor === undefined ? {} : { cursor }),
      });
    } catch (error) {
      page = { kind: isPlatformClosedError(error) ? 'closed' : 'unavailable' };
    }
    if (disposed) return;
    pending = false;
    publish((state = page));
  };
  return {
    start() {
      if (started) return;
      started = true;
      return request();
    },
    next() {
      if (state.kind === 'ready' && state.next !== null) return request(state.next);
    },
    retry() {
      if (state.kind === 'unavailable') return request(cursor);
    },
    dispose() {
      disposed = true;
    },
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
  const [snapshot, setSnapshot] = useState<{ owner: object; state: RealmDiscoveryState }>();
  const owner = useMemo(() => ({ locale, load }), [locale, load]);
  const current = useRef<ReturnType<typeof createSearchRealmDiscoveryPage> | null>(null);
  useEffect(() => {
    const page = createSearchRealmDiscoveryPage(owner.load, owner.locale, (state) => setSnapshot({ owner, state }));
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
  const state = snapshot?.owner === owner ? snapshot.state : { kind: 'loading' as const };
  return (
    <div data-search-realm-discovery data-state={state.kind}>
      <RealmDiscoverySection
        sort="trending"
        state={state}
        locale={locale}
        {...(state.kind === 'ready' && state.next !== null ? { onNext: () => void current.current?.next() } : {})}
        {...(state.kind === 'unavailable' ? { onRetry: () => void current.current?.retry() } : {})}
      />
    </div>
  );
}
