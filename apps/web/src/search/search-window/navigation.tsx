import { buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { locales } from '../../paraglide/runtime.js';
import type { SearchWindowNavigation } from './use-search-window';

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
  const options = { locale: locales.find((value) => value === locale) ?? 'en' };
  const current = visit.position.current;
  const previous = visit.position.previous;
  const repeated = !!next && !visit.nextAllowed(next);
  const disabled = !enabled || visit.busy;
  const link = (cursor: string | undefined, action: string, label: string) => (
    <a
      href={visit.href(cursor)}
      data-window-action={action}
      className={buttonVariants({ variant: 'outline' })}
      aria-disabled={disabled || undefined}
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
      data-search-windows
      aria-busy={visit.busy || undefined}
      className="space-y-3"
    >
      <p role="status" className="text-sm text-muted-foreground" data-search-window-current>
        {current?.number !== undefined && current.number !== null
          ? m.search_window_current({ number: new Intl.NumberFormat(locale).format(current.number) }, options)
          : cursor
            ? m.search_window_address({}, options)
            : m.search_window_current({ number: new Intl.NumberFormat(locale).format(1) }, options)}
        {query && (
          <>
            {' '}
            · <bdi>{query}</bdi>
          </>
        )}
      </p>
      <div className="flex flex-wrap gap-3">
        {previous && link(previous.cursor ?? undefined, 'previous', m.search_window_previous({}, options))}
        {cursor && link(undefined, 'first', m.search_window_first({}, options))}
        {next && !repeated && link(next, 'next', nextLabel ?? m.search_more({}, options))}
      </div>
      {visit.position.clipped && <p className="text-sm text-muted-foreground">{m.search_window_limit({}, options)}</p>}
      {repeated && (
        <p role="status" className="text-sm text-muted-foreground">
          {m.search_window_repeated({}, options)}
        </p>
      )}
    </nav>
  );
}
