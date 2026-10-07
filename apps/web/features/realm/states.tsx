'use client';

import { Button, buttonVariants } from '@rezics/ui/button';
import { RotateCwIcon, SearchXIcon, TriangleAlertIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { failureText, type ReadFailure as FeedFailure } from '../feed/types.ts';
import { EmptyState, failureDetail } from '../shell/empty-state.tsx';
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

function realmCopy(messages: RealmMessages, title: string) {
  return { failedTitle: title, offline: messages.offlineBody, server: messages.unavailableBody,
    missingTitle: messages.notFoundTitle, missingBody: messages.notFoundBody,
    deniedTitle: messages.deniedTitle, deniedBody: messages.deniedBody,
    movedTitle: messages.movedTitle, movedBody: messages.movedBody, budget: messages.budgetBody };
}

/** Main could not answer for the Realm itself, so no part of its page can be shown. */
export function RealmUnavailable({ messages, failure = 'unavailable', reference }: {
  messages: RealmMessages; failure?: FeedFailure; reference?: string;
}) {
  const text = failureText(failure, realmCopy(messages, messages.unavailableTitle));
  if (text.kind === 'absent') return null;
  if (failure === 'missing') return <RealmNotFound messages={messages} />;
  const router = useRouter();
  const [pending, start] = useTransition();
  const quiet = text.action === 'none' || text.action === 'sign-in';
  return <PageContainer>
    <EmptyState icon={text.action === 'restart' ? RotateCwIcon : TriangleAlertIcon}
      tone={quiet || text.action === 'restart' ? 'default' : 'destructive'} role={quiet ? 'status' : 'alert'} headingLevel={1}
      title={text.title} description={failureDetail(text.description, reference, messages.errorReference, text.reference)}>
      {text.action === 'none' ? null : <Button variant="outline" disabled={pending} onClick={() => start(() => router.refresh())}>
        <RotateCwIcon aria-hidden="true" className={pending ? 'motion-safe:animate-spin' : undefined} />
        {messages.retry}</Button>}
    </EmptyState>
  </PageContainer>;
}
