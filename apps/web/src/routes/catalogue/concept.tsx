import { createFileRoute } from '@tanstack/react-router';
import { ConceptCreateSession } from '../../features/catalogue/concept-create-session';
import { loadConceptCreate } from '../../features/catalogue/concept-create-actions';
import { classificationHandoffSearch } from '../../features/catalogue/classification-create-return';
import { getLocale } from '../../paraglide/runtime';
import { m } from '../../paraglide/messages.js';

export const Route = createFileRoute('/catalogue/concept')({
  staticData: { publicCache: false },
  validateSearch: (search: Record<string, unknown>) => ({
    classificationHandoff: classificationHandoffSearch(search),
  }),
  loader: () => loadConceptCreate({ data: false }),
  head: () => ({ meta: [{ title: m.concept_create_title() }, { name: 'robots', content: 'noindex, nofollow' }] }),
  component: () => {
    const { classificationHandoff } = Route.useSearch();
    return (
      <ConceptCreateSession
        key={classificationHandoff ?? ''}
        locale={getLocale()}
        initial={Route.useLoaderData()}
        {...(classificationHandoff ? { token: classificationHandoff } : {})}
      />
    );
  },
});
