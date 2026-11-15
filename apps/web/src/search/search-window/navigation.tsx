import { useId } from 'react';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { cn } from '@rezics/ui/utils';
import { m } from '../../paraglide/messages.js';
import { locales } from '../../paraglide/runtime.js';
import type { SearchWindowNavigation } from './use-search-window';

const windowActionClass =
  'h-auto min-h-11 min-w-0 max-w-full whitespace-normal text-start wrap-anywhere';

/** Window numbers describe admitted addresses, never result offsets or totals. */
export function SearchWindowControls({
  window: visit,
  cursor,
  query,
  locale,
  next,
  nextLabel,
  enabled = true,
}: {
  window: SearchWindowNavigation;
  cursor: string | undefined;
  query?: string | undefined;
  locale: string;
  next?: string | null | undefined;
  nextLabel?: string | undefined;
  enabled?: boolean;
}) {
  const id = useId();
  const currentId = `${id}-current`;
  const limitId = `${id}-limit`;
  const repeatedId = `${id}-repeated`;
  const options = { locale: locales.find((value) => value === locale) ?? 'en' };
  const current = visit.position.current;
  const previous = visit.position.previous;
  const repeated = !!next && !visit.nextAllowed(next);
  const disabled = !enabled || visit.busy;
  const describedBy = [currentId, visit.position.clipped ? limitId : undefined, repeated ? repeatedId : undefined]
    .filter(Boolean)
    .join(' ');
  const link = (cursor: string | undefined, action: string, label: string) => (
    <a
      href={visit.href(cursor)}
      data-window-action={action}
      className={cn(buttonVariants({ variant: 'outline' }), windowActionClass)}
      aria-disabled={disabled || undefined}
      aria-describedby={currentId}
      onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        if (disabled) event.preventDefault();
        else visit.activate(event, cursor, action);
      }}
    >
      {label}
    </a>
  );
  return (
    <nav
      ref={visit.navigationRef}
      aria-label={m.search_window_navigation({}, options)}
      aria-describedby={describedBy}
      data-search-windows
      aria-busy={visit.busy || undefined}
      className="min-w-0 space-y-3 rounded-xl border border-border/60 p-4"
    >
      <h2 className="min-w-0 text-sm font-medium wrap-anywhere">{m.search_window_navigation({}, options)}</h2>
      <p
        id={currentId}
        role="status"
        className="min-w-0 text-sm text-muted-foreground wrap-anywhere"
        data-search-window-current
      >
        {current?.number !== undefined && current.number !== null
          ? m.search_window_current({ number: new Intl.NumberFormat(locale).format(current.number) }, options)
          : cursor
            ? m.search_window_address({}, options)
            : m.search_window_current({ number: new Intl.NumberFormat(locale).format(1) }, options)}
        {query && (
          <>
            {' '}
            · <bdi className="wrap-anywhere">{query}</bdi>
          </>
        )}
      </p>
      <div className="flex min-w-0 flex-wrap gap-3">
        {previous && link(previous.cursor ?? undefined, 'previous', m.search_window_previous({}, options))}
        {cursor && link(undefined, 'first', m.search_window_first({}, options))}
        {next && !repeated && link(next, 'next', nextLabel ?? m.search_more({}, options))}
      </div>
      {visit.position.clipped && (
        <p id={limitId} className="min-w-0 text-sm text-muted-foreground wrap-anywhere">
          {m.search_window_limit({}, options)}
        </p>
      )}
      {repeated && (
        <p id={repeatedId} role="status" className="min-w-0 text-sm text-muted-foreground wrap-anywhere">
          {m.search_window_repeated({}, options)}
        </p>
      )}
    </nav>
  );
}
