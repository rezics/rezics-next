import { useLoaderData, useSearch } from '@tanstack/react-router';
import {
  editionCreateNavigationContext,
  type EditionCreateApi,
  type EditionPublicationController,
} from './edition-create';
import { EditionPublicationPanel } from './edition-create-view';
import { AuthoringDepartureProvider } from '../threads/authoring-departure';
import { m } from '../paraglide/messages.js';

export function EditionCreateRoute({
  api,
  controller,
}: {
  api?: EditionCreateApi;
  controller?: EditionPublicationController;
}) {
  const { editionId, postId, revisionId, editionOrigin } = useSearch({ from: '/editions/new' });
  const resumed = useLoaderData({ from: '/editions/new' });
  return (
    <AuthoringDepartureProvider
      navigationContext={editionCreateNavigationContext}
      navigationMessages={{
        title: m.edition_publication_leave_title(),
        unsaved: m.edition_publication_leave_unsaved(),
        pending: m.edition_publication_leave_pending(),
      }}
      sessionBound
    >
      <EditionPublicationPanel
        key={JSON.stringify([editionId ?? `${postId}:${revisionId}`, editionOrigin])}
        initialEditionId={editionId}
        initialResume={resumed}
        initialOriginToken={editionOrigin}
        api={api}
        controller={controller}
        initialSource={postId && revisionId ? { postId, revisionId } : undefined}
      />
    </AuthoringDepartureProvider>
  );
}
