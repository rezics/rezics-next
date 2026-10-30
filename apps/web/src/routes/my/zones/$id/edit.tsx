import { createFileRoute } from '@tanstack/react-router';
import { ZoneEditorRoute } from '../../../../features/zones/editor/route';
import { readConfiguration } from '../../../../features/zones/editor/server';
import { EditorLoading } from '../../../../features/zones/editor/view';
import { m } from '../../../../paraglide/messages.js';
import { getLocale } from '../../../../paraglide/runtime.js';
import { requireSignedIn } from '../../../../session/guard';
import { pageHead } from '../../../../shell/head';
import { pageHeadContext } from '../../../../shell/head-context';

export const Route = createFileRoute('/my/zones/$id/edit')({
  beforeLoad: requireSignedIn,
  staticData: { sessionReread: true },
  loader: ({ params }) => readConfiguration({ data: { id: params.id, locale: getLocale() } }),
  head: ({ match }) =>
    pageHead({ title: m.zone_editor_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  pendingComponent: EditorLoading,
  component: ZoneConfigurationRoute,
});

function ZoneConfigurationRoute() {
  const { id } = Route.useParams();
  const locale = getLocale();
  return <ZoneEditorRoute key={`${id}:${locale}`} id={id} locale={locale} initial={Route.useLoaderData()} />;
}
