import type { Metadata } from 'next';
import { DiscoverPage } from '../../../features/discover/discover-page.tsx';
import type { SearchParams } from '../../../features/discover/scope.ts';
import { parseBrowseState } from '../../../features/discover/browse-state.ts';
import { readTypes } from '../../../features/catalogue/types-read.ts';
import { Providers } from '../../../features/shell/providers.tsx';
import { getTranslation, requestLocale } from '../../../i18n/server.ts';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getTranslation('discover', [await requestLocale()]);
  return { title: t.title };
}

// Main owns the browse population, selection and section reasons.
export default async function DiscoverRoute({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  // Layout and page can render concurrently; validate category URLs only after the registry is read.
  const [params, locale] = await Promise.all([searchParams, requestLocale(), readTypes()]);
  return (
    <Providers>
      <DiscoverPage state={parseBrowseState(params)} locale={locale} />
    </Providers>
  );
}
