import { createFileRoute, redirect } from '@tanstack/react-router';
import { useSuspenseQuery } from '@tanstack/react-query';
import { realmPageQuery } from '../../community/space-queries';
import { SpacePage } from '../../community/space-page';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { ClosedErrorPage } from '../../shell/closed';

export const Route = createFileRoute('/realms/$id')({
  staticData: { sessionReread: true },
  loader: async ({ params, context }) => {
    const located = await context.queryClient.ensureQueryData(
      realmPageQuery(params.id, getLocale(), context.credentialMode),
    );
    if (located.kind === 'redirect')
      throw redirect({ href: `/${getLocale()}/spaces/${encodeURIComponent(located.address)}`, statusCode: 307 });
    return located.page;
  },
  head: ({ loaderData }) => ({ meta: [{ title: loaderData?.space.title ?? m.not_found_heading() }] }),
  errorComponent: ClosedErrorPage,
  component: RealmRoute,
});

function RealmRoute() {
  const { id } = Route.useParams();
  const { credentialMode } = Route.useRouteContext();
  const { data } = useSuspenseQuery(realmPageQuery(id, getLocale(), credentialMode));
  if (data.kind !== 'page') return null;
  return <SpacePage page={data.page} />;
}
