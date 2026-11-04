import { createFileRoute, notFound } from '@tanstack/react-router';
import { SourceConceptSession } from '../../features/catalogue/source-concept-explorer/session';
import { getLocale } from '../../paraglide/runtime.js';
import { originatingClassification } from '../../features/pages/source-concept-reading/origin';
import { m } from '../../paraglide/messages.js';

export const Route = createFileRoute('/subjects/$id_/$slug/concepts')({
  staticData: { publicCache: false },
  validateSearch: (search: Record<string, unknown>) => {
    const role = search.role;
    const returnTo = search.returnTo;
    const pin = search.pin;
    if (role !== undefined && (typeof role !== 'string' || role.length > 128)) throw notFound();
    if (returnTo !== undefined && !originatingClassification(returnTo)) throw notFound();
    if (pin !== undefined && (typeof pin !== 'string' || pin.length > 128)) throw notFound();
    return {
      role: typeof role === 'string' ? role : undefined,
      returnTo: originatingClassification(returnTo),
      pinUnsupported: pin !== undefined,
    };
  },
  head: () => ({ meta: [{ title: m.concept_explore_title() }, { name: 'robots', content: 'noindex,follow' }] }),
  component: ConceptsRoute,
});

function ConceptsRoute() {
  const { id } = Route.useParams();
  const { role, returnTo, pinUnsupported } = Route.useSearch();
  return (
    <SourceConceptSession
      key={JSON.stringify([id, getLocale(), role])}
      id={id}
      locale={getLocale()}
      role={role}
      returnTo={returnTo}
      pinUnsupported={pinUnsupported}
    />
  );
}
