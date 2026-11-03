import { createFileRoute, notFound } from '@tanstack/react-router';
import { SourceConceptSession } from '../../features/catalogue/source-concept-explorer/session';
import { getLocale } from '../../paraglide/runtime.js';
import { m } from '../../paraglide/messages.js';

export const Route = createFileRoute('/subjects/$id_/$slug/concepts')({
  staticData: { publicCache: false },
  validateSearch: (search: Record<string, unknown>) => {
    const role = search.role;
    const returnTo = search.returnTo;
    if (role !== undefined && (typeof role !== 'string' || role.length > 128)) throw notFound();
    if (returnTo !== undefined && (typeof returnTo !== 'string' || returnTo.length > 2048 || !returnTo.startsWith('/')))
      throw notFound();
    return {
      role: typeof role === 'string' ? role : undefined,
      returnTo: typeof returnTo === 'string' ? returnTo : undefined,
    };
  },
  head: () => ({ meta: [{ title: m.concept_explore_title() }, { name: 'robots', content: 'noindex,follow' }] }),
  component: ConceptsRoute,
});

function ConceptsRoute() {
  const { id } = Route.useParams();
  const { role, returnTo } = Route.useSearch();
  return <SourceConceptSession key={`${id}:${getLocale()}`} id={id} locale={getLocale()} role={role} returnTo={returnTo} />;
}
