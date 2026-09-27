'use client';

import { cn } from '@rezics/ui/utils';
import { usePathname } from 'next/navigation';
import { withoutLocale } from '../../i18n/locale.ts';
import LocalizedLink from '../shell/localized-link.tsx';
import { type RealmSection, realmHref } from './routes.ts';

const sections: readonly RealmSection[] = ['queue', 'log', 'members', 'roles', 'settings'];

/** The Realm's management sections as links; the current one is marked for assistive technology. `realm` is its address. */
export function RealmTabs({ realm, labels }: { realm: string; labels: Record<RealmSection | 'nav', string> }) {
  const pathname = withoutLocale(usePathname());
  return <nav aria-label={labels.nav} className="-mb-px flex gap-1 overflow-x-auto">
    {sections.map(section => {
      const href = realmHref(realm, section);
      const current = pathname === href;
      return <LocalizedLink key={section} href={href} aria-current={current ? 'page' : undefined}
        className={cn('shrink-0 border-transparent border-b-2 px-3 py-2.5 font-medium text-muted-foreground text-sm',
          'rounded-t-md outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
          'aria-[current=page]:border-primary aria-[current=page]:text-foreground')}>{labels[section]}</LocalizedLink>;
    })}
  </nav>;
}
