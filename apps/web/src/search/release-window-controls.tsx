import { buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import { locales } from '../paraglide/runtime.js';
import type { SearchWindowNavigation } from './search-window';

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
  const options = { locale: locales.find((value) => value === locale) ?? 'en' };
  const repeated = !!next && !visit.nextAllowed(next);
  const disabled = !enabled || visit.busy;
  const link = (target: string | undefined, action: string, label: string) => (
    <a
      href={visit.href(target)}
      data-window-action={action}
      className={buttonVariants({ variant: 'outline' })}
      aria-disabled={disabled || undefined}
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
      aria-busy={visit.busy || undefined}
      className="space-y-3"
      data-release-group-windows
    >
      <p id="release-group-window-status" role="status" className="text-sm text-muted-foreground">
        {number != null
          ? m.release_search_window_current({ number: new Intl.NumberFormat(locale).format(number) }, options)
          : m.release_search_window_address({}, options)}
      </p>
      <div className="flex flex-wrap gap-3">
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
        <p className="text-sm text-muted-foreground">{m.release_search_window_limit({}, options)}</p>
      )}
      {repeated && (
        <p role="status" className="text-sm text-muted-foreground">
          {m.release_search_window_repeated({}, options)}
        </p>
      )}
    </nav>
  );
}
