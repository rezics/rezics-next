import { createFileRoute } from '@tanstack/react-router';
import { SearchHistoryPage } from '../search/recent';
export const Route = createFileRoute('/search_/history')({
  staticData: { publicCache: false },
  head: () => ({ meta: [{ name: 'robots', content: 'noindex, nofollow' }] }),
  component: SearchHistoryPage,
});
