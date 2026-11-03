import { useRouter, useRouterState } from '@tanstack/react-router';
import { m } from '../paraglide/messages.js';

export type PendingLayout = 'page' | 'feed' | 'detail' | 'form';

/** Explicit rebuilt route IDs. Unknown routes retain neutral page loading. */
const layouts: Readonly<Record<string, PendingLayout>> = {
  '/': 'feed', '/search': 'feed', '/boards/': 'feed', '/library/': 'feed', '/collections/': 'feed',
  '/subjects/$id_/$slug': 'detail', '/subjects/$id_/$slug_/$view': 'detail',
  '/threads/$id_/$slug': 'detail',
  '/subjects/$id': 'detail', '/offers/$id': 'detail', '/threads/$id': 'detail', '/threads/$id/$slug': 'detail',
  '/boards/$id': 'feed', '/collections/$id': 'feed',
  '/catalogue/new': 'form', '/contexts/new': 'form', '/collections/new': 'form', '/boards/$id/new': 'form',
};

export function pendingLayout(matches: readonly { routeId: string }[]): PendingLayout {
  for (let index = matches.length - 1; index >= 0; index--) {
    const match = matches[index]!;
    const layout = layouts[match.routeId];
    if (layout === 'page' || layout === 'feed' || layout === 'detail' || layout === 'form') return layout;
  }
  return 'page';
}

const block = 'rounded-lg bg-muted motion-safe:animate-pulse motion-reduce:animate-none';

/** A fixed decorative shape, independent of underlying result size or retired loader data. */
export function RouteLoading({ layout = 'page' }: { layout?: PendingLayout }) {
  const label = layout === 'feed' ? m.route_loading_feed() : layout === 'detail' ? m.route_loading_detail()
    : layout === 'form' ? m.route_loading_form() : m.route_loading_page();
  return (
    <section role="region" aria-busy="true" aria-label={label} data-route-pending={layout} className="mx-auto w-full min-w-0 space-y-6 py-4 md:py-8">
      <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">{label}</h1>
      <p role="status" className="text-sm text-muted-foreground">{m.route_loading_description()}</p>
      <div aria-hidden="true" className="space-y-6" data-slot="route-skeleton">
        <div data-skeleton-block className={`${block} h-5 w-2/3 max-w-96`} />
        {layout === 'feed' ? <div className="grid gap-4 md:grid-cols-2">
          {[0, 1, 2, 3].map((row) => <div key={row} data-skeleton-block className={`${block} flex h-32 gap-4 border border-border p-4 md:h-40`}>
            <div className="w-16 shrink-0 rounded bg-background/70 md:w-20" />
            <div className="flex flex-1 flex-col justify-center gap-3">
              <div className="h-4 w-3/4 rounded bg-background/70" /><div className="h-3 w-full rounded bg-background/70" />
            </div>
          </div>)}
        </div> : layout === 'detail' ? <div className="grid gap-6 sm:grid-cols-[minmax(7rem,1fr)_3fr]">
          <div data-skeleton-block className={`${block} aspect-3/4 w-28 sm:w-full sm:max-w-52`} />
          <div className="space-y-4 py-2">
            {[0, 1, 2, 3].map((row) => <div key={row} data-skeleton-block className={`${block} h-5 ${row === 3 ? 'w-2/3' : 'w-full'}`} />)}
            <div data-skeleton-block className={`${block} mt-8 h-32 w-full`} />
          </div>
        </div> : layout === 'form' ? <div className="max-w-2xl space-y-6">
          {[0, 1, 2].map((row) => <div key={row} className="space-y-2">
            <div data-skeleton-block className={`${block} h-4 w-24`} />
            <div data-skeleton-block className={`${block} ${row === 2 ? 'h-32' : 'h-11'} w-full`} />
          </div>)}
          <div data-skeleton-block className={`${block} h-11 w-32`} />
        </div> : <div className="max-w-3xl space-y-4">
          <div data-skeleton-block className={`${block} h-5 w-full`} />
          <div data-skeleton-block className={`${block} h-5 w-4/5`} />
          <div data-skeleton-block className={`${block} mt-8 h-48 w-full`} />
        </div>}
      </div>
    </section>
  );
}

function RouterPendingPage() {
  const layout = useRouterState({ select: (state) => pendingLayout(state.matches) });
  return <RouteLoading layout={layout} />;
}

export function PendingPage() {
  const router = useRouter({ warn: false });
  return router ? <RouterPendingPage /> : <RouteLoading />;
}
