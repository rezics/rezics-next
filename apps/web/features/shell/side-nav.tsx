'use client';

import { buttonVariants } from '@rezics/ui/button';
import { cn } from '@rezics/ui/utils';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { createContext, type ReactNode, use } from 'react';
import { localizedPath } from '../../i18n/locale.ts';
import { isCurrent, navigation } from './navigation.ts';
import { UnreadBadge } from './notifications-link.tsx';
import { useShell } from './shell-provider.tsx';
import { unreadBadge, useUnread } from './unread.ts';

interface SideNavState { collapsed: boolean; onNavigate?: () => void }

const badge = 'rounded-full bg-primary px-1.5 py-0.5 font-bold text-[11px] text-primary-foreground leading-none';

const SideNavContext = createContext<SideNavState>({ collapsed: false });

/** Whether the navigation around a section is the collapsed rail, and what closes the phone drawer. */
export function useSideNav(): SideNavState {
  return use(SideNavContext);
}

/**
 * The full navigation. The desktop rail follows the collapse toggle; the
 * phone drawer is always expanded. `communities` (followed Realms and Zones,
 * official Zones, Manage) streams in from the server below the main items.
 */
export function SideNav({ variant, onNavigate, communities }: {
  variant: 'rail' | 'drawer'; onNavigate?: () => void; communities?: ReactNode;
}) {
  const { locale, t, collapsed: railCollapsed, signedIn } = useShell();
  const collapsed = variant === 'rail' && railCollapsed;
  const pathname = usePathname();
  const unread = useUnread(signedIn);
  const action = navigation.find(item => item.emphasized);
  return <div className="flex h-full min-h-0 min-w-0 flex-col">
    <nav aria-label={t.navigation} className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] content-start gap-3
      overflow-y-auto p-3">
      {action ? <Link href={localizedPath(action.href, locale)} onClick={onNavigate} title={collapsed ? action.label[locale] : undefined}
        aria-current={isCurrent(action, pathname) ? 'page' : undefined}
        className={cn(buttonVariants({ size: 'lg' }), 'min-w-0 w-full', collapsed && 'px-0')}>
        <action.icon aria-hidden="true" className="size-5 shrink-0" />
        <span className={collapsed ? 'sr-only' : 'min-w-0 truncate'}>{action.label[locale]}</span>
      </Link> : null}
      <ul className="grid min-w-0 gap-1">
        {navigation.filter(item => item !== action).map(item => {
          const count = item.href === '/notifications' && unread?.count ? unreadBadge(unread) : null;
          return <li key={item.href} className="min-w-0">
            <Link href={localizedPath(item.href, locale)} onClick={onNavigate} title={collapsed ? item.label[locale] : undefined}
              aria-current={isCurrent(item, pathname) ? 'page' : undefined}
              className={cn('flex h-10 min-w-0 items-center gap-3 rounded-xl px-3 font-medium text-muted-foreground text-sm',
                'outline-none transition-colors hover:bg-accent/60 hover:text-accent-foreground',
                'focus-visible:ring-2 focus-visible:ring-ring',
                'aria-[current=page]:bg-accent aria-[current=page]:font-semibold aria-[current=page]:text-accent-foreground',
                collapsed && 'justify-center px-0')}>
              <span className="relative shrink-0"><item.icon aria-hidden="true" className="size-5" />
                {count && collapsed ? <UnreadBadge label={count} className="-top-1.5 -end-2.5" /> : null}</span>
              <span className={collapsed ? 'sr-only' : 'min-w-0 flex-1 truncate'}>{item.label[locale]}</span>
              {count ? <span className={collapsed ? 'sr-only' : cn(badge, 'shrink-0')}>
                <span className="sr-only">, </span>{collapsed ? t.notificationsUnread({ count }) : count}</span> : null}
              {item.planned && !collapsed
                ? <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 font-medium text-[11px] text-muted-foreground">
                  {t.soon}</span>
                : null}
            </Link>
          </li>;
        })}
      </ul>
      <SideNavContext value={{ collapsed, onNavigate }}>{communities}</SideNavContext>
    </nav>
  </div>;
}
