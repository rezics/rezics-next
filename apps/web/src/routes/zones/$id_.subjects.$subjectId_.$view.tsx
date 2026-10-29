import { isView } from '@rezics/composition';
import { createFileRoute, notFound } from '@tanstack/react-router';
import { readZoneSubjectRoute, ZoneSubjectRoute, zoneSubjectHead } from '../../zones/zone-shell';

export const Route = createFileRoute('/zones/$id_/subjects/$subjectId_/$view')({
  loader: ({ params }) => {
    if (!isView(params.view) || params.view === 'overview') throw notFound();
    return readZoneSubjectRoute({ id: params.id, subjectId: params.subjectId, view: params.view });
  },
  head: ({ loaderData, params }) => zoneSubjectHead(loaderData, isView(params.view) ? params.view : 'overview'),
  component: ZoneViewRoute,
});

function ZoneViewRoute() {
  const { id, subjectId, view } = Route.useParams();
  const data = Route.useLoaderData();
  if (!isView(view) || view === 'overview') return null;
  return <ZoneSubjectRoute data={data} id={id} subjectId={subjectId} view={view} />;
}
