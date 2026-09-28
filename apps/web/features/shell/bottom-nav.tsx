'use client';

import { cn } from '@rezics/ui/utils';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { isCurrent, navigation } from './navigation.ts';
import { UnreadBadge } from './notifications-link.tsx';
import { useShell } from './shell-provider.tsx';
import { unreadBadge, useUnread } from './unread.ts';
import { localizedPath } from '../../i18n/locale.ts';

/** The phone navigation: five items with the emphasized action raised in the center. */
export function BottomNav() {
  const { locale, t, signedIn } = useShell();
  const pathname = usePathname();
  const unread = useUnread(signedIn);
  return <nav aria-label={t.navigation} className="fixed inset-x-0 bottom-0 z-40 border-border/60 border-t
    bg-background/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-md transition-transform duration-300
    motion-reduce:transition-none [html[data-reading=hidden]_&]:translate-y-full md:hidden">
    <ul className="grid h-16 grid-cols-5">
      {navigation.filter(item => item.bottom).map(item => {
        const count = item.href === '/notifications' && unread?.count ? unreadBadge(unread) : null;
        return <li key={item.href} className="min-w-0">
          <Link href={localizedPath(item.href, locale)} aria-current={isCurrent(item, pathname) ? 'page' : undefined}
            aria-label={count ? `${item.label[locale]} · ${t.notificationsUnread({ count })}` : undefined}
            className={cn('group flex h-full flex-col items-center justify-center gap-1 px-1 outline-none',
              'font-medium text-[11px] text-muted-foreground transition-colors',
              'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
              'aria-[current=page]:text-primary')}>
            {item.emphasized
              ? <span className="-mt-1 grid h-9 w-12 place-items-center rounded-2xl bg-primary text-primary-foreground
                shadow-(--aura-shadow-card) transition-transform group-active:scale-95">
                <item.icon aria-hidden="true" className="size-5" /></span>
              : <span className="relative"><item.icon aria-hidden="true" className="size-5" />
                {count ? <UnreadBadge label={count} className="-top-1.5 -end-2.5" /> : null}</span>}
            <span className="max-w-full truncate">{item.label[locale]}</span>
          </Link>
        </li>;
      })}
    </ul>
  </nav>;
}
