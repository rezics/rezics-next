import { createFileRoute, notFound } from '@tanstack/react-router';
import { MusicContextSession } from '../../features/catalogue/music-context-profile/session';
import { getLocale } from '../../paraglide/runtime.js';
import { m } from '../../paraglide/messages.js';

export const Route = createFileRoute('/subjects/$id_/$slug/music-context')({
  staticData: { publicCache: false },
  validateSearch: (search: Record<string, unknown>) => {
    const returnTo = search.returnTo;
    if (returnTo !== undefined && (typeof returnTo !== 'string' || returnTo.length > 2048 || !returnTo.startsWith('/')))
      throw notFound();
    return { returnTo: typeof returnTo === 'string' ? returnTo : undefined };
  },
  head: () => ({ meta: [{ title: m.music_context_title() }, { name: 'robots', content: 'noindex,follow' }] }),
  component: MusicContextRoute,
});

function MusicContextRoute() {
  const { id } = Route.useParams();
  const { returnTo } = Route.useSearch();
  return <MusicContextSession key={`${id}:${getLocale()}`} id={id} locale={getLocale()} returnTo={returnTo} />;
}
