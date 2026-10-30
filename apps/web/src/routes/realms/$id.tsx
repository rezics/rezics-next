import { createFileRoute, redirect } from '@tanstack/react-router';
import { realmPageQuery } from '../../community/space-queries';
import { SpacePage } from '../../community/space-page';
import { getLocale } from '../../paraglide/runtime.js';
import { ClosedErrorPage } from '../../shell/closed';
import { spacePageHead } from '../../community/space-head';

export const Route = createFileRoute('/realms/$id')({
  staticData: { publicCache: true },
  loader: async ({ params, context }) => {
    const located = await context.queryClient.ensureQueryData(
      realmPageQuery(params.id, getLocale(), context.credentialMode),
    );
    if (located.kind === 'redirect')
      throw redirect({ href: `/${getLocale()}/spaces/${encodeURIComponent(located.address)}`, statusCode: 307 });
    return located.page;
  },
  head: ({ loaderData, params }) => spacePageHead(loaderData, getLocale(), `/realms/${encodeURIComponent(params.id)}`),
  errorComponent: ClosedErrorPage,
  component: RealmRoute,
});

function RealmRoute() {
  const page = Route.useLoaderData();
  return <SpacePage page={page} />;
}
