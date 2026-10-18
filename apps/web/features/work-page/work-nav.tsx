'use client';

import { Button, buttonVariants } from '@rezics/ui/button';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@rezics/ui/popover';
import { cn } from '@rezics/ui/utils';
import { ChevronDownIcon, StarIcon } from 'lucide-react';
import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import Link from '../shell/localized-link.tsx';
import type { UiLocale } from '../../i18n/define.ts';
import { RateWork } from '../catalogue/reader-actions.tsx';
import { ACTION_ATTRIBUTE, ACTION_ID } from './hub.ts';
import { scopeAt, tabOf, type WorkAt, workHref, workNavigationQuery, type WorkTab, workTabs } from './route.ts';

/** The existing rating editor, one quiet step from the identity instead of a second primary panel. */
export function WorkRating({ work, locale, label }: { work: string; locale: UiLocale; label: string }) {
  return <Popover modal={false} positioning={{ placement: 'bottom-end' }}>
    <PopoverTrigger asChild><Button type="button" variant="ghost" size="sm" className="min-h-11">
      <StarIcon aria-hidden="true" />{label}</Button></PopoverTrigger>
    <PopoverContent className="max-w-[calc(100vw-2rem)] p-4">
      <PopoverTitle className="sr-only">{label}</PopoverTitle>
      <RateWork work={work} locale={locale} />
    </PopoverContent>
  </Popover>;
}

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
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const pathname = usePathname();
  const params = useSearchParams();
  const search = params.toString();
  const current = tabOf(pathname, workRef);
  const scope = scopeAt(workRef, Object.fromEntries(params));
  const query = workNavigationQuery(params);
  const overview = workHref(workRef, 'overview', scope, query);
  useEffect(() => { setOpen(false); }, [pathname, search]);
  useEffect(() => {
    if (!open) return;
    const dismiss = () => setOpen(false);
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) dismiss();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      dismiss();
      trigger.current?.focus();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    window.addEventListener('popstate', dismiss);
    window.addEventListener('hashchange', dismiss);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
      window.removeEventListener('popstate', dismiss);
      window.removeEventListener('hashchange', dismiss);
    };
  }, [open]);
  const item = 'flex min-h-11 items-center rounded-lg px-3 text-sm outline-none hover:bg-accent '
    + 'focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:font-semibold aria-[current=page]:text-primary';
  return <div ref={root} className="relative sm:hidden" onBlur={event => {
    if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }}>
    <button ref={trigger} type="button" aria-expanded={open} aria-controls={menu} onClick={() => setOpen(value => !value)}
      className={cn(buttonVariants({ variant: 'outline', size: 'md', pill: true }), 'w-full justify-between')}>
      {label}<ChevronDownIcon aria-hidden="true" className={cn('transition-transform', open && 'rotate-180')} />
    </button>
    {open ? <nav id={menu} aria-label={label} className="absolute inset-x-0 top-full z-20 mt-1 grid max-h-[70vh]
      gap-1 overflow-y-auto rounded-2xl border border-border bg-popover p-2 shadow-lg">
      {sections.length ? <>
      <p className="px-3 pt-1 text-muted-foreground text-xs">{label}</p>
      <ul>
        {sections.map(section => <li key={section.id}>
          <Link href={`${overview}#${section.id}`} className={item} onClick={() => {
            setOpen(false);
            trigger.current?.focus();
            if (current !== 'overview') return;
            requestAnimationFrame(() => {
              const destination = document.getElementById(section.id);
              if (!destination) return;
              if (!destination.hasAttribute('tabindex')) destination.tabIndex = -1;
              destination.focus({ preventScroll: true });
            });
          }}>{section.label}</Link>
        </li>)}
      </ul></> : null}
      <p className="px-3 pt-1 text-muted-foreground text-xs">{viewsLabel}</p>
      <ul>
        {workTabs.map(tab => <li key={tab}>
          <Link href={workHref(workRef, tab, scope, query)} aria-current={tab === current ? 'page' : undefined}
            className={item} onClick={() => { setOpen(false); trigger.current?.focus(); }}>{labels[tab]}</Link>
        </li>)}
      </ul>
    </nav> : null}
  </div>;
}

/**
 * The primary action again, at the foot of a phone's screen, once the original has scrolled away. It copies the
 * existing link or invokes its existing button, so the original action keeps its state and behavior.
 */
export function StickyAction({ label }: { label: string }) {
  const [action, setAction] = useState<({ href: string } | { button: HTMLButtonElement; disabled: boolean }) & { text: string } | null>(null);
  useEffect(() => {
    const target = document.getElementById(ACTION_ID);
    if (!target || typeof IntersectionObserver === 'undefined') return;
    let gone = false;
    const update = () => {
      const marker = target.querySelector<HTMLElement>(`[${ACTION_ATTRIBUTE}]`);
      const control = marker?.matches('a, button') ? marker : marker?.querySelector('a, button');
      if (!gone || !control) return setAction(null);
      const text = control.textContent?.trim() ?? '';
      setAction(control instanceof HTMLAnchorElement ? { href: control.getAttribute('href') ?? '#', text }
        : control instanceof HTMLButtonElement ? { button: control, disabled: control.disabled, text } : null);
    };
    const observer = new IntersectionObserver(([entry]) => {
      gone = Boolean(entry && !entry.isIntersecting && entry.boundingClientRect.bottom < 0);
      update();
    });
    const mutations = new MutationObserver(update);
    mutations.observe(target, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['disabled', 'href'] });
    observer.observe(target);
    return () => { observer.disconnect(); mutations.disconnect(); };
  }, []);
  if (!action?.text) return null;
  return <div role="region" aria-label={label} className="fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-30
    border-border/60 border-t bg-background/95 p-3 backdrop-blur md:bottom-0 lg:hidden">
    {'href' in action ? <a href={action.href} className={cn(buttonVariants({ size: 'lg', pill: true }), 'w-full')}>{action.text}</a>
      : <Button type="button" size="lg" pill className="w-full" disabled={action.disabled}
        onClick={() => action.button.click()}>{action.text}</Button>}
  </div>;
}
