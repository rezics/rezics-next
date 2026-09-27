'use client';

import { buttonVariants } from '@rezics/ui/button';
import { BellIcon } from 'lucide-react';
import Link from 'next/link';
import { useShell } from './shell-provider.tsx';

/** The top bar's notifications slot. The Inbox slice adds the unread mark (a --brand dot). */
export function NotificationsLink() {
  const { t } = useShell();
  return <Link href="/inbox" aria-label={t.notifications} title={t.notifications}
    className={buttonVariants({ variant: 'ghost', size: 'icon-md', className: 'text-muted-foreground' })}>
    <BellIcon aria-hidden="true" className="size-5" />
  </Link>;
}
