import { buttonVariants } from '@rezics/ui/button';
import { Skeleton, SkeletonText } from '@rezics/ui/skeleton';
import { FileQuestionIcon } from 'lucide-react';
import { EmptyState } from '../shell/empty-state.tsx';
import { PageContainer } from '../shell/page.tsx';
import Link from '../shell/localized-link.tsx';
import type { WorkMessages } from './messages.ts';

/** No revision has this ID (Main answered 404, or the ID is malformed). */
export function WorkNotFound({ messages }: { messages: WorkMessages }) {
  return <PageContainer>
    <EmptyState icon={FileQuestionIcon} headingLevel={1} title={messages.notFoundTitle}
      description={messages.notFoundBody}>
      <Link href="/search" className={buttonVariants()}>{messages.searchWorks}</Link>
    </EmptyState>
  </PageContainer>;
}

/** The revision page's shape while Main answers. */
export function WorkDetailSkeleton({ label }: { label: string }) {
  return <PageContainer role="status" aria-label={label} aria-busy="true" className="grid gap-8">
    <div className="grid gap-4 rounded-3xl border border-border/60 bg-card/70 p-6 sm:p-8">
      <div className="flex gap-2"><Skeleton className="h-6 w-28 rounded-full" /><Skeleton className="h-6 w-12 rounded-full" /></div>
      <Skeleton className="h-10 w-3/4 rounded-xl" />
    </div>
    <Skeleton className="h-9 w-40 rounded-xl" />
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="grid gap-3 rounded-2xl border border-border/60 bg-card/70 p-6">
        <Skeleton className="h-6 w-40 rounded-lg" /><SkeletonText lines={3} />
      </div>
      <div className="grid gap-3 rounded-2xl border border-border/60 bg-card/70 p-6">
        <Skeleton className="h-6 w-36 rounded-lg" /><SkeletonText lines={5} />
      </div>
    </div>
  </PageContainer>;
}
