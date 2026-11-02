import { candidateSession } from '../../subject/candidate-lifetime';
import { editorRequest } from '../../features/catalogue/editor-request';
import { useCatalogueLifetime } from '../../subject/candidate-lifetime';
import { createFileRoute } from '@tanstack/react-router';
import { CreateSubjectForm } from '../../features/catalogue/create-subject-form';
import { createCatalogueSubject, readCreatedCatalogueSubject } from '../../features/catalogue/create-subject-actions';
import { readCreateTypeDescriptor, readCreateTypePage } from '../../features/catalogue/type-directory';
import { useSession } from '../../session/query';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';

export const Route = createFileRoute('/catalogue/new')({
  head: ({ match }) =>
    pageHead({ title: m.catalogue_create_title(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: candidateSession(NewSubjectPage),
});

function NewSubjectPage() {
  const editorWork = useCatalogueLifetime('transport');
  const { state, csrfToken } = useSession();
  return (
    <CreateSubjectForm
      locale={getLocale()}
      session={state}
      onNavigate={(href) => window.location.assign(href)}
      transport={{
        typeDirectory: {
          page: (input) => readCreateTypePage({ data: input }),
          descriptor: (typeId) => readCreateTypeDescriptor({ data: typeId }),
        },
        submit: (command) =>
          createCatalogueSubject({
            data: editorRequest(command, editorWork),
            headers: { 'X-CSRF-Token': csrfToken ?? '' },
          }),
        read: (id) => readCreatedCatalogueSubject({ data: id }),
      }}
    />
  );
}
