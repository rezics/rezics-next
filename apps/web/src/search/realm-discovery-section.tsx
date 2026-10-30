import type { KernelClient } from '@rezics/client';
import { createServerFn } from '@tanstack/react-start';
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { isPlatformClosedError } from '../kernel/platform-closed';
import { m } from '../paraglide/messages.js';
import type { RealmPresentationImage } from '../threads/board-community-source';

// Consumer declarations until Content delivers community/realm-discovery/index.ts. Replace this boundary
// with that module's actual exports; do not implement a Realm renderer or GET adapter here.
export type RealmDiscoverySort = 'popular' | 'trending';
export type RealmDiscoveryCard = Readonly<{
  realmId: string;
  spaceId: string;
  name: string;
  description: string;
  avatar: RealmPresentationImage | null;
}>;
export type RealmDiscoveryState =
  | Readonly<{ kind: 'loading' }>
  | Readonly<{
      kind: 'ready';
      realms: readonly RealmDiscoveryCard[];
      next: string | null;
    }>
  | Readonly<{ kind: 'unavailable' | 'closed' }>;
type Page = Exclude<RealmDiscoveryState, { kind: 'loading' }>;
export type RealmDiscoverySectionProps = Readonly<{
  sort: RealmDiscoverySort;
  state: RealmDiscoveryState;
  locale: string;
  onNext?: () => void;
  onRetry?: () => void;
}>;
type Producer = {
  RealmDiscoverySection(props: RealmDiscoverySectionProps): ReactElement;
  loadRealmDiscovery(
    client: KernelClient,
    input: Readonly<{ sort: RealmDiscoverySort; cursor?: string; limit?: number }>,
  ): Promise<Page>;
};
function realmDiscoveryProducer(): Producer | null {
  return null;
}

/** An absent producer is unavailable, including when a story supplies a successful interface response. */
function UnavailableRealmDiscovery({ state, onRetry }: RealmDiscoverySectionProps) {
  return (
    <section data-realm-discovery-producer="unavailable" className="space-y-2 px-2 pt-5">
      <p role="status" className="text-sm text-muted-foreground">
        {state.kind === 'loading'
          ? m.candidate_loading()
          : state.kind === 'closed'
            ? m.platform_closed_message()
            : m.realm_shelf_unavailable()}
      </p>
      {state.kind !== 'loading' && state.kind !== 'closed' && onRetry ? (
        <button
          type="button"
          className="min-h-11 rounded-xl px-2 text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onRetry}
        >
          {m.search_facet_retry()}
        </button>
      ) : null}
    </section>
  );
}

export const REALM_DISCOVERY_LIMIT = 20;
export type SearchRealmDiscoveryRequest = Readonly<{
  locale: string;
  sort: 'trending';
  cursor?: string;
  limit: typeof REALM_DISCOVERY_LIMIT;
}>;
export type SearchRealmDiscoveryLoader = (input: SearchRealmDiscoveryRequest) => Promise<Page>;

const readSearchRealmDiscovery = createServerFn({ method: 'GET' })
  .inputValidator((data: SearchRealmDiscoveryRequest) => ({
    locale: data.locale,
    ...(data.cursor === undefined ? {} : { cursor: data.cursor }),
  }))
  .handler(async ({ data }): Promise<Page> => {
    const producer = realmDiscoveryProducer();
    if (!producer) return { kind: 'unavailable' };
    const { kernelClient } = await import('../kernel/client');
    return producer.loadRealmDiscovery(kernelClient(data.locale), {
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
  const Section = realmDiscoveryProducer()?.RealmDiscoverySection ?? UnavailableRealmDiscovery;
  return (
    <div data-search-realm-discovery data-state={state.kind}>
      <Section
        sort="trending"
        state={state}
        locale={locale}
        {...(state.kind === 'ready' && state.next !== null ? { onNext: () => void current.current?.next() } : {})}
        {...(state.kind === 'unavailable' ? { onRetry: () => void current.current?.retry() } : {})}
      />
    </div>
  );
}
