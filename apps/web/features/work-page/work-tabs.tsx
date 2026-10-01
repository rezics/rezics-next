'use client';

import { cn } from '@rezics/ui/utils';
import Link from '../shell/localized-link.tsx';
import { usePathname, useSearchParams } from 'next/navigation';
import { scopeAt, tabOf, type WorkAt, workHref, type WorkTab, workTabs } from './route.ts';

/**
 * The Work's views as links, so each has its own URL and history entry. The
 * chosen scope travels with them, so a Realm reader stays in their Realm.
 */
export function WorkTabs({ workRef, labels, label }: {
  workRef: WorkAt; labels: Record<WorkTab, string>; label: string;
}) {
  const current = tabOf(usePathname(), workRef);
  const scope = scopeAt(workRef, Object.fromEntries(useSearchParams()));
  return <nav aria-label={label} className="hidden overflow-x-auto sm:block">
    <ul className="flex w-max min-w-full gap-1 border-border/70 border-b">
      {workTabs.map(tab => <li key={tab}>
        <Link href={workHref(workRef, tab, scope)}
          aria-current={tab === current ? 'page' : undefined}
          className={cn('relative flex h-11 items-center whitespace-nowrap rounded-t-lg px-3 font-medium text-sm',
            'text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground',
            'focus-visible:ring-2 focus-visible:ring-ring',
            'aria-[current=page]:text-primary aria-[current=page]:after:absolute aria-[current=page]:after:inset-x-2',
            'aria-[current=page]:after:-bottom-px aria-[current=page]:after:h-0.5 aria-[current=page]:after:rounded-full',
            'aria-[current=page]:after:bg-primary')}>
          {labels[tab]}</Link>
      </li>)}
    </ul>
  </nav>;
}
