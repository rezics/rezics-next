import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { personalRead } from '../../kernel/query';
import { useSession } from '../../session/query';
import { spaceQuery } from '../../community/space-queries';
import { getLocale } from '../../paraglide/runtime.js';
import { SpacePage } from '../../community/space-page';
import { ClosedErrorPage } from '../../shell/closed';
import { spacePageHead } from '../../community/space-head';

export const Route = createFileRoute('/spaces/$address')({
  staticData: { publicCache: true },
  loader: ({ params, context }) =>
    context.queryClient.ensureQueryData(spaceQuery(params.address, getLocale(), 'anonymous')),
  head: ({ loaderData, params }) =>
    spacePageHead(loaderData, getLocale(), `/spaces/${encodeURIComponent(params.address)}`),
  errorComponent: ClosedErrorPage,
  component: SpaceRoute,
});

function SpaceRoute() {
  const { address } = Route.useParams();
  const { state: session } = useSession();
  const publicPage = Route.useLoaderData();
  const sessionPage = useQuery({
    ...spaceQuery(address, getLocale(), 'session'),
    enabled: personalRead.enabled && session === 'signed-in' && publicPage.realm === null,
    retry: false,
  });
  const page = sessionPage.isSuccess && !sessionPage.isFetching && !sessionPage.isError ? sessionPage.data : publicPage;
  return <SpacePage page={page} />;
}
