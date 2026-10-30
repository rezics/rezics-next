import { createFileRoute } from '@tanstack/react-router';
import { WorkPartsSession } from '../../features/catalogue/work-parts-session';
import { getLocale } from '../../paraglide/runtime.js';
import { m } from '../../paraglide/messages.js';

export const Route = createFileRoute('/subjects/$id_/$slug_/work-parts')({
  staticData: { publicCache: false },
  head: () => ({ meta: [{ title: m.work_parts_title() }, { name: 'robots', content: 'noindex,nofollow' }] }),
  component: WorkPartsRoute,
});
function WorkPartsRoute() {
  const { id } = Route.useParams();
  return <WorkPartsSession key={`${id}:${getLocale()}`} id={id} locale={getLocale()} />;
}
