'use client';

import { cn } from '@rezics/ui/utils';
import { type ReactNode, type Ref, useImperativeHandle, useLayoutEffect, useRef } from 'react';

/**
 * Natural-height cards, in source order. Auto-fill uses the space the owner
 * actually has, including sidebars; a lone result keeps the same preview width.
 * SSR remains an ordinary readable grid until its card heights are known.
 */
export function CatalogueGrid({ children, listRef, className }: {
  children: ReactNode; listRef?: Ref<HTMLUListElement>; className?: string;
}) {
  const list = useRef<HTMLUListElement>(null);
  useImperativeHandle(listRef, () => list.current!, []);
  useLayoutEffect(() => {
    const element = list.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const cards = [...element.children].flatMap(item => item instanceof HTMLElement
      && item.firstElementChild instanceof HTMLElement ? [{ item, card: item.firstElementChild }] : []);
    const measure = () => {
      // Read before writing. Measuring the content, rather than its grid area,
      // lets a card shrink again after a font, image preference or text changes.
      const spans = cards.map(({ card }) => Math.max(1, Math.ceil((card.getBoundingClientRect().height + 24) / 4)));
      cards.forEach(({ item }, index) => { item.style.gridRowEnd = `span ${spans[index]}`; });
      element.dataset.masonry = 'true';
    };
    const observer = new ResizeObserver(measure);
    cards.forEach(({ card }) => observer.observe(card));
    measure();
    return () => {
      observer.disconnect();
      delete element.dataset.masonry;
      cards.forEach(({ item }) => { item.style.removeProperty('grid-row-end'); });
    };
  }, [children]);
  // Sparse row placement never backfills an earlier hole with a later card:
  // https://www.w3.org/TR/css-grid-1/#grid-auto-flow-property
  // Four-pixel tracks bound rounding to <4px without thousands of tiny rows.
  return <ul ref={list} data-slot="catalogue-grid" className={cn(
    'grid min-w-0 grid-flow-row grid-cols-[repeat(auto-fill,minmax(0,8rem))] items-start gap-x-4 gap-y-6',
    'data-[masonry=true]:auto-rows-[4px] data-[masonry=true]:gap-y-0', className,
  )}>{children}</ul>;
}
