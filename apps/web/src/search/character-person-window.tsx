import { buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import { locales } from '../paraglide/runtime.js';
import { characterPersonHref, type ParsedCharacterPersonSearch } from './character-person';
import type { DiscoveryState } from './discovery';

/** Route-owned facts for the shared window adapter; no history or focus mechanism belongs here. */
export function characterPersonWindowFacts(
  locale: string,
  parsed: ParsedCharacterPersonSearch,
  state: DiscoveryState,
  current: () => boolean,
) {
  const firstHref = characterPersonHref(locale, parsed.search);
  return {
    firstHref,
    cursor: parsed.search.cursor,
    href: (cursor?: string) => characterPersonHref(locale, parsed.search, cursor),
    current,
    enabled: !parsed.error && current(),
    ready: state.status === 'ready',
    settled: state.status !== 'loading',
    recoverable: state.status === 'unavailable' || state.status === 'not-ready' || state.status === 'preparing',
    checkpoint: state.status === 'ready' ? state.page.as_of : undefined,
  };
}

/** Native links remain useful while the shared adapter's specialized-route binding is being delivered. */
export function CharacterPersonWindowLinks({
  locale,
  facts,
  next,
}: {
  locale: string;
  facts: ReturnType<typeof characterPersonWindowFacts>;
  next: string | null;
}) {
  const options = { locale: locales.find((value) => value === locale) ?? 'en' };
  const repeated = next === facts.cursor;
  return (
    <nav aria-label={m.search_window_navigation({}, options)} data-character-person-windows className="space-y-3">
      <p role="status" className="text-sm text-muted-foreground" data-search-window-current>
        {facts.cursor
          ? m.search_window_address({}, options)
          : m.search_window_current({ number: new Intl.NumberFormat(locale).format(1) }, options)}
      </p>
      <div className="flex flex-wrap gap-3">
        {facts.cursor && (
          <a className={buttonVariants({ variant: 'outline' })} data-window-action="first" href={facts.firstHref}>
            {m.search_window_first({}, options)}
          </a>
        )}
        {next && !repeated && next.length <= 4864 && (
          <a className={buttonVariants({ variant: 'outline' })} data-window-action="next" href={facts.href(next)}>
            {m.character_person_continue({}, options)}
          </a>
        )}
      </div>
      {repeated && <p role="status">{m.search_window_repeated({}, options)}</p>}
    </nav>
  );
}
