import { createFileRoute, notFound } from '@tanstack/react-router';
import { MusicContextSession } from '../../features/catalogue/music-context-profile/session';
import {
  musicContextRouteSearch,
  type MusicContextAddress,
} from '../../features/catalogue/music-context-profile/navigation';
import { getLocale } from '../../paraglide/runtime.js';
import { m } from '../../paraglide/messages.js';

export const Route = createFileRoute('/subjects/$id_/$slug/music-context')({
  staticData: { publicCache: false },
  validateSearch: (search: Record<string, unknown>) => {
    const address = musicContextRouteSearch(search, getLocale());
    if (!address) throw notFound();
    return address;
  },
  head: () => ({ meta: [{ title: m.music_context_title() }, { name: 'robots', content: 'noindex,follow' }] }),
  component: MusicContextRoute,
});

function MusicContextRoute() {
  const { id } = Route.useParams();
  const { returnTo, stream, cursor } = Route.useSearch();
  const locale = getLocale();
  const navigate = Route.useNavigate();
  const onAddressChange = ({ stream: selected, cursor: nextCursor }: MusicContextAddress & { stream: string }) =>
    void navigate({
      search: (previous) => ({
        ...(previous.returnTo === undefined ? {} : { returnTo: previous.returnTo }),
        stream: selected,
        ...(nextCursor === undefined ? {} : { cursor: nextCursor }),
      }),
      replace: true,
    });
  return (
    <MusicContextSession
      key={JSON.stringify([id, locale, returnTo, stream])}
      id={id}
      locale={locale}
      returnTo={returnTo}
      stream={stream}
      cursor={cursor}
      onAddressChange={onAddressChange}
    />
  );
}
