import type { UiLocale } from '../../i18n/define.ts';
import { DiscoverView } from './discover-view.tsx';
import { loadDiscoverState } from './load.ts';
import type { DiscoverState } from './state.ts';

export type { DiscoverPageProps, LoadedShelf } from './discover-view.tsx';

/**
 * The `/discover` route's entry. It reads everything through
 * `loadDiscoverState`: the shelves, the rating question top-rated shelves
 * rank by, and what to offer when no shelf can show.
 */
export async function DiscoverPage({ state, locale }: { state: DiscoverState | null; locale: UiLocale }) {
  return <DiscoverView {...await loadDiscoverState(state, locale)} />;
}
