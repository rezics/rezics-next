'use client';

import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import { Children, type ReactNode, useEffect, useRef, useState } from 'react';

/**
 * A shelf as Goodreads sets "Readers also enjoyed": a row of covers with page
 * marks beside its title and a round button over the edge that turns a page.
 * Phones swipe; the row snaps to each cover. Without script it still scrolls.
 */
export function ShelfCarousel({ label, previous, next, head, children }: {
  label: string; previous: string; next: string;
  /** The title and "More" the page marks sit beside. */
  head?: ReactNode;
  children: ReactNode;
}) {
  const track = useRef<HTMLUListElement>(null);
  const [view, setView] = useState({ page: 0, pages: 1 });
  useEffect(() => {
    const element = track.current;
    if (!element) return;
    const measure = () => {
      const width = element.clientWidth || 1;
      const pages = Math.max(1, Math.ceil((element.scrollWidth - 4) / width));
      const scrolled = Math.abs(element.scrollLeft);
      const page = scrolled + width >= element.scrollWidth - 4 ? pages - 1 : Math.round(scrolled / width);
      setView(current => current.page === page && current.pages === pages ? current : { page, pages });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    element.addEventListener('scroll', measure, { passive: true });
    return () => { observer.disconnect(); element.removeEventListener('scroll', measure); };
  }, []);
  function turn(direction: 1 | -1) {
    const element = track.current;
    if (!element) return;
    const rtl = getComputedStyle(element).direction === 'rtl' ? -1 : 1;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    element.scrollBy({ left: direction * rtl * element.clientWidth, behavior: reduce ? 'auto' : 'smooth' });
  }
  return <div className="bz-carousel">
    <div className="bz-carousel-head">
      {head}
      {view.pages > 1 ? <span aria-hidden="true" className="bz-pages">
        {Array.from({ length: view.pages }, (_, index) =>
          <span key={index} data-current={index === view.page ? '' : undefined} />)}
      </span> : null}
    </div>
    <div className="bz-carousel-body">
      <ul ref={track} aria-label={label} className="bz-track">
        {Children.map(children, child => <li>{child}</li>)}
      </ul>
      {/* Pointer shortcuts: keyboard and screen-reader users move through the covers' own links. */}
      <button type="button" tabIndex={-1} aria-label={previous} data-edge="start" className="bz-turn"
        hidden={view.page === 0} onClick={() => turn(-1)}>
        <ChevronLeftIcon aria-hidden="true" /></button>
      <button type="button" tabIndex={-1} aria-label={next} data-edge="end" className="bz-turn"
        hidden={view.page >= view.pages - 1} onClick={() => turn(1)}>
        <ChevronRightIcon aria-hidden="true" /></button>
    </div>
  </div>;
}
