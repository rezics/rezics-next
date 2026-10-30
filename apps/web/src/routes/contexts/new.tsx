import { createFileRoute } from '@tanstack/react-router';
import { EditorialContextPage, editorialSubjectSearch } from '../../features/catalogue/editorial-context-route';
import { m } from '../../paraglide/messages.js';

export const Route = createFileRoute('/contexts/new')({
  staticData: { publicCache: false },
  validateSearch: editorialSubjectSearch,
  head: () => ({ meta: [{ title: m.editorial_create() }, { name: 'robots', content: 'noindex, nofollow' }] }),
  component: NewContext,
});
function NewContext() {
  return <EditorialContextPage {...Route.useSearch()} />;
}
