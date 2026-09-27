import { Alert, AlertAction, AlertDescription, AlertTitle } from '@rezics/ui/alert';
import { buttonVariants } from '@rezics/ui/button';
import { Skeleton, SkeletonText } from '@rezics/ui/skeleton';
import { cn } from '@rezics/ui/utils';
import { TriangleAlertIcon } from 'lucide-react';
import Link from '../shell/localized-link.tsx';
import type { ReactNode } from 'react';
import type { WorkPageMessages } from './messages.ts';
import { RetryButton } from './retry-button.tsx';
import type { ReadFailure } from './types.ts';

/**
 * One independently loaded part of a Work view, titled by its own heading.
 * Sections sit on the page ground, as Goodreads' do, rather than in cards.
 */
export function Region({ id, title, aside, children, className }: {
  id: string; title: string; aside?: ReactNode; children: ReactNode; className?: string;
}) {
  return <section aria-labelledby={id} className={cn('grid min-w-0 content-start gap-4', className)}>
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <h2 id={id} className="font-semibold text-xl tracking-tight">{title}</h2>
      {aside}
    </div>
    {children}
  </section>;
}

function failureText(failure: ReadFailure, t: WorkPageMessages): string {
  switch (failure) {
    case 'moved': return t.moved;
    case 'budget': return t.budget;
    case 'invalid': return t.invalid;
    case 'missing': return t.regionMissing;
    case 'sign-in': case 'identity': return t.regionDenied;
    case 'unavailable': return t.regionUnavailable;
  }
}

/**
 * A region that could not load says so in place ("Ratings unavailable") with
 * a way forward; the rest of the page is unaffected. A list whose cursor went
 * stale restarts from its first page instead of retrying the same page.
 */
export function RegionFailure({ title, failure, messages, restartHref }: {
  title: string; failure: ReadFailure; messages: WorkPageMessages; restartHref?: string;
}) {
  const restart = restartHref && (failure === 'moved' || failure === 'invalid');
  return <Alert variant="destructive" role="alert">
    <TriangleAlertIcon aria-hidden="true" />
    <AlertTitle>{title}</AlertTitle>
    <AlertDescription>{failureText(failure, messages)}</AlertDescription>
    <AlertAction>
      {restart
        ? <Link href={restartHref} className={buttonVariants({ size: 'sm', variant: 'outline' })}>{messages.firstPage}</Link>
        : <RetryButton label={messages.retry} pendingLabel={messages.retrying} />}
    </AlertAction>
  </Alert>;
}

/** A region's shape while Main answers; its heading is already real. */
export function RegionSkeleton({ id, title, label, lines = 3, className }: {
  id: string; title: string; label: string; lines?: number; className?: string;
}) {
  return <Region id={id} title={title} className={className}>
    <div role="status" aria-label={label} aria-busy="true" className="grid gap-3">
      <Skeleton className="h-8 w-1/3 rounded-lg" />
      <SkeletonText lines={lines} />
    </div>
  </Region>;
}
