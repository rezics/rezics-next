import { buttonVariants } from '@rezics/ui/button';
import { Skeleton, SkeletonText } from '@rezics/ui/skeleton';
import { BookXIcon, TriangleAlertIcon } from 'lucide-react';
import Link from 'next/link';
import { EmptyState } from '../shell/empty-state.tsx';
import { PageContainer } from '../shell/page.tsx';
import type { WorkPageMessages } from './messages.ts';
import { RetryButton } from './retry-button.tsx';

/** No Work has this address, or it is private to others: Main answers both with 404. */
export function WorkNotFound({ messages }: { messages: WorkPageMessages }) {
  return <PageContainer>
    <EmptyState icon={BookXIcon} headingLevel={1} title={messages.notFoundTitle} description={messages.notFoundBody}>
      <Link href="/search" className={buttonVariants()}>{messages.searchWorks}</Link>
    </EmptyState>
  </PageContainer>;
}

/** Main could not answer for the Work itself; nothing on the page can be shown. */
export function WorkUnavailable({ messages }: { messages: WorkPageMessages }) {
  return <PageContainer>
    <EmptyState icon={TriangleAlertIcon} tone="destructive" role="alert" headingLevel={1}
      title={messages.unavailableTitle} description={messages.unavailableBody}>
      <RetryButton label={messages.retry} pendingLabel={messages.retrying} />
      <Link href="/search" className={buttonVariants({ variant: 'outline', size: 'sm' })}>{messages.searchWorks}</Link>
    </EmptyState>
  </PageContainer>;
}

/** A Work view's content while it loads under an already shown header. */
export function WorkViewSkeleton({ label }: { label: string }) {
  return <div role="status" aria-label={label} aria-busy="true" className="grid gap-6">
    <Skeleton className="h-11 w-72 max-w-full rounded-2xl" />
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
      <div className="grid gap-3 rounded-2xl border border-border/60 bg-card/70 p-6">
        <Skeleton className="h-6 w-32 rounded-lg" /><Skeleton className="h-10 w-24 rounded-lg" /><SkeletonText lines={5} />
      </div>
      <div className="grid gap-3 rounded-2xl border border-border/60 bg-card/70 p-6">
        <Skeleton className="h-6 w-36 rounded-lg" /><SkeletonText lines={3} />
      </div>
    </div>
  </div>;
}

/** The whole Work page's shape while its record loads. */
export function WorkSkeleton({ label }: { label: string }) {
  return <PageContainer role="status" aria-label={label} aria-busy="true" className="grid gap-6">
    <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-4 rounded-3xl border border-border/60 bg-card/70 p-4
      sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-6 sm:p-6 lg:grid-cols-[11rem_minmax(0,1fr)] lg:p-8">
      <Skeleton className="aspect-[2/3] w-full rounded-xl" />
      <div className="grid content-start gap-3">
        <div className="flex gap-2"><Skeleton className="h-6 w-14 rounded-full" /><Skeleton className="h-6 w-16 rounded-full" /></div>
        <Skeleton className="h-10 w-3/4 rounded-xl" />
        <Skeleton className="h-5 w-1/2 rounded-md" />
        <Skeleton className="mt-2 h-10 w-28 rounded-xl" />
      </div>
    </div>
    <Skeleton className="h-11 w-full rounded-lg" />
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <Skeleton className="h-64 rounded-2xl" /><Skeleton className="h-40 rounded-2xl" />
    </div>
  </PageContainer>;
}

/** A chapter's shape while Main answers: the way back, a title and paragraphs. */
export function ChapterSkeleton({ label }: { label: string }) {
  return <div role="status" aria-label={label} aria-busy="true" className="mx-auto grid w-full max-w-5xl gap-6 px-4
    py-6 sm:px-6 lg:py-10">
    <div className="flex justify-between"><Skeleton className="h-8 w-48 rounded-xl" /><Skeleton className="h-8 w-28 rounded-xl" /></div>
    <div className="mx-auto grid w-full max-w-[40rem] gap-4">
      <Skeleton className="h-9 w-2/3 rounded-xl" />
      <SkeletonText lines={4} /><SkeletonText lines={5} /><SkeletonText lines={3} />
    </div>
  </div>;
}
