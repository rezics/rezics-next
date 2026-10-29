import type { View } from '@rezics/composition';
import { Tabs, TabsList, TabsTrigger } from '@rezics/ui/shadcn/tabs';
import { useEffect, useRef } from 'react';
import type { ViewTab } from './views';
import { formatCount } from '../count';

export type ViewTabLabels = { views: string; names: Record<View, string> };

const barClass = 'sticky top-16 z-30 -mx-6 border-b border-border/60 bg-background/90 px-6 backdrop-blur';
// The inactive color is the muted foreground: the 60% foreground the component defaults to does not clear 4.5:1.
const triggerClass = 'h-11 flex-none px-3 text-muted-foreground data-active:text-foreground';

/**
 * The views a subject page offers, as links styled as tabs. The bar stays in view under the top bar, scrolls
 * sideways on a narrow screen instead of wrapping, and brings the active view into sight once the page hydrates.
 */
export function ViewTabs({
  tabs,
  active,
  locale,
  base,
  labels,
}: {
  tabs: readonly ViewTab[];
  active: View;
  locale: string;
  /** The overview's address; a view lives under it. */
  base: string;
  labels: ViewTabLabels;
}) {
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const current = bar.current?.querySelector<HTMLElement>('[data-active]');
    current?.scrollIntoView?.({ block: 'nearest', inline: 'center' });
  }, [active]);
  return (
    <nav aria-label={labels.views} data-slot="view-tabs" className={barClass}>
      <div ref={bar} className="overflow-x-auto overscroll-x-contain">
        <Tabs value={active} className="w-max min-w-full">
          <TabsList variant="line" className="h-11 w-max flex-nowrap justify-start">
            {tabs.map(({ view, count }) => (
              <TabsTrigger
                key={view}
                value={view}
                nativeButton={false}
                className={triggerClass}
                data-view={view}
                aria-current={view === active ? 'page' : undefined}
                render={<a href={view === 'overview' ? base : `${base}/${view}`} />}
              >
                {labels.names[view]}
                {count && (
                  <span data-slot="count" className="text-xs tabular-nums">
                    {formatCount(count, locale)}
                  </span>
                )}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>
    </nav>
  );
}
