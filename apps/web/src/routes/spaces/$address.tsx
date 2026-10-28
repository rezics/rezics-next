import { createFileRoute } from '@tanstack/react-router';
import { useSuspenseQuery } from '@tanstack/react-query';
import { spaceQuery } from '../../community/space-queries';
import { getLocale } from '../../paraglide/runtime.js';
import { SpacePage } from '../../community/space-page';
import { ClosedErrorPage } from '../../shell/closed';
import { spacePageHead } from '../../community/space-head';

export const Route = createFileRoute('/spaces/$address')({
  loader: ({ params, context }) =>
    context.queryClient.ensureQueryData(spaceQuery(params.address, getLocale(), 'anonymous')),
  head: ({ loaderData, params }) =>
    spacePageHead(loaderData, getLocale(), `/spaces/${encodeURIComponent(params.address)}`),
  errorComponent: ClosedErrorPage,
  component: SpaceRoute,
});

function SpaceRoute() {
  const { address } = Route.useParams();
  const { data } = useSuspenseQuery(spaceQuery(address, getLocale(), 'anonymous'));
  return <SpacePage page={data} />;
}
