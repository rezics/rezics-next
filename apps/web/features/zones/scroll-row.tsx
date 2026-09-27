'use client';

import { cn } from '@rezics/ui/utils';
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import { Children, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

/**
 * One swipeable row of cards. Wide screens get arrow buttons at the edges
 * that page by the visible width; phones swipe. Items snap to the start.
 */
export function ScrollRow({ children, label, previous, next, itemClassName, className }: {
  children: ReactNode; label: string; previous: string; next: string;
  /** Sizes each item; the default fits seven covers on a wide column and three on a phone. */
  itemClassName?: string; className?: string;
}) {
  const list = useRef<HTMLUListElement>(null);
  const [edges, setEdges] = useState({ start: true, end: true });
  const measure = useCallback(() => {
    const element = list.current;
    if (!element) return;
    const scrolled = Math.abs(element.scrollLeft);
    setEdges({ start: scrolled < 4, end: scrolled + element.clientWidth >= element.scrollWidth - 4 });
  }, []);
  useEffect(() => {
    const element = list.current;
    if (!element) return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    element.addEventListener('scroll', measure, { passive: true });
    return () => { observer.disconnect(); element.removeEventListener('scroll', measure); };
  }, [measure]);
  function page(direction: 1 | -1) {
    const element = list.current;
    if (!element) return;
    const rtl = getComputedStyle(element).direction === 'rtl' ? -1 : 1;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    element.scrollBy({ left: direction * rtl * element.clientWidth * 0.9, behavior: reduce ? 'auto' : 'smooth' });
  }
  const arrow = cn('absolute top-[calc(var(--zone-arrow-top,38%))] z-20 hidden size-9 -translate-y-1/2 place-items-center',
    'rounded-full border border-border/70 bg-card/95 text-foreground shadow-md outline-none backdrop-blur',
    'transition-opacity hover:bg-card focus-visible:ring-2 focus-visible:ring-ring md:grid');
  return <div className={cn('relative min-w-0', className)}>
    <ul ref={list} aria-label={label} className="-mx-1 flex snap-x snap-mandatory scroll-px-1 gap-(--zone-shelf-gap)
      overflow-x-auto overscroll-x-contain px-1 pt-1 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {Children.map(children, child => <li className={cn('w-[29%] shrink-0 snap-start sm:w-[21%] lg:w-[calc((100%-6*var(--zone-shelf-gap))/7)]',
        itemClassName)}>{child}</li>)}
    </ul>
    <button type="button" aria-label={previous} onClick={() => page(-1)} tabIndex={-1}
      className={cn(arrow, '-start-3 rtl:rotate-180', edges.start && 'pointer-events-none opacity-0')}>
      <ChevronLeftIcon aria-hidden="true" className="size-4" /></button>
    <button type="button" aria-label={next} onClick={() => page(1)} tabIndex={-1}
      className={cn(arrow, '-end-3 rtl:rotate-180', edges.end && 'pointer-events-none opacity-0')}>
      <ChevronRightIcon aria-hidden="true" className="size-4" /></button>
  </div>;
}
