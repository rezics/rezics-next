import type { ReactNode } from 'react';

/** Places period context beside the timeline on wide screens and before it on phones. */
export function ReadingWorkspace({
  periodContext,
  timeline,
  recovery,
  windowNavigation,
}: {
  periodContext: ReactNode;
  timeline: ReactNode;
  recovery: ReactNode;
  windowNavigation: ReactNode;
}) {
  return (
    <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.75fr)] lg:items-start">
      <div
        data-reading-workspace-slot="period-context"
        className="order-1 min-w-0 space-y-4 lg:col-start-1 lg:row-start-1"
      >
        {periodContext}
      </div>
      <div
        data-reading-workspace-slot="timeline"
        className="order-2 min-w-0 lg:col-start-2 lg:row-start-1"
      >
        {timeline}
      </div>
      <div
        data-reading-workspace-slot="recovery"
        className="order-3 min-w-0 lg:col-start-2 lg:row-start-2"
      >
        {recovery}
      </div>
      <div
        data-reading-workspace-slot="window-navigation"
        className="order-4 min-w-0 lg:col-start-2 lg:row-start-3"
      >
        {windowNavigation}
      </div>
    </div>
  );
}
