'use client';

import { cn } from '@rezics/ui/utils';
import { usePathname } from 'next/navigation';
import type { UiLocale } from '../../i18n/define.ts';
import LocalizedLink from '../shell/localized-link.tsx';
import { type RealmTab, realmHref, realmTabs, repeatsTab, tabOf, zoneNavigationHref } from './route.ts';

const link = cn('relative flex h-11 items-center whitespace-nowrap rounded-t-lg px-3 font-medium text-sm',
  'text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring');

/**
 * The Realm's views as links, each its own URL, then the Zone's own
 * navigation. It sticks under the site header so a long Zone page keeps them
 * in reach.
 */
export function RealmTabs({ locale, realmRef, labels, label, navigation }: {
  locale: UiLocale; realmRef: string; labels: Record<RealmTab, string>; label: string;
  /** The Zone's own links (Rankings, Latest, ...), after the tabs. */
  navigation: readonly { label: string; href: string }[];
}) {
  const current = tabOf(usePathname());
  const links = navigation.flatMap(item => {
    const href = zoneNavigationHref(item.href, realmRef);
    return repeatsTab(href, realmRef) ? [] : [{ label: item.label, href }];
  });
  return <nav aria-label={label} className="sticky top-16 z-30 mt-4 border-border/70 border-b bg-(--zone-page)/92
    backdrop-blur-md">
    <div className="mx-auto flex max-w-6xl overflow-x-auto px-2 [scrollbar-width:none] sm:px-4 lg:px-8">
      <ul className="flex shrink-0 gap-0.5">
        {realmTabs.map(tab => <li key={tab}>
          <LocalizedLink href={realmHref(locale, realmRef, tab)} aria-current={tab === current ? 'page' : undefined}
            className={cn(link, 'aria-[current=page]:text-foreground aria-[current=page]:after:absolute',
              'aria-[current=page]:after:inset-x-2 aria-[current=page]:after:-bottom-px aria-[current=page]:after:h-0.5',
              'aria-[current=page]:after:rounded-full aria-[current=page]:after:bg-primary')}>{labels[tab]}</LocalizedLink>
        </li>)}
      </ul>
      {links.length ? <ul className="ms-2 flex shrink-0 items-center gap-0.5 border-border/70 border-s ps-2">
        {links.map(item => <li key={item.href}>
          <LocalizedLink href={item.href} className={link}>{item.label}</LocalizedLink></li>)}
      </ul> : null}
    </div>
  </nav>;
}
