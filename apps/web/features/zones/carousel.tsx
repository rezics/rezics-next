'use client';

import { cn } from '@rezics/ui/utils';
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import { Children, type ReactNode, useEffect, useRef, useState } from 'react';

/**
 * The hero: slides in a swipeable track, the next one peeking in, with
 * arrows and position dots on wide screens. It never advances by itself.
 */
export function HeroCarousel({ children, label, slideLabels, previous, next, className }: {
  children: ReactNode; label: string;
  /** "2 of 5" for each slide, in order. */
  slideLabels: readonly string[];
  previous: string; next: string; className?: string;
}) {
  const track = useRef<HTMLUListElement>(null);
  const slides = Children.toArray(children);
  const [current, setCurrent] = useState(0);
  useEffect(() => {
    const element = track.current;
    if (!element) return;
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) setCurrent(Number((entry.target as HTMLElement).dataset.index));
      }
    }, { root: element, threshold: 0.6 });
    for (const slide of element.children) observer.observe(slide);
    return () => observer.disconnect();
  }, []);
  function go(index: number) {
    const slide = track.current?.children[Math.max(0, Math.min(slides.length - 1, index))] as HTMLElement | undefined;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    slide?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'nearest', inline: 'start' });
  }
  const arrow = cn('absolute top-1/2 z-10 hidden size-10 -translate-y-1/2 place-items-center rounded-full',
    'bg-black/45 text-white outline-none backdrop-blur transition-opacity hover:bg-black/60',
    'focus-visible:ring-2 focus-visible:ring-white md:grid');
  return <section aria-roledescription="carousel" aria-label={label} className={cn('relative min-w-0', className)}>
    <ul ref={track} className="flex snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto overscroll-x-contain
      px-4 [scrollbar-width:none] sm:scroll-px-6 sm:px-6 lg:scroll-px-10 lg:gap-4 lg:px-10
      [&::-webkit-scrollbar]:hidden">
      {slides.map((slide, index) => <li key={index} data-index={index} aria-roledescription="slide"
        aria-label={slideLabels[index]}
        className="w-[88%] shrink-0 snap-start sm:w-[min(40rem,78%)]">{slide}</li>)}
    </ul>
    {slides.length > 1 ? <>
      <button type="button" aria-label={previous} onClick={() => go(current - 1)} disabled={current === 0}
        className={cn(arrow, 'start-3 disabled:opacity-0 rtl:rotate-180')}>
        <ChevronLeftIcon aria-hidden="true" className="size-5" /></button>
      <button type="button" aria-label={next} onClick={() => go(current + 1)} disabled={current === slides.length - 1}
        className={cn(arrow, 'end-3 disabled:opacity-0 rtl:rotate-180')}>
        <ChevronRightIcon aria-hidden="true" className="size-5" /></button>
      <div aria-hidden="true" className="mt-3 flex justify-center gap-1.5">
        {slides.map((_, index) => <span key={index} className={cn('h-1.5 rounded-full transition-all',
          index === current ? 'w-5 bg-primary' : 'w-1.5 bg-foreground/20')} />)}
      </div>
    </> : null}
  </section>;
}
