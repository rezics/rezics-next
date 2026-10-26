import { createFileRoute } from '@tanstack/react-router';
import { ProgressIndexPage } from '../../library/progress-page';
import { readProgressIndex } from '../../library/progress-server';
import { m } from '../../paraglide/messages.js';

export const Route = createFileRoute('/library/progress/')({
  validateSearch: (search: Record<string, unknown>) => ({
    ...(typeof search.subjectId === 'string' && search.subjectId ? { subjectId: search.subjectId } : {}),
    ...(typeof search.cursor === 'string' && search.cursor ? { cursor: search.cursor } : {}),
  }),
  loaderDeps: ({ search }) => ({ subjectId: search.subjectId, cursor: search.cursor }),
  loader: ({ deps }) => readProgressIndex({ data: deps }),
  staleTime: 60_000,
  head: () => ({ meta: [{ title: m.library_progress_heading() }] }),
  component: function ProgressIndexRoute() {
    return <ProgressIndexPage page={Route.useLoaderData()} />;
  },
});
