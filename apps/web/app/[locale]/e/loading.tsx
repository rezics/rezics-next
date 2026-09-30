'use client';

import { Skeleton, SkeletonText } from '@rezics/ui/skeleton';
import { PageContainer } from '../../../features/shell/page.tsx';
import { useShell } from '../../../features/shell/shell-provider.tsx';

export default function Loading() {
  return <PageContainer role="status" aria-label={useShell().t.loading} aria-busy="true" className="grid max-w-4xl gap-8">
    <div className="flex items-center gap-4">
      <Skeleton className="size-16 rounded-[22%] sm:size-20" />
      <div className="grid flex-1 gap-2"><Skeleton className="h-4 w-20 rounded-md" /><Skeleton className="h-9 w-2/3 rounded-xl" /></div>
    </div>
    <SkeletonText lines={4} />
    <SkeletonText lines={3} />
  </PageContainer>;
}
