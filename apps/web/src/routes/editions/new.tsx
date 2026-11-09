import { createFileRoute } from '@tanstack/react-router';
import { editionContentId, editionCreateSearch } from '../../content-editions/edition-create';
import { readEditionResume } from '../../content-editions/edition-create-actions';
import { m } from '../../paraglide/messages.js';
import { requireSignedIn } from '../../session/guard';
import { EditionCreateRoute } from '../../content-editions/edition-create-route';

export const Route = createFileRoute('/editions/new')({
  beforeLoad: requireSignedIn,
  staticData: { sessionReread: true },
  validateSearch: editionCreateSearch,
  loaderDeps: ({ search }) => ({ editionId: search.editionId }),
  loader: ({ deps }) =>
    deps.editionId === undefined
      ? undefined
      : editionContentId.test(deps.editionId)
        ? readEditionResume({ data: { editionId: deps.editionId } })
        : { kind: 'missing' as const, status: 400 },
  staleTime: 0,
  gcTime: 0,
  shouldReload: true,
  head: () => ({ meta: [{ title: m.edition_publication_heading() }, { name: 'robots', content: 'noindex, follow' }] }),
  component: EditionCreateRoute,
});
