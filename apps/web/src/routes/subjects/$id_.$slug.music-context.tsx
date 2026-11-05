import { createFileRoute, notFound, useLocation } from '@tanstack/react-router';
import { useRef } from 'react';
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
  const search = Route.useSearch();
  const locale = getLocale();
  const location = useLocation();
  const address = musicContextRouteSearch(search, locale, { subjectId: id, pathname: location.pathname });
  const identity = JSON.stringify([id, locale, address?.context ?? '', address?.realm ?? '']);
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const navigate = Route.useNavigate();
  if (!address) return <p role="alert">{m.music_context_invalid_address({}, { locale: locale as never })}</p>;
  const onAddressChange = ({
    context: selectedContext,
    stream: selected,
    cursor: nextCursor,
  }: MusicContextAddress & { stream: string }) => {
    if (identityRef.current !== identity || selectedContext !== address.context) return;
    return void navigate({
      search: (previous) => ({
        ...(previous.context === undefined ? {} : { context: previous.context }),
        ...(previous.realm === undefined ? {} : { realm: previous.realm }),
        ...(previous.returnTo === undefined ? {} : { returnTo: previous.returnTo }),
        ...(previous.via === undefined ? {} : { via: previous.via }),
        stream: selected,
        ...(nextCursor === undefined ? {} : { cursor: nextCursor }),
      }),
      replace: true,
    });
  };
  return (
    <MusicContextSession
      key={JSON.stringify([id, locale, address.context, address.realm, address.returnTo, address.via])}
      id={id}
      locale={locale}
      context={address.context}
      realm={address.realm}
      returnTo={address.returnTo}
      via={address.via}
      stream={address.stream}
      cursor={address.cursor}
      onAddressChange={onAddressChange}
    />
  );
}
