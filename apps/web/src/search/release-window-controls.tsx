import { useId } from 'react';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { cn } from '@rezics/ui/utils';
import { m } from '../paraglide/messages.js';
import { locales } from '../paraglide/runtime.js';
import type { SearchWindowNavigation } from './search-window';

const windowActionClass =
  'h-auto min-h-11 min-w-0 max-w-full whitespace-normal text-start wrap-anywhere';

/** Group addresses are distinct from each work's independent child-release window. */
export function ReleaseWindowControls({
  visit,
  locale,
  cursor,
  next,
  status,
  enabled,
}: {
  visit: SearchWindowNavigation;
  locale: string;
  cursor?: string | undefined;
  next: string | null;
  status: string;
  enabled: boolean;
}) {
  const id = useId();
  const currentId = `${id}-current`;
  const limitId = `${id}-limit`;
  const repeatedId = `${id}-repeated`;
  const options = { locale: locales.find((value) => value === locale) ?? 'en' };
  const repeated = !!next && !visit.nextAllowed(next);
  const disabled = !enabled || visit.busy;
  const describedBy = [currentId, visit.position.clipped ? limitId : undefined, repeated ? repeatedId : undefined]
    .filter(Boolean)
    .join(' ');
  const link = (target: string | undefined, action: string, label: string) => (
    <a
      href={visit.href(target)}
      data-window-action={action}
      className={cn(buttonVariants({ variant: 'outline' }), windowActionClass)}
      aria-disabled={disabled || undefined}
      aria-describedby={currentId}
      onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        if (disabled) event.preventDefault();
        else visit.activate(event, target, action);
      }}
    >
      {label}
    </a>
  );
  const number = visit.position.current?.number;
  return (
    <nav
      ref={visit.navigationRef}
      aria-label={m.release_search_pagination({}, options)}
      aria-describedby={describedBy}
      aria-busy={visit.busy || undefined}
      className="min-w-0 space-y-3"
      data-release-group-windows
    >
      <p id={currentId} role="status" className="min-w-0 text-sm text-muted-foreground wrap-anywhere">
        {number != null
          ? m.release_search_window_current({ number: new Intl.NumberFormat(locale).format(number) }, options)
          : m.release_search_window_address({}, options)}
      </p>
      <div className="flex min-w-0 flex-wrap gap-3">
        {visit.position.previous &&
          link(visit.position.previous.cursor ?? undefined, 'previous', m.release_search_window_previous({}, options))}
        {(cursor || repeated || status === 'restart') &&
          link(undefined, 'first', m.release_search_window_first({}, options))}
        {next &&
          !repeated &&
          link(
            next,
            status === 'preparing' ? 'retry' : 'next',
            status === 'preparing' ? m.search_facet_retry({}, options) : m.release_search_continue({}, options),
          )}
        {status === 'unavailable' && link(cursor, 'retry', m.search_facet_retry({}, options))}
      </div>
      {visit.position.clipped && (
        <p id={limitId} className="min-w-0 text-sm text-muted-foreground wrap-anywhere">
          {m.release_search_window_limit({}, options)}
        </p>
      )}
      {repeated && (
        <p id={repeatedId} role="status" className="min-w-0 text-sm text-muted-foreground wrap-anywhere">
          {m.release_search_window_repeated({}, options)}
        </p>
      )}
    </nav>
  );
}
