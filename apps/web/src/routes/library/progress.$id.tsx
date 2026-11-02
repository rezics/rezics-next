import { progressSessionAddress, progressAddressIssue } from '../../library/progress-address';
import { ProgressAddressCorrection } from '../../library/progress-address-correction';
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
  validateSearch: (search: Record<string, unknown>) => {
    const { id, ...positions } = progressSessionAddress(search);
    return positions;
  },
  loaderDeps: ({ search }) => ({ changes: search.changes, units: search.units, logs: search.logs }),
  loader: ({ params, deps }) =>
    readProgressDetail({
      data: {
        id: params.id,
        ...deps,
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
    const address = progressSessionAddress({ ...requested.search, id: requestedId });
    const issue = progressAddressIssue(address);
    const pending = requestedId !== id || (['changes', 'units', 'logs'] as const).some((key) => address[key] !== search[key]);
    if (issue || pending) return <ProgressAddressCorrection address={address} issue={issue} pending={!issue && pending} />;
    if (loaded.state === 'invalid') return <ProgressAddressCorrection address={address} issue={loaded.issue} />;
    return <CurrentProgressDetail loaded={loaded} address={{ id, ...search }} />;
  },
});
