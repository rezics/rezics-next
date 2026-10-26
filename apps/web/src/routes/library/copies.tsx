import { createFileRoute } from '@tanstack/react-router';
import { CopiesPage } from '../../library/copies-page';
import { readCopiesPage } from '../../library/copies-actions';
import { m } from '../../paraglide/messages.js';

export const Route = createFileRoute('/library/copies')({
  validateSearch: (search: Record<string, unknown>) => ({
    ...(typeof search.subjectId === 'string' && search.subjectId.length > 0 && search.subjectId.length <= 128
      ? { subjectId: search.subjectId }
      : {}),
    ...(typeof search.cursor === 'string' && search.cursor.length > 0 && search.cursor.length <= 2048
      ? { cursor: search.cursor }
      : {}),
  }),
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => readCopiesPage({ data: deps }),
  head: () => ({ meta: [{ title: m.library_copy_heading() }] }),
  component: CopiesRoute,
});

function CopiesRoute() {
  return <CopiesPage page={Route.useLoaderData()} />;
}
