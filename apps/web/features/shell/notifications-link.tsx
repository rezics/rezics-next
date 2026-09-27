'use client';

import { buttonVariants } from '@rezics/ui/button';
import { cn } from '@rezics/ui/utils';
import { BellIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { localizedPath } from '../../i18n/locale.ts';
import { isCurrent } from './navigation.ts';
import { useShell } from './shell-provider.tsx';
import { unreadBadge, useUnread } from './unread.ts';

/** The unread count on an icon. It carries text, so it is ink blue: the logo red fails small-text contrast. */
export function UnreadBadge({ label, className }: { label: string; className?: string }) {
  return <span aria-hidden="true" className={cn('pointer-events-none absolute grid h-4 min-w-4 place-items-center',
    'rounded-full bg-primary px-1 font-bold text-[10px] text-primary-foreground leading-none ring-2 ring-background',
    className)}>{label}</span>;
}

/** The top bar's bell: notifications with the unread count. Phones use the bar's Notifications item instead. */
export function NotificationsLink() {
  const { t, locale, signedIn } = useShell();
  const pathname = usePathname();
  const unread = useUnread(signedIn);
  const label = unread?.count ? t.notificationsUnread({ count: unreadBadge(unread) }) : t.notifications;
  return <Link href={localizedPath('/notifications', locale)} aria-label={label} title={label}
    aria-current={isCurrent({ href: '/notifications' }, pathname) ? 'page' : undefined}
    className={buttonVariants({ variant: 'ghost', size: 'icon-md',
      className: 'relative hidden text-muted-foreground aria-[current=page]:text-primary md:inline-flex' })}>
    <BellIcon aria-hidden="true" className="size-5" />
    {unread?.count ? <UnreadBadge label={unreadBadge(unread)} className="-top-0.5 -end-0.5" /> : null}
  </Link>;
}
