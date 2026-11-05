import { isView } from '@rezics/composition';
import { createFileRoute, notFound } from '@tanstack/react-router';
import { getLocale } from '../../paraglide/runtime.js';
import { ZoneSubjectRoute, readZoneSubjectRoute, zoneSubjectHead } from '../../zones/zone-shell';

export const Route = createFileRoute('/zones/$id_/subjects/$subjectId_/$view')({
  staticData: { sessionReread: true },
  loader: ({ params, context }) => {
    if (!isView(params.view) || params.view === 'overview') throw notFound();
    return readZoneSubjectRoute({
      id: params.id,
      subjectId: params.subjectId,
      locale: getLocale(),
      credentialMode: context.credentialMode,
      view: params.view,
    });
  },
  head: ({ loaderData }) => zoneSubjectHead(loaderData, loaderData?.view),
  component: ZoneSubjectViewRoute,
});

function ZoneSubjectViewRoute() {
  const { id, subjectId } = Route.useParams();
  const data = Route.useLoaderData();
  const { credentialMode } = Route.useRouteContext();
  return (
    <ZoneSubjectRoute
      data={data}
      id={id}
      subjectId={subjectId}
      locale={getLocale()}
      credentialMode={credentialMode}
      view={data.view}
    />
  );
}
