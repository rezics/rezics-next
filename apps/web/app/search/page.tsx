import type { Metadata } from 'next';
import { SearchExplorer } from '../../features/search/search-explorer.tsx';
import { Providers } from '../../features/shell/providers.tsx';
import { getMessages, getTranslation, requestLocale } from '../../i18n/server.ts';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getTranslation('search', [await requestLocale()]);
  return { title: t.title };
}

export default async function SearchPage({ searchParams }: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const locale = await requestLocale();
  const messages = await getMessages('search', locale);
  return <Providers><SearchExplorer initialPhrase={q ?? ''} locale={locale} messages={messages} /></Providers>;
}
