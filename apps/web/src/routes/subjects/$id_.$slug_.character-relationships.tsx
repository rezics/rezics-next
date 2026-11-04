import { createFileRoute, notFound } from '@tanstack/react-router';
import { useState } from 'react';
import { useRouter } from '@tanstack/react-router';
import { CharacterRelationshipsSession } from '../../features/catalogue/character-relationships/session';
import { characterRelationshipsVisit, type CharacterRelationshipsOrigin } from '../../features/catalogue/character-relationships/navigation';
import { validatePageRealm } from '../../features/pages/view-cursor';
import { getLocale } from '../../paraglide/runtime.js';
import { m } from '../../paraglide/messages.js';
import { candidateContext } from '../../subject/candidates';

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
  const router = useRouter({ warn: false });
  const locale = getLocale();
  const origin: CharacterRelationshipsOrigin = { id, locale, context: context ?? candidateContext, realm, stream, cursor, work };
  const [visit] = useState(() => characterRelationshipsVisit(router.history.location.state, origin));
  return (
    <CharacterRelationshipsSession
      key={`${id}:${locale}:${context ?? ''}:${realm ?? ''}:${work ?? ''}:${stream ?? ''}:${cursor ?? ''}`}
      id={id}
      locale={locale}
      context={context}
      realm={realm}
      origin={origin}
      visit={visit}
      {...(visit ? { work: visit.work ?? undefined, stream: visit.stream ?? undefined, cursor: visit.cursors[visit.index] ?? undefined } : {
        ...(work ? { work } : {}),
        ...(stream ? { stream } : {}),
        ...(cursor ? { cursor } : {}),
      })}
    />
  );
}
