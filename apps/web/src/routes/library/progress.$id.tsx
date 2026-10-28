import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { createFileRoute } from '@tanstack/react-router';
import { progressSubjects } from '../../library/progress-subjects';
import { ProgressSessionPage } from '../../library/progress-session';
import { ProgressLogs } from '../../library/logs-progress';
import { readMyPublishedLogs } from '../../library/logs-server';
import { readProgressSession } from '../../library/progress-server';
import { m } from '../../paraglide/messages.js';

export const Route = createFileRoute('/library/progress/$id')({
  beforeLoad: requireSignedIn,
  validateSearch: (search: Record<string, unknown>) => ({
    ...(typeof search.changes === 'string' && search.changes ? { changes: search.changes } : {}),
    ...(typeof search.units === 'string' && search.units ? { units: search.units } : {}),
    ...(typeof search.logs === 'string' && search.logs ? { logs: search.logs } : {}),
  }),
  loaderDeps: ({ search }) => ({ changes: search.changes, units: search.units, logs: search.logs }),
  loader: async ({ params, deps }) => {
    const [progress, logs] = await Promise.all([
      readProgressSession({
        data: {
          id: params.id,
          ...(deps.changes ? { changes: deps.changes } : {}),
          ...(deps.units ? { units: deps.units } : {}),
        },
      }),
      readMyPublishedLogs({ data: deps.logs ? { cursor: deps.logs } : {} }),
    ]);
    return {
      progress,
      logs,
      search: {
        ...(deps.changes ? { changes: deps.changes } : {}),
        ...(deps.units ? { units: deps.units } : {}),
        ...(deps.logs ? { logs: deps.logs } : {}),
      },
    };
  },
  staleTime: 60_000,
  head: ({ match }) =>
    pageHead({ title: m.library_progress_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: function ProgressSessionRoute() {
    const loaded = Route.useLoaderData();
    const page = { ...loaded, ...progressSubjects(loaded.progress, loaded.logs) };
    return (
      <ProgressSessionPage page={page.progress}>
        <ProgressLogs progress={page.progress} logs={page.logs} search={page.search} />
      </ProgressSessionPage>
    );
  },
});
