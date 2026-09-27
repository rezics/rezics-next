import { Badge } from '@rezics/ui/badge';
import { buttonVariants } from '@rezics/ui/button';
import { ListTreeIcon, MessagesSquareIcon } from 'lucide-react';
import Link from 'next/link';
import { EmptyState } from '../shell/empty-state.tsx';
import type { WorkPageMessages } from './messages.ts';
import { workHref } from './route.ts';

/**
 * A Work view whose Main read has not shipped yet. It says so plainly and
 * points somewhere useful instead of showing an empty list that could be
 * mistaken for "this Work has no chapters" or "nobody has discussed it".
 */
export function PendingView({ view, workRef, messages }: {
  view: 'contents' | 'discussion'; workRef: string; messages: WorkPageMessages;
}) {
  const contents = view === 'contents';
  return <EmptyState icon={contents ? ListTreeIcon : MessagesSquareIcon} headingLevel={2}
    title={contents ? messages.contentsPendingTitle : messages.discussionPendingTitle}
    description={contents ? messages.contentsPendingBody : messages.discussionPendingBody}>
    <Badge variant="secondary" size="lg">{messages.notYet}</Badge>
    {contents ? <Link href={workHref(workRef, 'versions')} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
      {messages.versions}</Link> : null}
  </EmptyState>;
}
