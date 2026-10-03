import type { UiLocale } from '../../i18n/define.ts';
import { DiscoverView } from './discover-view.tsx';
import { loadDiscoverState } from './load.ts';
import type { BrowseState } from './browse-state.ts';

export type { DiscoverPageProps } from './discover-view.tsx';

/**
 * The `/discover` route's entry. It reads everything through
 * `loadDiscoverState`: one resource Query, topic suggestions and Main's sections.
 */
export async function DiscoverPage({ state, locale }: { state: BrowseState | null; locale: UiLocale }) {
  return <DiscoverView {...await loadDiscoverState(state, locale)} />;
}
