import { historyReturn } from '../../library/private-diary/address';
import { progressSessionAddress, progressAddressIssue } from '../../library/progress-address';
import { ProgressAddressCorrection } from '../../library/progress-address-correction';
import { requireSignedIn } from '../../session/guard';
import { prepareExposure } from '../../kernel/exposure';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { createFileRoute, useLocation } from '@tanstack/react-router';
import { CurrentProgressDetail } from '../../library/progress-session';
import { readProgressDetail } from '../../library/progress-detail-server';
import { progressReturnContextFromLocationState } from '../../library/progress-start-draft-navigation';
import { getLocale } from '../../paraglide/runtime.js';
import { m } from '../../paraglide/messages.js';

export const Route = createFileRoute('/library/progress/$id')({
  beforeLoad: async (args) => {
    await requireSignedIn(args);
    await prepareExposure(args.context.queryClient);
  },
  validateSearch: (search: Record<string, unknown>) => {
    const { id, ...positions } = progressSessionAddress(search);
    const history = historyReturn(search.history);
    return { ...positions, ...(history ? { history: search.history as string } : {}) };
  },
  // Same-session cursor navigation belongs to the mounted private reader. A fresh
  // match still prepares its loader; cursor movement must not duplicate that read.
  shouldReload: ({ cause }) => cause !== 'stay',
  loader: ({ params, location }) =>
    readProgressDetail({
      data: progressSessionAddress({ ...location.search, id: params.id }),
    }),
  staleTime: 0,
  head: ({ match }) =>
    pageHead({ title: m.library_progress_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: function ProgressSessionRoute() {
    const loaded = Route.useLoaderData();
    const { id } = Route.useParams();
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
    const pending = requestedId !== id;
    if (issue || pending)
      return <ProgressAddressCorrection address={address} issue={issue} pending={!issue && pending} />;
    if (loaded.state === 'invalid') return <ProgressAddressCorrection address={address} issue={loaded.issue} />;
    return (
      <CurrentProgressDetail
        loaded={loaded}
        address={address}
        returnContext={progressReturnContextFromLocationState(requested.state, id, getLocale())}
      />
    );
  },
});
