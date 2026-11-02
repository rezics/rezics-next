import { createFileRoute, useLoaderData, useSearch } from '@tanstack/react-router';
import {
  editionContentId,
  editionCreateNavigationContext,
  editionCreateSearch,
  type EditionCreateApi,
  type EditionPublicationController,
} from '../../content-editions/edition-create';
import { readEditionResume } from '../../content-editions/edition-create-actions';
import { EditionPublicationPanel } from '../../content-editions/edition-create-view';
import { AuthoringDepartureProvider } from '../../threads/authoring-departure';
import { m } from '../../paraglide/messages.js';
import { requireSignedIn } from '../../session/guard';

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

export function EditionCreateRoute({
  api,
  controller,
}: {
  api?: EditionCreateApi;
  controller?: EditionPublicationController;
}) {
  const { editionId, postId, revisionId } = useSearch({ from: '/editions/new' });
  const resumed = useLoaderData({ from: '/editions/new' });
  return (
    <AuthoringDepartureProvider
      navigationContext={editionCreateNavigationContext}
      navigationMessages={{
        title: m.edition_publication_leave_title(),
        unsaved: m.edition_publication_leave_unsaved(),
        pending: m.edition_publication_leave_pending(),
      }}
      sessionBound="subject"
    >
      <EditionPublicationPanel
        key={editionId ?? `${postId}:${revisionId}`}
        initialEditionId={editionId}
        initialResume={resumed}
        api={api}
        controller={controller}
        initialSource={postId && revisionId ? { postId, revisionId } : undefined}
      />
    </AuthoringDepartureProvider>
  );
}
