import { createFileRoute, useSearch } from '@tanstack/react-router';
import {
  editionContentId,
  type EditionCreateApi,
  type EditionPublicationController,
} from '../../content-editions/edition-create';
import { EditionPublicationPanel } from '../../content-editions/edition-create-view';
import { m } from '../../paraglide/messages.js';
import { requireSignedIn } from '../../session/guard';

export const Route = createFileRoute('/editions/new')({
  beforeLoad: requireSignedIn,
  staticData: { sessionReread: true },
  validateSearch: (search: Record<string, unknown>) => ({
    postId: typeof search.postId === 'string' && editionContentId.test(search.postId) ? search.postId : undefined,
    revisionId:
      typeof search.revisionId === 'string' && editionContentId.test(search.revisionId) ? search.revisionId : undefined,
  }),
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
  const { postId, revisionId } = useSearch({ from: '/editions/new' });
  return (
    <EditionPublicationPanel
      api={api}
      controller={controller}
      initialSource={postId && revisionId ? { postId, revisionId } : undefined}
    />
  );
}
