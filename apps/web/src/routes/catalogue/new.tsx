import { createFileRoute } from '@tanstack/react-router';
import { CreateSubjectForm } from '../../features/catalogue/create-subject-form';
import {
  createCatalogueSubject,
  readCreateDefinitions,
  readCreatedCatalogueSubject,
} from '../../features/catalogue/create-subject-actions';
import { useSession } from '../../session/query';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';

export const Route = createFileRoute('/catalogue/new')({
  head: ({ match }) =>
    pageHead({ title: m.catalogue_create_title(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: NewSubjectPage,
});

function NewSubjectPage() {
  const { state, csrfToken } = useSession();
  return (
    <CreateSubjectForm
      locale={getLocale()}
      session={state}
      onNavigate={(href) => window.location.assign(href)}
      transport={{
        definitions: (refresh = false) => readCreateDefinitions({ data: refresh }),
        submit: (command) => createCatalogueSubject({ data: command, headers: { 'X-CSRF-Token': csrfToken ?? '' } }),
        read: (id) => readCreatedCatalogueSubject({ data: id }),
      }}
    />
  );
}
