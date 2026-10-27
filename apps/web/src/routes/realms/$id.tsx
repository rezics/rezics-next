import { createFileRoute, redirect } from '@tanstack/react-router';
import { locateRealmPage } from '../../community/space-actions';
import { SpacePage } from '../../community/space-page';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { ClosedErrorPage } from '../../shell/closed';

export const Route = createFileRoute('/realms/$id')({
  loader: async ({ params }) => {
    const located = await locateRealmPage({ data: { realmId: params.id } });
    if (located.kind === 'redirect')
      throw redirect({ href: `/${getLocale()}/spaces/${encodeURIComponent(located.address)}`, statusCode: 307 });
    return located.page;
  },
  head: ({ loaderData }) => ({ meta: [{ title: loaderData?.space.title ?? m.not_found_heading() }] }),
  errorComponent: ClosedErrorPage,
  component: RealmRoute,
});

function RealmRoute() {
  return <SpacePage page={Route.useLoaderData()} />;
}
