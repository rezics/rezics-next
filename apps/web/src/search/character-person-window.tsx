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
    preparing: state.status === 'preparing',
    recoverable: state.status === 'unavailable' || state.status === 'not-ready' || state.status === 'preparing',
    checkpoint: state.status === 'ready' ? state.page.as_of : undefined,
  };
}
