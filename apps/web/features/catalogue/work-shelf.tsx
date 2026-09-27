'use client';

import { cn } from '@rezics/ui/utils';
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import { type ReactNode, type Ref, useCallback, useEffect, useId, useRef, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import Link from '../shell/localized-link.tsx';
import { messages } from './messages.ts';
import { type CatalogueWork, slotRatio } from './work.ts';
import { WorkTile } from './work-tile.tsx';

export interface ShelfHeading {
  title: ReactNode;
  /** The title's language when it names content, such as a Realm or a genre in another language. */
  lang?: string;
  /** A short line under the title. */
  subtitle?: ReactNode;
  /** The shelf's full list. */
  seeAll?: { href: string; label?: string };
}

/** A shelf's title row: the heading, an optional line under it and "See all". */
export function ShelfHeader({ id, heading, locale, children }: {
  id: string; heading: ShelfHeading; locale: UiLocale; children?: ReactNode;
}) {
  const t = materializeData(messages[locale], { locale });
  return <header className="flex items-end justify-between gap-4">
    <div className="min-w-0 space-y-1">
      <h2 id={id} lang={heading.lang} className="text-balance font-semibold text-xl tracking-tight">{heading.title}</h2>
      {heading.subtitle ? <p className="text-pretty text-muted-foreground text-sm">{heading.subtitle}</p> : null}
    </div>
    <div className="flex shrink-0 items-center gap-3">
      {children}
      {heading.seeAll ? <Link href={heading.seeAll.href} className="inline-flex items-center gap-0.5 rounded-sm
        font-medium text-primary text-sm outline-none underline-offset-4 hover:underline focus-visible:ring-2
        focus-visible:ring-ring">{heading.seeAll.label ?? t.seeAll}<ChevronRightIcon aria-hidden="true"
          className="size-4 rtl:rotate-180" /></Link> : null}
    </div>
  </header>;
}

const arrow = cn('absolute top-[38%] z-30 hidden size-11 -translate-y-1/2 place-items-center rounded-full',
  'border border-border/60 bg-background text-foreground shadow-[0_4px_14px_rgb(0_0_0/0.16)] outline-none',
  'transition-opacity hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none',
  // Arrows only where a pointer needs them and the page margin can hold them; touch screens swipe.
  'disabled:opacity-0 sm:pointer-fine:grid');

/**
 * A row of Works that scrolls sideways, as Goodreads' "Readers also enjoyed":
 * swipe on touch screens, arrows with a pointer. The next tile peeks in on
 * narrow screens so the row reads as scrollable.
 */
export function WorkShelf({ heading, works, avatarQuery, locale, className }: {
  heading: ShelfHeading; works: readonly CatalogueWork[]; avatarQuery?: string; locale: UiLocale; className?: string;
}) {
  const t = materializeData(messages[locale], { locale });
  const headingId = useId();
  const list = useRef<HTMLUListElement>(null);
  const [edges, setEdges] = useState({ start: true, end: true });
  const measure = useCallback(() => {
    const element = list.current;
    if (!element) return;
    // scrollLeft runs negative in right-to-left layouts.
    const offset = Math.abs(element.scrollLeft);
    setEdges({ start: offset < 4, end: offset + element.clientWidth >= element.scrollWidth - 4 });
  }, []);
  useEffect(() => {
    measure();
    const element = list.current;
    if (!element) return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [measure, works.length]);
  const page = (direction: 1 | -1) => {
    const element = list.current;
    if (!element) return;
    const rtl = getComputedStyle(element).direction === 'rtl' ? -1 : 1;
    element.scrollBy({ left: direction * rtl * element.clientWidth * 0.9, behavior: 'smooth' });
  };
  const slot = slotRatio(works);
  // min-w-0 keeps the row's scroll width from widening the page's grid.
  return <section aria-labelledby={headingId} className={cn('grid min-w-0 grid-cols-1 gap-4', className)}>
    <ShelfHeader id={headingId} heading={heading} locale={locale} />
    <div className="relative min-w-0">
      <ul ref={list} onScroll={measure} className="-mx-4 flex snap-x snap-mandatory scroll-px-4 gap-x-4 overflow-x-auto
        px-4 pt-1 pb-2 scrollbar-none sm:-mx-1 sm:scroll-px-1 sm:gap-x-6 sm:px-1">
        {works.map(work => <li key={work.id} className="w-[42%] shrink-0 snap-start sm:w-[calc((100%-3*1.5rem)/3.4)]
          md:w-[calc((100%-4*1.5rem)/4.4)] lg:w-[calc((100%-4*1.5rem)/5)]">
          <WorkTile work={work} slot={slot} avatarQuery={avatarQuery} locale={locale} />
        </li>)}
      </ul>
      <button type="button" aria-label={t.previous} onClick={() => page(-1)} disabled={edges.start}
        className={cn(arrow, '-start-5')}><ChevronLeftIcon aria-hidden="true" className="size-5 rtl:rotate-180" /></button>
      <button type="button" aria-label={t.next} onClick={() => page(1)} disabled={edges.end}
        className={cn(arrow, '-end-5')}><ChevronRightIcon aria-hidden="true" className="size-5 rtl:rotate-180" /></button>
    </div>
  </section>;
}

/** Works in rows that wrap, for a full list with "Show more". */
export function WorkGrid({ works, headingLevel, avatarQuery, locale, listRef, className }: {
  works: readonly CatalogueWork[];
  /** The tiles' title level: 2 where the grid sits right under the page's <h1>. */
  headingLevel?: 2 | 3 | 4;
  avatarQuery?: string; locale: UiLocale;
  listRef?: Ref<HTMLUListElement>; className?: string;
}) {
  const slot = slotRatio(works);
  return <ul ref={listRef} className={cn('grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 sm:gap-x-6 md:grid-cols-4',
    'lg:grid-cols-5', className)}>
    {works.map(work => <li key={work.id} className="min-w-0">
      <WorkTile work={work} slot={slot} headingLevel={headingLevel} avatarQuery={avatarQuery} locale={locale} />
    </li>)}
  </ul>;
}
