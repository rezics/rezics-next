import { createFileRoute } from '@tanstack/react-router';
import { SubjectTermsSession } from '../../features/catalogue/subject-terms-session';
import { getLocale } from '../../paraglide/runtime.js';
import { m } from '../../paraglide/messages.js';

export const Route = createFileRoute('/subjects/$id_/$slug_/terms')({
  staticData: { publicCache: false },
  validateSearch: (input: Record<string, unknown>) => ({
    returnToChanges: input.returnTo === 'changes' ? true : undefined,
  }),
  head: () => ({ meta: [{ title: m.catalogue_terms_title() }, { name: 'robots', content: 'noindex,nofollow' }] }),
  component: TermsRoute,
});

function TermsRoute() {
  const { id } = Route.useParams();
  const { returnToChanges } = Route.useSearch();
  return <SubjectTermsSession id={id} locale={getLocale()} returnToChanges={returnToChanges} />;
}
