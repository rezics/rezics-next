import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { createFileRoute } from '@tanstack/react-router';
import { MyRealmsPageView } from '../../community/my-realms-page';
import { myRealmsQuery } from '../../community/realm-membership-queries';
import { useQuery } from '@tanstack/react-query';
import { m } from '../../paraglide/messages.js';
import { ClosedErrorPage } from '../../shell/closed';

export const Route = createFileRoute('/realms/')({
  beforeLoad: requireSignedIn,
  validateSearch: (search: Record<string, unknown>) =>
    typeof search.cursor === 'string' && search.cursor ? { cursor: search.cursor } : {},
  loaderDeps: ({ search }) => ({ cursor: search.cursor }),
  loader: ({ context, deps }) => context.queryClient.fetchQuery(myRealmsQuery(deps.cursor)),
  head: ({ match }) =>
    pageHead({ title: m.realms_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  errorComponent: ClosedErrorPage,
  component: MyRealms,
});

function MyRealms() {
  const initial = Route.useLoaderData();
  const { data = initial, isError, error } = useQuery(myRealmsQuery(Route.useSearch().cursor));
  if (isError) throw error;
  if (!data) throw new Error('Realm list is unavailable');
  return <MyRealmsPageView page={data} />;
}
