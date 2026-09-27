'use client';

import { Skeleton } from '@rezics/ui/skeleton';
import { useTranslation } from '../../i18n/client.ts';

/** Placeholder for an auth card while its page loads. */
export function AuthSkeleton() {
  const { t } = useTranslation('common');
  return <div role="status" aria-label={t.loading} className="flex flex-col gap-6">
    <Skeleton className="h-8 w-40" /><Skeleton className="h-5 w-64" />
    <Skeleton className="h-10 w-full" />
    <div className="flex justify-between"><Skeleton className="h-9 w-28" /><Skeleton className="h-10 w-24" /></div>
  </div>;
}

/** Placeholder for an account section while its reads finish. */
export function SectionSkeleton() {
  const { t } = useTranslation('common');
  return <div role="status" aria-label={t.loading} className="flex flex-col gap-6">
    <div className="flex flex-col gap-3"><Skeleton className="h-9 w-56" /><Skeleton className="h-5 w-80 max-w-full" /></div>
    {[0, 1].map(card => <div key={card}
      className="flex flex-col gap-4 rounded-3xl border border-border/60 bg-card p-6 shadow-(--aura-shadow-card)">
      <Skeleton className="h-6 w-40" />
      {[0, 1, 2].map(row => <div key={row} className="flex items-center gap-4">
        <Skeleton className="size-10 rounded-full" /><div className="flex flex-1 flex-col gap-2">
          <Skeleton className="h-4 w-1/2" /><Skeleton className="h-4 w-1/3" /></div></div>)}
    </div>)}
  </div>;
}
