import { createFileRoute } from '@tanstack/react-router';
import { AlbumProfileSession } from '../../features/catalogue/album-profile-session';
import { getLocale } from '../../paraglide/runtime';
import { m } from '../../paraglide/messages.js';

export const Route = createFileRoute('/catalogue/album')({
  staticData: { publicCache: false },
  head: () => ({ meta: [{ title: m.album_title() }, { name: 'robots', content: 'noindex, nofollow' }] }),
  component: () => <AlbumProfileSession locale={getLocale()} />,
});
