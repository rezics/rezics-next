'use client';

import { cn, scrollBehavior } from '@rezics/ui/utils';
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { type CatalogueWork, slotRatio } from '../catalogue/work.ts';
import { WorkTile } from '../catalogue/work-tile.tsx';
import { messages } from './messages.ts';

/** Where a row of equal cards stands: pages of whole cards, the one in view and whether an edge is reached. */
export interface Paging { page: number; pages: number; perPage: number; start: boolean; end: boolean }

/**
 * A row's paging from its measurements. A page is as many whole cards as fit
 * (`stride` is a card and the gap after it); the last page may hold fewer,
 * and a row scrolled to its end is on it.
 */
export function pagingOf({ offset, width, scrollWidth, stride, gap, count }: {
  offset: number; width: number; scrollWidth: number; stride: number; gap: number; count: number;
}): Paging {
  // Before layout (or hidden) nothing is measured: one page, as the server renders it.
  if (width <= 0 || stride <= 0) return { page: 0, pages: 1, perPage: Math.max(1, count), start: true, end: true };
  const perPage = Math.max(1, Math.floor((width + gap + 1) / stride));
  const pages = Math.max(1, Math.ceil(count / perPage));
  const start = offset < 4;
  const end = offset + width >= scrollWidth - 4;
  const page = end ? pages - 1 : Math.min(pages - 1, Math.round(offset / (perPage * stride)));
  return { page, pages, perPage, start, end };
}

const arrow = cn('absolute top-[38%] z-30 hidden size-11 -translate-y-1/2 place-items-center rounded-full',
  'border border-border/60 bg-background text-foreground shadow-[0_4px_14px_rgb(0_0_0/0.16)] outline-none',
  'transition-opacity hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none',
  // Arrows only where a pointer needs them and the page margin can hold them; touch screens swipe.
  'disabled:opacity-0 sm:pointer-fine:grid');

/**
 * Goodreads' "Readers also enjoyed": four large covers to a page on a wide
 * screen, each with its title, authors and "★ 4.26 · 41.9K", paged by a
 * round arrow and the dots above. Phones swipe, with the next cover peeking
 * in; the dots follow along. Every title is a link in the tab order, and a
 * focused one scrolls into view.
 */
export function AlsoEnjoyedRow({ id, title, works, avatarQuery, locale }: {
  /** The heading's id, unique on the page. */
  id: string; title: string; works: readonly CatalogueWork[]; avatarQuery?: string; locale: UiLocale;
}) {
  const t = materializeData(messages[locale], { locale });
  const list = useRef<HTMLUListElement>(null);
  const [paging, setPaging] = useState<Paging>({ page: 0, pages: 1, perPage: 1, start: true, end: true });
  const stride = useCallback((element: HTMLUListElement) => {
    const gap = Number.parseFloat(getComputedStyle(element).columnGap) || 0;
    return { gap, stride: ((element.firstElementChild as HTMLElement | null)?.offsetWidth ?? 0) + gap };
  }, []);
  const measure = useCallback(() => {
    const element = list.current;
    if (!element) return;
    // scrollLeft runs negative in right-to-left layouts.
    setPaging(pagingOf({ offset: Math.abs(element.scrollLeft), width: element.clientWidth,
      scrollWidth: element.scrollWidth, ...stride(element), count: works.length }));
  }, [stride, works.length]);
  useEffect(() => {
    measure();
    const element = list.current;
    if (!element) return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [measure]);
  const show = (page: number) => {
    const element = list.current;
    if (!element) return;
    const direction = getComputedStyle(element).direction === 'rtl' ? -1 : 1;
    const left = Math.min(page * paging.perPage * stride(element).stride, element.scrollWidth - element.clientWidth);
    element.scrollTo({ left: direction * Math.max(0, left), behavior: scrollBehavior() });
  };
  const slot = slotRatio(works);
  return <section aria-labelledby={id} className="grid min-w-0 grid-cols-1 gap-4">
    <header className="flex items-center justify-between gap-4">
      <h2 id={id} className="text-balance font-semibold text-xl tracking-tight">{title}</h2>
      {paging.pages > 1 ? <div className="-me-1.5 flex shrink-0 items-center">
        {Array.from({ length: paging.pages }, (_, page) => <button key={page} type="button" onClick={() => show(page)}
          aria-label={t.pageOf({ page: String(page + 1), pages: String(paging.pages) })}
          aria-current={page === paging.page ? 'true' : undefined}
          className="group/dot grid size-6 place-items-center rounded-sm outline-none focus-visible:ring-2
            focus-visible:ring-ring">
          <span className={cn('h-1 w-3.5 rounded-full transition-colors', page === paging.page ? 'bg-foreground'
            : 'bg-border group-hover/dot:bg-muted-foreground')} />
        </button>)}
      </div> : null}
    </header>
    <div className="relative min-w-0">
      {/* min-w-0 keeps the row's scroll width from widening the page's grid. */}
      <ul ref={list} onScroll={measure} className="-mx-4 flex snap-x snap-mandatory scroll-px-4 gap-x-4 overflow-x-auto
        px-4 pt-1 pb-2 scrollbar-none sm:-mx-1 sm:scroll-px-1 sm:gap-x-6 sm:px-1">
        {works.map(work => <li key={work.id} className="w-[42%] shrink-0 snap-start sm:w-[calc((100%-2*1.5rem)/3.35)]
          lg:w-[calc((100%-3*1.5rem)/4)]">
          <WorkTile work={work} slot={slot} avatarQuery={avatarQuery} locale={locale} />
        </li>)}
      </ul>
      <button type="button" aria-label={t.previousPage} onClick={() => show(paging.page - 1)} disabled={paging.start}
        className={cn(arrow, '-start-5')}><ChevronLeftIcon aria-hidden="true" className="size-5 rtl:rotate-180" /></button>
      <button type="button" aria-label={t.nextPage} onClick={() => show(paging.page + 1)} disabled={paging.end}
        className={cn(arrow, '-end-5')}><ChevronRightIcon aria-hidden="true" className="size-5 rtl:rotate-180" /></button>
    </div>
  </section>;
}
