import type { View } from '@rezics/composition';
import { useEffect, useRef } from 'react';
import type { ViewTab } from './views';
import { formatCount } from '../count';
import { subjectUrlForView } from '../../subject/subject-href';
import { contextHref } from './context-navigation';
import { withSubjectVisitReturn } from './subject-visit-navigation';

export type ViewTabLabels = { views: string; names: Record<View, string> };

const barClass = 'sticky top-16 z-30 -mx-6 border-b border-border/60 bg-background/90 px-6 backdrop-blur';
// The inactive color is the muted foreground: the 60% foreground the component defaults to does not clear 4.5:1.
const triggerClass =
  'flex h-11 flex-none items-center gap-2 whitespace-nowrap border-b-2 border-transparent px-3 text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring data-active:border-primary data-active:text-foreground';

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
  realm,
  returnTo,
}: {
  tabs: readonly ViewTab[];
  active: View;
  locale: string;
  /** The overview's address; a view lives under it. */
  base: string;
  labels: ViewTabLabels;
  realm?: string | undefined;
  returnTo?: string | undefined;
}) {
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const current = bar.current?.querySelector<HTMLElement>('[data-active]');
    current?.scrollIntoView?.({ block: 'nearest', inline: 'center' });
  }, [active]);
  return (
    <nav aria-label={labels.views} data-slot="view-tabs" className={barClass}>
      <div ref={bar} className="overflow-x-auto overscroll-x-contain">
        <ul className="flex h-11 w-max min-w-full flex-nowrap justify-start">
          {tabs.map(({ view, count }) => (
            <li key={view} className="flex-none">
              <a
                className={triggerClass}
                data-view={view}
                data-active={view === active ? '' : undefined}
                aria-current={view === active ? 'page' : undefined}
                href={withSubjectVisitReturn(
                  contextHref(subjectUrlForView({ href: base }, view), realm),
                  returnTo ?? '',
                  locale,
                )}
              >
                {labels.names[view]}
                {count && (
                  <span data-slot="count" className="text-xs tabular-nums">
                    {formatCount(count, locale)}
                  </span>
                )}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}
