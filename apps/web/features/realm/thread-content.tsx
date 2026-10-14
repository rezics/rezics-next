import { buttonVariants } from '@rezics/ui/button';
import { RotateCwIcon, TriangleAlertIcon } from 'lucide-react';
import { Skeleton, SkeletonText } from '@rezics/ui/skeleton';
import { materializeData } from 'native-i18n';
import type { FeedMessages } from '../feed/messages.ts';
import type { ThreadRead, ThreadSort } from '../feed/thread.ts';
import { failureText, type Loaded } from '../feed/types.ts';
import { signInPath } from '../auth/paths.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { EmptyState, failureDetail } from '../shell/empty-state.tsx';
import LocalizedLink from '../shell/localized-link.tsx';
import type { UiLocale } from '../../i18n/define.ts';
import type { RealmMessages } from './messages.ts';
import type { ReplyMode } from '../feed/reply-composer.tsx';
import { RealmNotFound } from './states.tsx';
import type { ThreadViewProps } from './thread-view.tsx';
import { ThreadView } from './thread-view.tsx';

/** A thread's shape while Main answers: the post, then a few replies, in the page's rhythm. */
export function ThreadSkeleton() {
  return (
    <div aria-busy="true" className="grid gap-6">
      <Skeleton className="h-4 w-40 rounded-full" />
      <div className="grid gap-3">
        <div className="flex items-center gap-2">
          <Skeleton className="size-8 rounded-full" />
          <Skeleton className="h-3 w-44 rounded-full" />
        </div>
        <Skeleton className="h-7 w-4/5 rounded-full" />
        <SkeletonText lines={3} />
        <Skeleton className="h-9 w-56 rounded-full" />
      </div>
      <div className="grid gap-5 border-border/60 border-t pt-5">
        <Skeleton className="h-11 w-full rounded-2xl" />
        {[0, 1, 2].map((index) => (
          <div key={index} className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-2 gap-y-2">
            <Skeleton className="size-7 rounded-full" />
            <Skeleton className="h-3 w-36 self-center rounded-full" />
            <span />
            <SkeletonText lines={2} />
          </div>
        ))}
      </div>
    </div>
  );
}

export function RealmThreadContent({
  realm,
  locale,
  messages,
  sort,
  here,
  feed,
  language,
  read,
  replyMode,
  threadApi,
  readPage,
}: {
  realm: { id: string; name: string; path: string };
  locale: UiLocale;
  messages: RealmMessages;
  sort: ThreadSort;
  here: string;
  feed: FeedMessages;
  language?: string;
  read: Loaded<ThreadRead>;
  replyMode: ReplyMode;
  threadApi?: ThreadViewProps['threadApi'];
  readPage?: ThreadViewProps['readPage'];
}) {
  const t = materializeData(feed, { locale });
  const sortHrefs = Object.fromEntries(
    (['best', 'top', 'new'] as const).map((option) => {
      const query = new URLSearchParams();
      if (option !== 'best') query.set('sort', option);
      if (language) query.set('language', language);
      return [option, `${here}${query.size ? `?${query}` : ''}`];
    }),
  ) as Record<ThreadSort, string>;
  if (!read.ok) {
    if (read.failure === 'missing') return <RealmNotFound messages={messages} />;
    const text = failureText(read.failure, { failedTitle: t.threadFailed, offline: t.threadFailedBody, server: t.serverBody,
      missingTitle: t.threadFailed, missingBody: t.missingBody, deniedTitle: t.deniedTitle, deniedBody: t.deniedBody,
      movedTitle: t.moved, movedBody: t.movedBody, budget: t.budgetBody });
    if (text.kind === 'absent') return null;
    const quiet = text.action === 'none' || text.action === 'sign-in';
    return (
      <EmptyState
        icon={TriangleAlertIcon}
        tone={quiet ? 'default' : 'destructive'}
        role={quiet ? 'status' : 'alert'}
        headingLevel={1}
        title={text.title}
        description={failureDetail(text.description, read.reference, t.errorReference, text.reference)}
      >
        {text.action === 'none' ? null : text.action === 'sign-in'
          ? <LocalizedLink href={signInPath(localizedPath(here, locale))} className={buttonVariants()}>{t.signIn}</LocalizedLink>
          : <LocalizedLink href={sortHrefs[sort]} className={buttonVariants({ variant: 'outline' })}>
            <RotateCwIcon aria-hidden="true" />
            {text.action === 'restart' ? t.refresh : t.retry}
          </LocalizedLink>}
      </EmptyState>
    );
  }
  return (
    <ThreadView
      read={read.data}
      sort={sort}
      sortHrefs={sortHrefs}
      replyMode={replyMode}
      realm={realm}
      threadApi={threadApi}
      readPage={readPage}
    />
  );
}

