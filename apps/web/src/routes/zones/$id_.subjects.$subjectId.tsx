import { createFileRoute } from '@tanstack/react-router';
import { getLocale } from '../../paraglide/runtime.js';
import { ZoneSubjectRoute, readZoneSubjectRoute, zoneSubjectHead } from '../../zones/zone-shell';

export const Route = createFileRoute('/zones/$id_/subjects/$subjectId')({
  staticData: { sessionReread: true },
  loader: ({ params, context }) =>
    readZoneSubjectRoute({
      id: params.id,
      subjectId: params.subjectId,
      locale: getLocale(),
      credentialMode: context.credentialMode,
    }),
  head: ({ loaderData }) => zoneSubjectHead(loaderData),
  component: ZoneSubjectOverviewRoute,
});

function ZoneSubjectOverviewRoute() {
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
      view="overview"
    />
  );
}
