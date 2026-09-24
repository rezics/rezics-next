import { Providers } from '../../features/shell/providers.tsx';
import { SearchExplorer } from '../../features/search/search-explorer.tsx';
import { getTranslation, requestLocale } from '../../i18n/server.ts';

export default async function SearchPage({ searchParams }: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const locale = await requestLocale();
  const { data: messages } = await getTranslation('search', [locale]);
  return <main className="page-width"><Providers><SearchExplorer initialPhrase={q ?? ''}
    locale={locale} messages={messages} /></Providers></main>;
}
