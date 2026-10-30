import { createFileRoute } from '@tanstack/react-router';
import { PublicationEditor } from '../../features/catalogue/publication-editor-form';
import { createWorkPublication, loadPublicationEditor } from '../../features/catalogue/publication-editor-actions';
import { readCreatedCatalogueSubject } from '../../features/catalogue/create-subject-actions';
import { relationTargetSearch } from '../../features/catalogue/relation-editor-search';
import { publicationUuid } from '../../features/catalogue/publication-editor';
import { useSession } from '../../session/query';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';

export const Route = createFileRoute('/catalogue/publication')({
  validateSearch: (search: Record<string, unknown>) => ({
    work: typeof search.work === 'string' && publicationUuid.test(search.work) ? search.work : '',
  }),
  head: ({ match }) =>
    pageHead({ title: m.publication_add(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: PublicationRoute,
});

function PublicationRoute() {
  const { work } = Route.useSearch();
  const { state, csrfToken } = useSession();
  const locale = getLocale();
  return (
    <PublicationEditor
      key={work}
      work={work}
      locale={locale}
      session={state}
      onNavigate={(href) => window.location.assign(href)}
      search={(text, signal) => relationTargetSearch(text, signal, locale)}
      transport={{
        load: () => loadPublicationEditor({ data: work }),
        submit: (command) => createWorkPublication({ data: command, headers: { 'X-CSRF-Token': csrfToken ?? '' } }),
        read: (id) => readCreatedCatalogueSubject({ data: id }),
      }}
    />
  );
}
