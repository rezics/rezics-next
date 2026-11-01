import { createFileRoute, useLocation } from '@tanstack/react-router';
import { loadZoneEditor, ZoneEditorRoute } from '../../../../features/zones/editor/route';
import { EditorLoading } from '../../../../features/zones/editor/view';
import { m } from '../../../../paraglide/messages.js';
import { getLocale } from '../../../../paraglide/runtime.js';
import { requireSignedIn } from '../../../../session/guard';
import { pageHead } from '../../../../shell/head';
import { pageHeadContext } from '../../../../shell/head-context';

export const Route = createFileRoute('/my/zones/$id/edit')({
  beforeLoad: requireSignedIn,
  staticData: { sessionReread: true },
  loaderDeps: ({ search }) => ({ search }),
  loader: ({ params, context, deps, abortController }) =>
    loadZoneEditor(params.id, getLocale(), context.queryClient, deps.search, abortController.signal),
  head: ({ match }) =>
    pageHead({ title: m.zone_editor_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  pendingComponent: EditorLoading,
  component: ZoneConfigurationRoute,
});

function ZoneConfigurationRoute() {
  const { id } = Route.useParams();
  const locale = getLocale();
  const location = useLocation();
  const { initial, requestedOwner, loadedFor } = Route.useLoaderData();
  const readMatchesRoute =
    loadedFor.id === id && loadedFor.locale === locale && loadedFor.search === JSON.stringify(location.search ?? {});
  return (
    <ZoneEditorRoute
      key={`${id}:${locale}`}
      id={id}
      locale={locale}
      initial={initial}
      requestedOwner={requestedOwner}
      readMatchesRoute={readMatchesRoute}
    />
  );
}
