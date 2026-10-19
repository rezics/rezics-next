'use client';

import { useEffect, useRef } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { browseCategories } from '../catalogue/registry.ts';
import Link from '../shell/localized-link.tsx';
import { browseMessages } from './browse-messages.ts';
import { browseHref, changeBrowse, type BrowseState } from './browse-state.ts';

/** Reveal the destination on direct loads and history restoration without scrolling the page vertically. */
export function BrowseTabs({ state, locale }: { state: BrowseState; locale: UiLocale }) {
  const nav = useRef<HTMLElement>(null);
  const selection = browseHref(state);
  useEffect(() => {
    const container = nav.current, active = container?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!container || !active) return;
    const frame = container.getBoundingClientRect(), item = active.getBoundingClientRect();
    const delta = item.left < frame.left ? item.left - frame.left
      : item.right > frame.right ? item.right - frame.right : 0;
    if (delta) container.scrollBy({ left: delta, behavior: 'instant' });
  }, [selection]);
  const t = browseMessages[locale];
  const tabs = [{ id: 'all', label: t.all }, ...browseCategories().map(category => ({ id: category.id,
    label: category.labels[locale] }))];
  return <nav ref={nav} aria-label={t.type} className="flex min-w-0 max-w-full gap-1 overflow-x-auto pb-1">
    {tabs.map(({ id: tab, label }) => <Link key={tab} documentNavigation prefetch={false}
      href={browseHref(changeBrowse(state, { tab }))} aria-current={state.tab === tab && !state.section ? 'page' : undefined}
      className="inline-flex h-9 shrink-0 items-center rounded-full px-4 font-medium text-sm outline-none
        hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-foreground
        aria-[current=page]:text-background">{label}</Link>)}
  </nav>;
}
