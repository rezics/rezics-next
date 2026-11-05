import { createFileRoute, notFound } from '@tanstack/react-router';
import { EditorialContextPage, editorialSubjectSearch } from '../../features/catalogue/editorial-context-route';
import { m } from '../../paraglide/messages.js';

export const Route = createFileRoute('/contexts/$id')({
  staticData: { publicCache: false },
  validateSearch: editorialSubjectSearch,
  beforeLoad: ({ params }) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(params.id)) throw notFound();
  },
  head: () => ({ meta: [{ title: m.editorial_title() }, { name: 'robots', content: 'noindex, nofollow' }] }),
  component: ContextWorkspace,
});
function ContextWorkspace() {
  return <EditorialContextPage id={Route.useParams().id} {...Route.useSearch()} />;
}
