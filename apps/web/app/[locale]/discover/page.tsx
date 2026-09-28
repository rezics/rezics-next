import type { Metadata } from 'next';
import { DiscoverPage } from '../../../features/discover/discover-page.tsx';
import type { SearchParams } from '../../../features/discover/scope.ts';
import { parseDiscoverState } from '../../../features/discover/state.ts';
import { Providers } from '../../../features/shell/providers.tsx';
import { getTranslation, requestLocale } from '../../../i18n/server.ts';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getTranslation('discover', [await requestLocale()]);
  return { title: t.title };
}

// The page reads its shelves, rating question and fallbacks itself (`loadDiscoverState`), once.
export default async function DiscoverRoute({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const [params, locale] = await Promise.all([searchParams, requestLocale()]);
  return <Providers>
    <DiscoverPage state={parseDiscoverState(params)} locale={locale} />
  </Providers>;
}
