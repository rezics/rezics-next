'use client';

import { Button, buttonVariants } from '@rezics/ui/button';
import { Skeleton, SkeletonText } from '@rezics/ui/skeleton';
import { RotateCwIcon, SearchXIcon, TriangleAlertIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { EmptyState } from './empty-state.tsx';
import { plannedItem } from './navigation.ts';
import { PageContainer } from './page.tsx';
import { useShell } from './shell-provider.tsx';
import { localizedPath } from '../../i18n/locale.ts';

/** app/not-found: a planned navigation route shows what is coming; anything else is missing. */
export function RouteNotFound() {
  const { locale, t } = useShell();
  const planned = plannedItem(usePathname());
  if (planned?.planned) {
    return <PageContainer>
      <EmptyState icon={planned.icon} headingLevel={1}
        title={t.comingSoonTitle({ feature: planned.label[locale] })} description={planned.planned[locale]}>
        <Link href={localizedPath('/', locale)} className={buttonVariants({ variant: 'outline' })}>{t.backHome}</Link>
      </EmptyState>
    </PageContainer>;
  }
  return <PageContainer>
    <EmptyState icon={SearchXIcon} headingLevel={1} title={t.notFoundTitle} description={t.notFoundBody}>
      <Link href={localizedPath('/', locale)} className={buttonVariants()}>{t.backHome}</Link>
      <Link href={localizedPath('/discover', locale)} className={buttonVariants({ variant: 'outline' })}>{t.searchWorks}</Link>
    </EmptyState>
  </PageContainer>;
}

/** app/error: the route failed to render. `digest` identifies the server log entry. */
export function RouteError({ digest, onRetry }: { digest?: string; onRetry: () => void }) {
  const { t, locale } = useShell();
  return <PageContainer>
    <EmptyState icon={TriangleAlertIcon} tone="destructive" role="alert" headingLevel={1}
      title={t.errorTitle} description={t.errorBody}>
      <Button onClick={onRetry}><RotateCwIcon aria-hidden="true" />{t.retry}</Button>
      <Link href={localizedPath('/', locale)} className={buttonVariants({ variant: 'outline' })}>{t.backHome}</Link>
    </EmptyState>
    {digest ? <p className="mt-3 text-center text-muted-foreground text-xs">
      {t.errorReference}: <span className="font-mono">{digest}</span></p> : null}
  </PageContainer>;
}

/** app/loading: a neutral page skeleton while a route streams in. */
export function RouteLoading() {
  const { t } = useShell();
  return <PageContainer role="status" aria-label={t.loading} aria-busy="true">
    <Skeleton className="h-9 w-2/3 max-w-md rounded-xl" />
    <SkeletonText lines={2} className="mt-4 max-w-2xl" />
    <div className="mt-8 grid gap-4 sm:grid-cols-2">
      <Skeleton className="h-40 rounded-2xl" />
      <Skeleton className="h-40 rounded-2xl" />
    </div>
  </PageContainer>;
}
