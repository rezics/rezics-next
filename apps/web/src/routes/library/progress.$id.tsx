import { createFileRoute } from '@tanstack/react-router';
import { ProgressSessionPage } from '../../library/progress-session';
import { readProgressSession } from '../../library/progress-server';
import { m } from '../../paraglide/messages.js';

export const Route = createFileRoute('/library/progress/$id')({
  validateSearch: (search: Record<string, unknown>) => ({
    ...(typeof search.changes === 'string' && search.changes ? { changes: search.changes } : {}),
    ...(typeof search.units === 'string' && search.units ? { units: search.units } : {}),
  }),
  loaderDeps: ({ search }) => ({ changes: search.changes, units: search.units }),
  loader: ({ params, deps }) => readProgressSession({ data: { id: params.id, ...deps } }),
  staleTime: 60_000,
  head: () => ({ meta: [{ title: m.library_progress_heading() }] }),
  component: function ProgressSessionRoute() {
    return <ProgressSessionPage page={Route.useLoaderData()} />;
  },
});
