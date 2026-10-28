import { createFileRoute } from '@tanstack/react-router';
import { useSuspenseQuery } from '@tanstack/react-query';
import { spaceQuery } from '../../community/space-queries';
import { getLocale } from '../../paraglide/runtime.js';
import { SpacePage } from '../../community/space-page';
import { m } from '../../paraglide/messages.js';
import { ClosedErrorPage } from '../../shell/closed';

export const Route = createFileRoute('/spaces/$address')({
  staticData: { sessionReread: true },
  loader: ({ params, context }) =>
    context.queryClient.ensureQueryData(spaceQuery(params.address, getLocale(), context.credentialMode)),
  head: ({ loaderData }) => ({ meta: [{ title: loaderData?.space.title ?? m.not_found_heading() }] }),
  errorComponent: ClosedErrorPage,
  component: SpaceRoute,
});

function SpaceRoute() {
  const { address } = Route.useParams();
  const { credentialMode } = Route.useRouteContext();
  const { data } = useSuspenseQuery(spaceQuery(address, getLocale(), credentialMode));
  return <SpacePage page={data} />;
}
