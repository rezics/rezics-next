'use client';

import { Button, buttonVariants } from '@rezics/ui/button';
import { RotateCwIcon, SearchXIcon, TriangleAlertIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { EmptyState } from '../shell/empty-state.tsx';
import LocalizedLink from '../shell/localized-link.tsx';
import { PageContainer } from '../shell/page.tsx';
import type { RealmMessages } from './messages.ts';

/** No public Realm or official Zone has this address. */
export function RealmNotFound({ messages }: { messages: RealmMessages }) {
  return <PageContainer>
    <EmptyState icon={SearchXIcon} headingLevel={1} title={messages.notFoundTitle} description={messages.notFoundBody}>
      <LocalizedLink href="/discover" className={buttonVariants()}>{messages.browse}</LocalizedLink>
    </EmptyState>
  </PageContainer>;
}

/** Main could not answer for the Realm itself, so no part of its page can be shown. */
export function RealmUnavailable({ messages }: { messages: RealmMessages }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return <PageContainer>
    <EmptyState icon={TriangleAlertIcon} tone="destructive" role="alert" headingLevel={1}
      title={messages.unavailableTitle} description={messages.unavailableBody}>
      <Button variant="outline" disabled={pending} onClick={() => start(() => router.refresh())}>
        <RotateCwIcon aria-hidden="true" className={pending ? 'motion-safe:animate-spin' : undefined} />
        {messages.retry}</Button>
    </EmptyState>
  </PageContainer>;
}
