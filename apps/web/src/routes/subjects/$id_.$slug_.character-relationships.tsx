import { createFileRoute, notFound } from '@tanstack/react-router';
import { CharacterRelationshipsSession } from '../../features/catalogue/character-relationships/session';
import { validatePageRealm } from '../../features/pages/view-cursor';
import { getLocale } from '../../paraglide/runtime.js';
import { m } from '../../paraglide/messages.js';

export const Route = createFileRoute('/subjects/$id_/$slug_/character-relationships')({
  staticData: { publicCache: false },
  validateSearch: (search: Record<string, unknown>) => {
    const context = search.context;
    if (
      context !== undefined &&
      (typeof context !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(context))
    )
      throw notFound();
    const stream = typeof search.stream === 'string' ? search.stream : undefined;
    const cursor = typeof search.cursor === 'string' ? search.cursor : undefined;
    const work = typeof search.work === 'string' ? search.work : undefined;
    if (stream !== undefined && stream.length > 256) throw notFound();
    if (cursor !== undefined && (cursor.length > 8192 || !stream)) throw notFound();
    if (work !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(work))
      throw notFound();
    return { context, realm: validatePageRealm(search.realm), stream, cursor, work };
  },
  head: () => ({
    meta: [{ title: m.character_relationships_title() }, { name: 'robots', content: 'noindex,nofollow' }],
  }),
  component: CharacterRelationshipsRoute,
});
function CharacterRelationshipsRoute() {
  const { id } = Route.useParams();
  const { context, realm, work, stream, cursor } = Route.useSearch();
  return (
    <CharacterRelationshipsSession
      key={`${id}:${getLocale()}:${context ?? ''}:${realm ?? ''}:${work ?? ''}:${stream ?? ''}:${cursor ?? ''}`}
      id={id}
      locale={getLocale()}
      context={context}
      realm={realm}
      {...(work ? { work } : {})}
      {...(stream ? { stream } : {})}
      {...(cursor ? { cursor } : {})}
    />
  );
}
