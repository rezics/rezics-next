import type { View } from '@rezics/composition';
import { useEffect, useRef } from 'react';
import type { ViewTab } from './views';
import { formatCount } from '../count';
import { subjectUrlForView } from '../../subject/subject-href';
import { contextHref } from './context-navigation';
import { withSubjectVisitReturn } from './subject-visit-navigation';

export type ViewTabLabels = { views: string; names: Record<View, string> };

const barClass = 'sticky top-[var(--shell-header-height,4rem)] z-30 min-w-0 border-b border-border bg-background';
// The inactive color is the muted foreground: the 60% foreground the component defaults to does not clear 4.5:1.
const triggerClass =
  'flex min-h-10 flex-none items-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-3 text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring data-active:border-primary data-active:text-foreground';

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
    const rail = bar.current;
    const current = rail?.querySelector<HTMLElement>('[data-active]');
    if (!rail || !current) return;
    const track = rail.getBoundingClientRect();
    const item = current.getBoundingClientRect();
    if (item.left < track.left || item.right > track.right) {
      rail.scrollBy?.({ left: item.left - track.left - (track.width - item.width) / 2 });
    }
  }, [active]);
  return (
    <nav aria-label={labels.views} data-slot="view-tabs" className={barClass}>
      <div ref={bar} className="overflow-x-auto overscroll-x-contain">
        <ul className="flex w-max min-w-full flex-nowrap justify-start">
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
                  <span
                    data-slot="count"
                    className="rounded-sm bg-muted px-1.5 py-0.5 text-xs leading-none tabular-nums"
                  >
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
