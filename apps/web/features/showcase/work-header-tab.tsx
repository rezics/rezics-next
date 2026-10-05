'use client';

import { usePathname } from 'next/navigation';
import type { ComponentProps, ReactNode } from 'react';
import { tabOf, type WorkAt } from '../work-page/route.ts';

/** The Work layout wraps every tab and persists between them, so the tab is read from the URL on the client. */
export const useOverviewTab = (workRef: WorkAt) => tabOf(usePathname(), workRef) === 'overview';

/** The art header shows on the Overview, as store pages open with it; the other tabs keep the compact header. */
export function OverviewOnly({ workRef, children }: { workRef: WorkAt; children: ReactNode }) {
  return useOverviewTab(workRef) ? children : null;
}

export function HiddenOnOverview({ workRef, children }: { workRef: WorkAt; children: ReactNode }) {
  return useOverviewTab(workRef) ? null : children;
}

/** The grid marks itself while art opens the page, so its cells can place themselves around it. */
export function ArtGrid({ workRef, ...props }: ComponentProps<'div'> & { workRef: WorkAt }) {
  return <div {...props} data-art={useOverviewTab(workRef) ? '' : undefined} />;
}
