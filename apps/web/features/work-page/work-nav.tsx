'use client';

import { buttonVariants } from '@rezics/ui/button';
import { cn } from '@rezics/ui/utils';
import { ChevronDownIcon } from 'lucide-react';
import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useId, useState } from 'react';
import Link from '../shell/localized-link.tsx';
import { ACTION_ATTRIBUTE, ACTION_ID } from './hub.ts';
import { scopeAt, tabOf, type WorkAt, workHref, type WorkTab, workTabs } from './route.ts';

/**
 * "On this page" for phones, where tabs would overflow: the overview's sections by their stable anchors, then
 * the Work's other views. Wider screens keep the tabs.
 */
export function OnThisPage({ workRef, label, sections, labels, viewsLabel }: {
  workRef: WorkAt; label: string; sections: readonly { id: string; label: string }[];
  labels: Record<WorkTab, string>; viewsLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const menu = useId();
  const current = tabOf(usePathname(), workRef);
  const scope = scopeAt(workRef, Object.fromEntries(useSearchParams()));
  const overview = workHref(workRef, 'overview', scope);
  const item = 'flex min-h-11 items-center rounded-lg px-3 text-sm outline-none hover:bg-accent '
    + 'focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:font-semibold aria-[current=page]:text-primary';
  return <div className="relative sm:hidden">
    <button type="button" aria-expanded={open} aria-controls={menu} onClick={() => setOpen(value => !value)}
      className={cn(buttonVariants({ variant: 'outline', size: 'md', pill: true }), 'w-full justify-between')}>
      {label}<ChevronDownIcon aria-hidden="true" className={cn('transition-transform', open && 'rotate-180')} />
    </button>
    {open ? <nav id={menu} aria-label={label} className="absolute inset-x-0 top-full z-20 mt-1 grid max-h-[70vh]
      gap-1 overflow-y-auto rounded-2xl border border-border bg-popover p-2 shadow-lg">
      <ul>
        {sections.map(section => <li key={section.id}>
          <Link href={`${overview}#${section.id}`} className={item} onClick={() => setOpen(false)}>{section.label}</Link>
        </li>)}
      </ul>
      <p className="px-3 pt-1 text-muted-foreground text-xs">{viewsLabel}</p>
      <ul>
        {workTabs.filter(tab => tab !== 'overview').map(tab => <li key={tab}>
          <Link href={workHref(workRef, tab, scope)} aria-current={tab === current ? 'page' : undefined}
            className={item}>{labels[tab]}</Link>
        </li>)}
      </ul>
    </nav> : null}
  </div>;
}

/**
 * The primary action again, at the foot of a phone's screen, once the original has scrolled away. It copies the
 * action's link rather than owning one, so Main's answer stays the only place the action is decided.
 */
export function StickyAction({ label }: { label: string }) {
  const [action, setAction] = useState<{ href: string; text: string } | null>(null);
  useEffect(() => {
    const target = document.getElementById(ACTION_ID);
    if (!target || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) => {
      const link = target.querySelector<HTMLAnchorElement>(`a[${ACTION_ATTRIBUTE}]`);
      const gone = Boolean(entry && !entry.isIntersecting && entry.boundingClientRect.bottom < 0);
      setAction(gone && link ? { href: link.getAttribute('href') ?? '#', text: link.textContent?.trim() ?? '' } : null);
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, []);
  if (!action?.text) return null;
  return <div role="region" aria-label={label} className="fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-30
    border-border/60 border-t bg-background/95 p-3 backdrop-blur md:bottom-0 lg:hidden">
    <a href={action.href} className={cn(buttonVariants({ size: 'lg', pill: true }), 'w-full')}>{action.text}</a>
  </div>;
}
