import { useEffect, useRef, type ReactNode } from 'react';
import { CircleAlert, House, LockKeyhole, RotateCw, Search, SearchX } from 'lucide-react';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia } from '@rezics/ui/shadcn/empty';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { cn } from '@rezics/ui/utils';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { PageHeading } from './page-heading';

export type RouteStateKind = 'missing' | 'closed' | 'error';
export const routeStateControl = 'min-h-11 h-auto max-w-full whitespace-normal break-words px-4 py-2 text-center';

/** Route content uses the shared Empty slots; AppShell owns main, skip navigation and providers. */
export function RouteState({ kind = 'error', heading, message, onRetry, retrying = false, retryFailed = false,
  recovery, retryDisabled = false }: {
  kind?: RouteStateKind;
  heading?: string;
  message?: string;
  onRetry?: (() => void) | undefined;
  retrying?: boolean | undefined;
  retryFailed?: boolean;
  recovery?: ReactNode;
  retryDisabled?: boolean;
}) {
  const locale = getLocale();
  const Icon = kind === 'closed' ? LockKeyhole : kind === 'missing' ? SearchX : CircleAlert;
  const title = heading ?? (kind === 'closed' ? m.platform_closed_heading() : kind === 'missing' ? m.not_found_heading() : m.error_heading());
  const description = message ?? (kind === 'closed' ? m.platform_closed_message() : kind === 'missing' ? m.not_found_message() : m.route_error_description());
  const section = useRef<HTMLElement>(null);
  // Replacing a focused route control must not leave focus on body. Existing chrome focus stays put.
  useEffect(() => {
    if (document.activeElement === document.body)
      document.getElementById('main-content')?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    if (retryFailed && section.current?.contains(document.activeElement))
      section.current.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
  }, [retryFailed]);
  return (
    <section ref={section} data-route-state={kind} className="mx-auto w-full min-w-0 py-4 md:py-10">
      <Empty className="min-h-80 border border-border bg-card px-4 py-8 md:min-h-96 md:px-10 md:py-14">
        <EmptyHeader className="max-w-xl gap-4">
          <EmptyMedia variant="icon" className="size-14 rounded-2xl bg-muted text-muted-foreground">
            <Icon aria-hidden="true" className="size-7" />
          </EmptyMedia>
          <PageHeading className="max-w-full break-words text-2xl md:text-3xl">{title}</PageHeading>
          <EmptyDescription className="max-w-prose break-words text-base leading-7">{description}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="max-w-xl gap-4">
          {recovery ? <p className="max-w-prose break-words text-sm text-muted-foreground">{recovery}</p> : null}
          <p role="status" aria-live="polite" aria-atomic="true" className={retrying || retryFailed ? 'text-sm text-muted-foreground' : 'sr-only'}>
            {retrying ? m.status_retrying() : retryFailed ? m.route_retry_failed() : ''}
          </p>
          <div className="flex w-full flex-col items-stretch gap-2 sm:w-auto sm:flex-row sm:flex-wrap sm:justify-center">
            {onRetry ? <Button size="lg" className={routeStateControl} onClick={onRetry}
              disabled={retrying || retryDisabled} aria-busy={retrying}>
              <RotateCw aria-hidden="true" className={retrying ? 'size-4 motion-safe:animate-spin motion-reduce:animate-none' : 'size-4'} />
              {retrying ? m.status_retrying() : m.status_retry()}
            </Button> : null}
            <a data-slot="button" className={cn(buttonVariants({ size: 'lg', variant: onRetry ? 'outline' : 'default' }), routeStateControl)} href={`/${locale}`}>
              <House aria-hidden="true" className="size-4" />{m.status_home()}
            </a>
            <a data-slot="button" className={cn(buttonVariants({ size: 'lg', variant: 'outline' }), routeStateControl)} href={`/${locale}/search`}>
              <Search aria-hidden="true" className="size-4" />{m.status_search()}
            </a>
          </div>
        </EmptyContent>
      </Empty>
    </section>
  );
}
