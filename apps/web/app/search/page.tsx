import { Providers } from '../../features/shell/providers.tsx';
import { SearchExplorer } from '../../features/search/search-explorer.tsx';

export default async function SearchPage({ searchParams }: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  return <main className="page-width"><Providers><SearchExplorer initialPhrase={q ?? ''} /></Providers></main>;
}
