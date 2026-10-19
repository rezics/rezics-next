import type { UiLocale } from '../../i18n/define.ts';
import { browseCategories } from '../catalogue/registry.ts';
import Link from '../shell/localized-link.tsx';
import { browseMessages } from './browse-messages.ts';
import { browseHref, changeBrowse, type BrowseState } from './browse-state.ts';

/** The shared Link reveals the current destination on direct loads, resize and history restoration. */
export function BrowseTabs({ state, locale }: { state: BrowseState; locale: UiLocale }) {
  const t = browseMessages[locale];
  const tabs = [{ id: 'all', label: t.all }, ...browseCategories().map(category => ({ id: category.id,
    label: category.labels[locale] }))];
  return <nav aria-label={t.type} className="flex min-w-0 max-w-full gap-1 overflow-x-auto pb-1">
    {tabs.map(({ id: tab, label }) => <Link key={tab} documentNavigation prefetch={false}
      href={browseHref(changeBrowse(state, { tab }))} aria-current={state.tab === tab && !state.section ? 'page' : undefined}
      className="inline-flex h-9 shrink-0 items-center rounded-full px-4 font-medium text-sm outline-none
        hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-foreground
        aria-[current=page]:text-background">{label}</Link>)}
  </nav>;
}
