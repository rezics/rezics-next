import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { SubjectTermsPage } from '../../features/catalogue/subject-terms-page';
import { loadCatalogueTerms, saveCatalogueTerms } from '../../features/catalogue/subject-terms-actions';
import { readCreateDefinitions } from '../../features/catalogue/create-subject-actions';
import { useSession } from '../../session/query';
import { getLocale } from '../../paraglide/runtime.js';
import { m } from '../../paraglide/messages.js';

export const Route = createFileRoute('/subjects/$id_/$slug_/terms')({
  staticData: { publicCache: false },
  head: () => ({ meta: [{ title: m.catalogue_terms_title() }, { name: 'robots', content: 'noindex,nofollow' }] }),
  component: TermsRoute,
});

function TermsRoute() {
  const { id } = Route.useParams();
  const { state, csrfToken } = useSession();
  const locale = getLocale();
  // Definition metadata and the editor's native read start independently of session preparation.
  const definitions = useQuery({
    queryKey: ['catalogue-create', 'definitions', locale],
    queryFn: () => readCreateDefinitions({ data: false }),
    retry: false,
  });
  const typeLabels = definitions.data?.ok
    ? Object.fromEntries(definitions.data.types.map((type) => [type.id, type.label]))
    : {};
  return (
    <SubjectTermsPage
      key={`${id}:${locale}`}
      id={id}
      locale={locale}
      session={state}
      typeLabels={typeLabels}
      transport={{
        read: (subject, session) => loadCatalogueTerms({ data: { id: subject, ...(session ? { session } : {}) } }),
        submit: (command) => saveCatalogueTerms({ data: command, headers: { 'X-CSRF-Token': csrfToken ?? '' } }),
      }}
    />
  );
}
