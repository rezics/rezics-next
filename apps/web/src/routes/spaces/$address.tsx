import { useSession } from '../../session/query';
import { personalRead } from '../../kernel/query';
import { readPersonalSpacePage } from '../../community/space-actions';
import { createFileRoute } from '@tanstack/react-router';
import { useQuery, useSuspenseQuery } from '@tanstack/react-query';
import { spaceQuery } from '../../community/space-queries';
import { getLocale } from '../../paraglide/runtime.js';
import { SpacePage } from '../../community/space-page';
import { m } from '../../paraglide/messages.js';
import { ClosedErrorPage } from '../../shell/closed';

export const Route = createFileRoute('/spaces/$address')({
  loader: ({ params, context }) => context.queryClient.ensureQueryData(spaceQuery(params.address, getLocale())),
  head: ({ loaderData }) => ({ meta: [{ title: loaderData?.space.title ?? m.not_found_heading() }] }),
  errorComponent: ClosedErrorPage,
  component: SpaceRoute,
});

function SpaceRoute() {
  const { address } = Route.useParams();
  const { data } = useSuspenseQuery(spaceQuery(address, getLocale()));
  const { state } = useSession();
  const { data: personal } = useQuery({
    ...personalRead,
    queryKey: ['personal-space', address, getLocale()],
    queryFn: () => readPersonalSpacePage({ data: { address } }),
    enabled: personalRead.enabled && state === 'signed-in',
    staleTime: Infinity,
  });
  return <SpacePage page={personal ?? data} />;
}
