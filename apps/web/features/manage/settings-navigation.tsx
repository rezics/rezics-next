'use client';

import { cn } from '@rezics/ui/utils';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { withoutLocale } from '../../i18n/locale.ts';
import { browserMainApi } from '../api/browser.ts';
import LocalizedLink from '../shell/localized-link.tsx';
import { type RealmSection, realmHref } from './routes.ts';
import { readManagementAccess } from './settings-api.ts';

const sections: readonly RealmSection[] = ['queue', 'log', 'members', 'roles', 'showcase', 'zones', 'settings'];

/** Settings authority is independent of membership management. Main checks the
 * settings read; the inbox remains discoverable without a settings grant. */
export function AccessRealmTabs({ realm, address, actor, labels, settingsAllowed }: {
  realm: string; address: string; actor: string; labels: Record<RealmSection | 'nav', string>;
  /** A resolved authority, also used by isolated stories. */
  settingsAllowed?: boolean;
}) {
  const pathname = withoutLocale(usePathname());
  const [authority, setAuthority] = useState<{ realm: string; actor: string; allowed: boolean } | null>(null);
  useEffect(() => {
    if (settingsAllowed !== undefined) return;
    let alive = true;
    void readManagementAccess(browserMainApi(), realm, actor).then(result => {
      if (alive) setAuthority({ realm, actor, allowed: result.ok });
    });
    return () => { alive = false; };
  }, [realm, actor, settingsAllowed]);
  const allowed = settingsAllowed ?? (authority?.realm === realm && authority.actor === actor && authority.allowed);
  return <nav aria-label={labels.nav} className="-mb-px flex gap-1 overflow-x-auto">
    {sections.filter(section => section !== 'settings' || allowed).map(section => {
      const href = realmHref(address, section);
      return <LocalizedLink key={section} href={href} aria-current={pathname === href ? 'page' : undefined}
        className={cn('shrink-0 border-transparent border-b-2 px-3 py-2.5 font-medium text-muted-foreground text-sm',
          'rounded-t-md outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
          'aria-[current=page]:border-primary aria-[current=page]:text-foreground')}>{labels[section]}</LocalizedLink>;
    })}
  </nav>;
}
