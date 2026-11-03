import { createFileRoute, notFound } from '@tanstack/react-router';
import { WorkPartsSession } from '../../features/catalogue/work-parts-session';
import { screenSeriesId } from '../../features/catalogue/screen-episode-membership';
import { validatePageRealm } from '../../features/pages/view-cursor';
import { getLocale } from '../../paraglide/runtime.js';
import { m } from '../../paraglide/messages.js';

export const Route = createFileRoute('/subjects/$id_/$slug_/work-parts')({
  staticData: { publicCache: false },
  validateSearch: (search: Record<string, unknown>) => {
    const context = search.context;
    if (
      context !== undefined &&
      (typeof context !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(context))
    )
      throw notFound();
    return { context, realm: validatePageRealm(search.realm), child: screenSeriesId(search.child) };
  },
  head: () => ({ meta: [{ title: m.work_parts_title() }, { name: 'robots', content: 'noindex,nofollow' }] }),
  component: WorkPartsRoute,
});
function WorkPartsRoute() {
  const { id } = Route.useParams();
  const { context, realm, child } = Route.useSearch();
  return (
    <WorkPartsSession
      key={`${id}:${getLocale()}:${context ?? ''}:${realm ?? ''}:${child ?? ''}`}
      id={id}
      locale={getLocale()}
      context={context}
      realm={realm}
      child={child}
    />
  );
}
