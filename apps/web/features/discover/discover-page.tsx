import type { UiLocale } from '../../i18n/define.ts';
import { DiscoverView } from './discover-view.tsx';
import { loadDiscoverState } from './load.ts';
import type { DiscoverState } from './state.ts';

export type { DiscoverPageProps, LoadedShelf } from './discover-view.tsx';

/**
 * The `/discover` route's entry. It reads everything through
 * `loadDiscoverState`, including the rating question top-rated shelves rank
 * by, which the route does not read; it accepts the props the route passes
 * today and ignores the shelves the route read before.
 */
export async function DiscoverPage({ state, locale }: { state: DiscoverState | null; locale: UiLocale } & Record<string, unknown>) {
  return <DiscoverView {...await loadDiscoverState(state, locale)} />;
}
