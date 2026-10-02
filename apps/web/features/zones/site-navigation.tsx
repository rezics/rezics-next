'use client';

import { cn } from '@rezics/ui/utils';
import type { ZoneText } from '@rezics/zone-sdk';
import { ChevronRightIcon } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { withoutLocale } from '../../i18n/locale.ts';
import LocalizedLink from '../shell/localized-link.tsx';

/** A page the Zone's navigation links to: its address (no locale prefix) and its name in the target's language. */
export interface SiteLink { href: string; label: ZoneText }
/** A step on the way from the Zone's home to the page being read; the page itself has no link. */
export interface SiteCrumb { label: ZoneText; href: string | null }

const column = 'mx-auto flex w-full max-w-6xl px-4 sm:px-6 lg:px-10';

/**
 * The Zone's own pages in the order its Structure gives them, under the platform's tabs. The page being read, or
 * the mounted page it belongs to, is marked.
 */
export function ZoneSiteNavigation({ links, label }: { links: readonly SiteLink[]; label: string }) {
  const here = withoutLocale(usePathname());
  if (!links.length) return null;
  return <nav aria-label={label} data-zone-site-navigation="" className="border-border/70 border-b">
    <ul className={cn(column, 'gap-1 overflow-x-auto py-1 [scrollbar-width:none]')}>
      {links.map(link => {
        const target = withoutLocale(link.href.split(/[?#]/)[0]!);
        const home = /^\/z\/[^/]+$/.test(target);
        const current = here === target || !home && here.startsWith(`${target}/`);
        return <li key={link.href}>
          <LocalizedLink href={link.href} aria-current={current ? 'page' : undefined} lang={link.label.lang || undefined}
            dir={link.label.dir}
            className={cn('flex h-9 items-center whitespace-nowrap rounded-md px-3 text-sm text-muted-foreground outline-none',
              'transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
              'aria-[current=page]:font-medium aria-[current=page]:text-foreground')}>{link.label.value}</LocalizedLink>
        </li>;
      })}
    </ul>
  </nav>;
}

/** Home → mounted page → the page being read, where the last step is the page itself. */
export function ZoneBreadcrumbs({ crumbs, label }: { crumbs: readonly SiteCrumb[]; label: string }) {
  if (crumbs.length < 2) return null;
  return <nav aria-label={label} data-zone-breadcrumbs="">
    <ol className={cn(column, 'flex-wrap items-center gap-x-1 gap-y-0.5 pt-4 text-muted-foreground text-sm')}>
      {crumbs.map((crumb, index) => <li key={crumb.href ?? index} className="flex min-w-0 items-center gap-1">
        {index ? <ChevronRightIcon aria-hidden="true" className="size-3.5 shrink-0 rtl:rotate-180" /> : null}
        {crumb.href ? <LocalizedLink href={crumb.href} lang={crumb.label.lang || undefined}
          className="truncate rounded-sm underline-offset-4 hover:text-foreground hover:underline">
          {crumb.label.value}</LocalizedLink>
          : <span aria-current="page" lang={crumb.label.lang || undefined}
            className="truncate font-medium text-foreground">{crumb.label.value}</span>}
      </li>)}
    </ol>
  </nav>;
}
