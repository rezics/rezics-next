import { createFileRoute } from '@tanstack/react-router';
import { readZoneSubjectRoute, ZoneSubjectRoute, zoneSubjectHead } from '../../zones/zone-shell';

export const Route = createFileRoute('/zones/$id_/subjects/$subjectId')({
  loader: ({ params }) => readZoneSubjectRoute({ id: params.id, subjectId: params.subjectId }),
  head: ({ loaderData }) => zoneSubjectHead(loaderData),
  component: ZoneOverviewRoute,
});

function ZoneOverviewRoute() {
  const { id, subjectId } = Route.useParams();
  const data = Route.useLoaderData();
  return <ZoneSubjectRoute data={data} id={id} subjectId={subjectId} />;
}
