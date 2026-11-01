import { requireSignedIn } from '../../session/guard';
import { prepareExposure } from '../../kernel/exposure';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { createFileRoute, useLocation } from '@tanstack/react-router';
import { CurrentProgressDetail } from '../../library/progress-session';
import { readProgressDetail } from '../../library/progress-detail-server';
import { m } from '../../paraglide/messages.js';

export const Route = createFileRoute('/library/progress/$id')({
  beforeLoad: async (args) => {
    await requireSignedIn(args);
    await prepareExposure(args.context.queryClient);
  },
  validateSearch: (search: Record<string, unknown>) => ({
    ...(typeof search.changes === 'string' && search.changes ? { changes: search.changes } : {}),
    ...(typeof search.units === 'string' && search.units ? { units: search.units } : {}),
    ...(typeof search.logs === 'string' && search.logs ? { logs: search.logs } : {}),
  }),
  loaderDeps: ({ search }) => ({ changes: search.changes, units: search.units, logs: search.logs }),
  loader: ({ params, deps }) =>
    readProgressDetail({
      data: {
        id: params.id,
        ...(deps.changes ? { changes: deps.changes } : {}),
        ...(deps.units ? { units: deps.units } : {}),
        ...(deps.logs ? { logs: deps.logs } : {}),
      },
    }),
  staleTime: 0,
  head: ({ match }) =>
    pageHead({ title: m.library_progress_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: function ProgressSessionRoute() {
    const loaded = Route.useLoaderData();
    const { id } = Route.useParams();
    const search = Route.useSearch();
    const requested = useLocation();
    // A retained match can outlive the requested address while its next loader is pending.
    const segment = requested.pathname.match(/\/library\/progress\/([^/]+)\/?$/)?.[1];
    let requestedId: string | undefined;
    try {
      requestedId = segment === undefined ? undefined : decodeURIComponent(segment);
    } catch {
      /* Invalid route is pending. */
    }
    if (
      requestedId !== id ||
      (['changes', 'units', 'logs'] as const).some((key) => {
        const value = requested.search[key];
        return (typeof value === 'string' && value ? value : undefined) !== search[key];
      })
    )
      return null;
    return <CurrentProgressDetail loaded={loaded} address={{ id, ...search }} />;
  },
});
